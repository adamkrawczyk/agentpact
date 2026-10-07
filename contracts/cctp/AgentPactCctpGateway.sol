// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "../AgentPactEscrowV3.sol";
import "./CctpMessageV2.sol";
import "./interfaces/IMessageTransmitterV2.sol";
import "./interfaces/ITokenMessengerV2.sol";

/// @dev ERC-1271 (contract-wallet signatures). Declared locally because the
///      OpenZeppelin 5.6 interface file requires solc ^0.8.24.
interface IERC1271Minimal {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4);
}

/**
 * @title AgentPactCctpGateway
 * @notice Cross-chain funding and payouts for AgentPactEscrowV3 on Base using
 *         Circle CCTP v2 native USDC burn/mint. No own token, no swap, no
 *         wrapped asset, no custodial hop.
 *
 *         Pay-in: a buyer on another chain burns USDC with
 *         `depositForBurnWithHook(mintRecipient = this gateway,
 *         destinationCaller = this gateway, hookData = HookDataV1)`. Anyone
 *         (the AgentPact relayer in practice) calls `relayDeposit` with the
 *         attested message; the mint lands here and, in the same transaction,
 *         is locked into a Class-A escrow intent bound to the hookData — or, if
 *         the hookData is not a valid deposit, burned straight back to the
 *         buyer's chain.
 *
 *         Refund: after expiry anyone calls `refund`; the escrow returns the
 *         funds to the gateway (buyer of record) and the gateway burns them
 *         back to `(sourceDomain, refundRecipient)` in the same transaction.
 *
 *         Payout: for intents whose `sellerTarget` is the gateway,
 *         `claimAndForward` claims the seller share and burns exactly the
 *         received amount to the intent's payout route.
 *
 * @dev    Custody invariants:
 *         G1. The gateway never holds USDC between transactions: every inflow
 *             (mint, escrow refund, escrow payout) leaves in the same call
 *             (escrow lock or CCTP burn). The only exceptions are (a) a
 *             rejected deposit whose refund burn itself reverted, parked in
 *             `pendingRejectRefunds` and re-sendable by anyone, and (b) value
 *             a third party pushed in outside the gateway's own entry points
 *             (e.g. calling the escrow directly); (b) is re-sent by the next
 *             `refund` / `claimAndForward` for that intent.
 *         G2. No owner, no admin withdraw, no upgrade. The optional `pauser`
 *             can only stop NEW deposits; refunds, payouts and re-sends keep
 *             working while paused.
 *         G3. Checks before `receiveMessage` revert (the message stays
 *             receivable). After the mint, business-invalid deposits never
 *             revert — a destinationCaller-locked message that reverts can
 *             never be received again — they are refunded instead.
 *         G4. Caller-chosen CCTP fee parameters are bounded by caps fixed at
 *             construction, so a relayer cannot spend user funds as fees.
 *
 *         CCTP references:
 *         - Message formats: https://developers.circle.com/cctp/references/technical-guide
 *         - Contracts: https://github.com/circlefin/evm-cctp-contracts (src/v2, src/messages/v2)
 *         - Forwarding Service: https://developers.circle.com/cctp/concepts/forwarding-service
 *         - Finality: https://developers.circle.com/cctp/concepts/finality-and-block-confirmations
 */
contract AgentPactCctpGateway is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice CCTP domain id of Base (mainnet and Sepolia).
    uint32 public constant BASE_DOMAIN = 6;
    /// @notice MessageV2 header version and BurnMessageV2 body version accepted.
    uint32 public constant MESSAGE_VERSION = 1;
    uint32 public constant BURN_MESSAGE_VERSION = 1;
    /// @notice The only hookData layout this gateway understands.
    uint256 public constant HOOK_VERSION_1 = 1;

    /// @notice CCTP v2 finality thresholds (src/v2/FinalityThresholds.sol).
    ///         1000 = Fast (confirmed), 2000 = Standard (finalized).
    uint32 public constant FINALITY_THRESHOLD_CONFIRMED = 1000;
    uint32 public constant FINALITY_THRESHOLD_FINALIZED = 2000;

    /// @notice Hard ceilings on the construction-time fee caps.
    uint256 public constant FEE_CAP_BPS_LIMIT = 100; // 1%
    uint256 public constant FEE_CAP_FLAT_LIMIT = 1_000_000; // 1 USDC

    /// @notice Forwarding Service hook, version 0, no extra data: "cctp-forward"
    ///         as bytes24, uint32 version 0, uint32 length 0. With this hook
    ///         and destinationCaller = 0, Circle submits the destination mint
    ///         itself, paying the forwarding fee out of `maxFee`.
    ///         https://developers.circle.com/cctp/concepts/forwarding-service
    bytes public constant FORWARD_HOOK_DATA = hex"636374702d666f72776172640000000000000000000000000000000000000000";

    bytes32 public constant SET_PAYOUT_ROUTE_TYPEHASH =
        keccak256("SetPayoutRoute(bytes32 intentId,uint32 domain,bytes32 recipient,uint256 deadline)");
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("AgentPactCctpGateway");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes4 private constant _ERC1271_MAGIC = 0x1626ba7e;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    IERC20 public immutable usdc;
    IMessageTransmitterV2 public immutable messageTransmitter;
    ITokenMessengerV2 public immutable tokenMessenger;
    AgentPactEscrowV3 public immutable escrow;
    uint32 public immutable localDomain;
    /// @notice May pause/unpause NEW deposits only. address(0) = never pausable.
    address public immutable pauser;
    /// @notice maxFee <= max(amount * feeCapBps / 10_000, feeCapFlat), always < amount.
    uint256 public immutable feeCapBps;
    uint256 public immutable feeCapFlat;

    // ------------------------------------------------------------------
    // Types + storage
    // ------------------------------------------------------------------

    /// @notice hookData v1 = abi.encode(uint8 version=1, bytes32 dealRef,
    ///         address verifier, bytes params, address sellerTarget,
    ///         uint64 expiresAt, uint256 price, bytes32 refundRecipient,
    ///         uint32 payoutDomain, bytes32 payoutRecipient)
    struct HookDataV1 {
        bytes32 dealRef;
        address verifier;
        bytes params;
        address sellerTarget;
        uint64 expiresAt;
        uint256 price;
        bytes32 refundRecipient;
        uint32 payoutDomain;
        bytes32 payoutRecipient;
    }

    struct Deposit {
        bytes32 dealRef;
        uint32 sourceDomain;
        bytes32 refundRecipient;
        uint32 payoutDomain;
        bytes32 payoutRecipient;
        bool bound;
        bool refunded;
    }

    struct PayoutRoute {
        uint32 domain;
        bytes32 recipient;
    }

    struct PendingRefund {
        uint32 domain;
        bytes32 recipient;
        uint256 amount;
    }

    enum RejectReason {
        None,
        MalformedHookData, // 1
        UnknownHookVersion, // 2
        Expired, // 3
        VerifierNotApproved, // 4
        Underfunded, // 5: price == 0 or net received < price
        InvalidPayoutRoute, // 6
        ZeroDealRef, // 7
        DuplicateIntent // 8
    }

    bool public paused;
    mapping(bytes32 => Deposit) public deposits;
    mapping(bytes32 => PayoutRoute) public payoutRoutes;
    mapping(bytes32 => bool) public payoutSent;
    /// @notice Rejected deposits whose refund burn reverted, keyed by message hash.
    mapping(bytes32 => PendingRefund) public pendingRejectRefunds;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event CctpDepositBound(
        bytes32 indexed intentId,
        bytes32 indexed dealRef,
        uint32 sourceDomain,
        bytes32 messageSender,
        bytes32 refundRecipient,
        uint256 amount,
        uint256 feeExecuted,
        bytes32 nonce
    );
    event CctpDepositRejected(bytes32 indexed messageHash, uint8 reason);
    event CctpRejectRefundSent(
        bytes32 indexed messageHash, uint32 destinationDomain, bytes32 recipient, uint256 amount, uint256 maxFee
    );
    event CctpRejectRefundPending(bytes32 indexed messageHash, uint32 destinationDomain, bytes32 recipient, uint256 amount);
    event CctpRefundSent(
        bytes32 indexed intentId, uint32 destinationDomain, bytes32 recipient, uint256 amount, uint256 maxFee
    );
    event CctpPayoutSent(bytes32 indexed intentId, uint32 domain, bytes32 recipient, uint256 amount, uint256 maxFee);
    event PayoutRouteSet(bytes32 indexed intentId, uint32 domain, bytes32 recipient, address indexed authorizer);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroAddress();
    error MalformedHookData();
    error WrongLocalDomain(uint32 domain);
    error MismatchedCctpContracts();
    error MismatchedUsdc();
    error FeeCapTooHigh();
    error DepositsPaused();
    error NotPauser();
    error UnsupportedMessageVersion(uint32 version);
    error UnsupportedBurnMessageVersion(uint32 version);
    error WrongDestinationDomain(uint32 domain);
    error NotABurnMessage(bytes32 recipient);
    error MintRecipientNotGateway(bytes32 mintRecipient);
    error BurnTokenNotUsdc(bytes32 burnToken);
    error ReceiveFailed();
    error IntentIdMismatch();
    error UnknownDeposit();
    error AlreadyRefunded();
    error NotRefundable();
    error NoPayoutRoute();
    error AlreadyPaidOut();
    error NotClaimable();
    error PayoutRouteAlreadySet();
    error InvalidRoute();
    error NotIntentBuyer();
    error NotGatewayPayout();
    error SignatureExpired();
    error MaxFeeTooHigh(uint256 maxFee, uint256 cap);
    error BadFinalityThreshold(uint32 threshold);
    error NothingPending();
    error BurnAmountMismatch();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        address _usdc,
        address _messageTransmitter,
        address _tokenMessenger,
        address _escrow,
        address _pauser,
        uint256 _feeCapBps,
        uint256 _feeCapFlat
    ) {
        if (_usdc == address(0) || _messageTransmitter == address(0) || _tokenMessenger == address(0)
            || _escrow == address(0)) revert ZeroAddress();
        if (_feeCapBps > FEE_CAP_BPS_LIMIT || _feeCapFlat > FEE_CAP_FLAT_LIMIT) revert FeeCapTooHigh();

        uint32 domain = IMessageTransmitterV2(_messageTransmitter).localDomain();
        if (domain != BASE_DOMAIN) revert WrongLocalDomain(domain);
        if (ITokenMessengerV2(_tokenMessenger).localMessageTransmitter() != _messageTransmitter) {
            revert MismatchedCctpContracts();
        }
        if (address(AgentPactEscrowV3(_escrow).usdc()) != _usdc) revert MismatchedUsdc();

        usdc = IERC20(_usdc);
        messageTransmitter = IMessageTransmitterV2(_messageTransmitter);
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
        escrow = AgentPactEscrowV3(_escrow);
        localDomain = domain;
        pauser = _pauser;
        feeCapBps = _feeCapBps;
        feeCapFlat = _feeCapFlat;
    }

    // ------------------------------------------------------------------
    // Pay-in
    // ------------------------------------------------------------------

    /**
     * @notice Receive an attested CCTP v2 burn message minting to this gateway
     *         and bind it to a Class-A escrow intent. Anyone may call.
     * @return intentId The bound intent, or bytes32(0) if the deposit was
     *         rejected and refunded (see `CctpDepositRejected`).
     */
    function relayDeposit(bytes calldata message, bytes calldata attestation)
        external
        nonReentrant
        returns (bytes32 intentId)
    {
        // ---- Pre-mint checks: a revert here leaves the message receivable. ----
        if (paused) revert DepositsPaused();
        CctpMessageV2.BurnMessage memory m = CctpMessageV2.parseBurnMessage(message);
        if (m.version != MESSAGE_VERSION) revert UnsupportedMessageVersion(m.version);
        if (m.destinationDomain != localDomain) revert WrongDestinationDomain(m.destinationDomain);
        if (m.recipient != CctpMessageV2.toBytes32(address(tokenMessenger))) revert NotABurnMessage(m.recipient);
        if (m.bodyVersion != BURN_MESSAGE_VERSION) revert UnsupportedBurnMessageVersion(m.bodyVersion);
        // Funds minted to anyone else are not ours to bind.
        if (m.mintRecipient != CctpMessageV2.toBytes32(address(this))) revert MintRecipientNotGateway(m.mintRecipient);
        // The burn token must be the remote counterpart of local USDC as CCTP maps it.
        if (ITokenMinterV2(tokenMessenger.localMinter()).getLocalToken(m.sourceDomain, m.burnToken) != address(usdc)) {
            revert BurnTokenNotUsdc(m.burnToken);
        }

        bytes32 messageHash = keccak256(message);

        // ---- Mint. Measured, never trusted from the message. ----
        uint256 net = _receive(message, attestation);

        // ---- Post-mint: never revert for a business reason. ----
        (RejectReason reason, HookDataV1 memory h, bytes32 expectedId) =
            _validateDeposit(CctpMessageV2.hookData(message), net);

        // Refunds go to the buyer's chosen recipient, else to the burner itself
        // (CCTP rejects a zero mintRecipient, so a zero refund address would
        // make the refund impossible).
        bytes32 refundTo = h.refundRecipient != bytes32(0) ? h.refundRecipient : m.messageSender;
        if (reason != RejectReason.None) {
            _rejectAndRefund(messageHash, reason, m.sourceDomain, refundTo, net);
            return bytes32(0);
        }

        // Effects (keyed by the id the escrow will derive; asserted below).
        deposits[expectedId] = Deposit({
            dealRef: h.dealRef,
            sourceDomain: m.sourceDomain,
            refundRecipient: refundTo,
            payoutDomain: h.payoutDomain,
            payoutRecipient: h.payoutRecipient,
            bound: true,
            refunded: false
        });
        if (h.payoutDomain != localDomain) {
            payoutRoutes[expectedId] = PayoutRoute({domain: h.payoutDomain, recipient: h.payoutRecipient});
            emit PayoutRouteSet(expectedId, h.payoutDomain, h.payoutRecipient, address(this));
        }
        emit CctpDepositBound(
            expectedId, h.dealRef, m.sourceDomain, m.messageSender, refundTo, m.amount, m.feeExecuted, m.nonce
        );

        // Interactions: lock exactly `net` in the escrow (buyer of record = gateway).
        _lock(h, net, expectedId);
        return expectedId;
    }

    // ------------------------------------------------------------------
    // Refund (expired gateway-funded intents)
    // ------------------------------------------------------------------

    /**
     * @notice Refund an expired gateway-funded intent back to the buyer's
     *         chain. Anyone may call; works while paused.
     */
    function refund(bytes32 intentId, uint256 maxFee, uint32 minFinalityThreshold) external nonReentrant {
        Deposit storage d = deposits[intentId];
        if (!d.bound) revert UnknownDeposit();
        if (d.refunded) revert AlreadyRefunded();
        d.refunded = true;

        uint256 amount = _pullRefund(intentId);
        _burn(d.sourceDomain, d.refundRecipient, amount, maxFee, minFinalityThreshold);
        emit CctpRefundSent(intentId, d.sourceDomain, d.refundRecipient, amount, maxFee);
    }

    /**
     * @notice Re-send the refund of a rejected deposit whose refund burn
     *         reverted in `relayDeposit`. Anyone may call; works while paused.
     */
    function retryRejectedRefund(bytes32 messageHash, uint256 maxFee, uint32 minFinalityThreshold)
        external
        nonReentrant
    {
        PendingRefund memory p = pendingRejectRefunds[messageHash];
        if (p.amount == 0) revert NothingPending();
        delete pendingRejectRefunds[messageHash];
        _burn(p.domain, p.recipient, p.amount, maxFee, minFinalityThreshold);
        emit CctpRejectRefundSent(messageHash, p.domain, p.recipient, p.amount, maxFee);
    }

    // ------------------------------------------------------------------
    // Cross-chain payout
    // ------------------------------------------------------------------

    /// @notice Set the cross-chain payout route of an intent whose sellerTarget
    ///         is this gateway. Once only; msg.sender must be the intent's buyer.
    function setPayoutRoute(bytes32 intentId, uint32 domain, bytes32 recipient) external nonReentrant {
        _setPayoutRoute(intentId, domain, recipient, msg.sender);
    }

    /// @notice Gasless variant: anyone submits the buyer's EIP-712
    ///         `SetPayoutRoute` signature (EOA or ERC-1271 wallet).
    function setPayoutRouteWithSig(
        bytes32 intentId,
        uint32 domain,
        bytes32 recipient,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired();
        address buyer = escrow.getIntent(intentId).buyer;
        bytes32 digest = payoutRouteDigest(intentId, domain, recipient, deadline);
        if (!_isValidSignature(buyer, digest, signature)) revert NotIntentBuyer();
        _setPayoutRoute(intentId, domain, recipient, buyer);
    }

    /**
     * @notice Claim the seller share of a gateway-targeted intent and burn
     *         exactly the received amount to its payout route. Anyone may
     *         call; works while paused. If the intent was already claimed
     *         directly at the escrow, forwards the share that landed here.
     */
    function claimAndForward(
        bytes32 intentId,
        bytes calldata ciphertext,
        bytes calldata witness,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external nonReentrant {
        PayoutRoute memory r = payoutRoutes[intentId];
        if (r.recipient == bytes32(0)) revert NoPayoutRoute();
        if (payoutSent[intentId]) revert AlreadyPaidOut();
        payoutSent[intentId] = true;

        uint256 amount = _pullSellerShare(intentId, ciphertext, witness);
        _burn(r.domain, r.recipient, amount, maxFee, minFinalityThreshold);
        emit CctpPayoutSent(intentId, r.domain, r.recipient, amount, maxFee);
    }

    // ------------------------------------------------------------------
    // Pause (new deposits only)
    // ------------------------------------------------------------------

    function pause() external {
        if (msg.sender != pauser) revert NotPauser(); // msg.sender is never address(0)
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        if (msg.sender != pauser) revert NotPauser(); // msg.sender is never address(0)
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Largest `maxFee` accepted for a burn of `amount`.
    function feeCap(uint256 amount) public view returns (uint256 cap) {
        if (amount < 2) return 0; // maxFee must be < amount
        cap = (amount * feeCapBps) / 10000;
        if (cap < feeCapFlat) cap = feeCapFlat;
        // CCTP requires maxFee < amount.
        if (cap >= amount) cap = amount - 1;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    function payoutRouteDigest(bytes32 intentId, uint32 domain, bytes32 recipient, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(SET_PAYOUT_ROUTE_TYPEHASH, intentId, domain, recipient, deadline));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /// @notice Decode hookData v1 (reverts on malformed input). Off-chain helper.
    function decodeHookDataV1(bytes calldata hookData) external pure returns (HookDataV1 memory h) {
        if (!_isCanonicalHookV1(hookData)) revert MalformedHookData();
        h = _decodeHookV1(hookData);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev receiveMessage, returning the USDC actually minted to the gateway.
    function _receive(bytes calldata message, bytes calldata attestation) private returns (uint256) {
        uint256 balanceBefore = usdc.balanceOf(address(this));
        if (!messageTransmitter.receiveMessage(message, attestation)) revert ReceiveFailed();
        return usdc.balanceOf(address(this)) - balanceBefore;
    }

    /// @dev Lock exactly `net` in a Class-A intent; the escrow pulls the full
    ///      allowance, so none is left behind. The id check is unreachable
    ///      unless the escrow's derivation diverged from `_expectedIntentId`
    ///      (covered by tests).
    function _lock(HookDataV1 memory h, uint256 net, bytes32 expectedId) private {
        usdc.forceApprove(address(escrow), net);
        bytes32 intentId = escrow.createIntent(
            AgentPactEscrowV3.SettlementClass.ClassA, h.verifier, h.params, h.sellerTarget, net, h.expiresAt
        );
        if (intentId != expectedId) revert IntentIdMismatch();
    }

    /// @dev Bring an expired intent's refund into the gateway (or account for
    ///      one a third party already pulled from the escrow) and return it.
    function _pullRefund(bytes32 intentId) private returns (uint256) {
        AgentPactEscrowV3.Intent memory it = escrow.getIntent(intentId);
        if (it.status == AgentPactEscrowV3.IntentStatus.CancelledByExpiry) {
            // Someone called the escrow directly; the refund already sits here.
            return it.lockedTotal;
        }
        if (it.status != AgentPactEscrowV3.IntentStatus.Open) revert NotRefundable();
        uint256 balanceBefore = usdc.balanceOf(address(this));
        escrow.refundExpiredIntent(intentId); // reverts unless expired
        return usdc.balanceOf(address(this)) - balanceBefore;
    }

    /// @dev Bring a gateway-targeted intent's seller share into the gateway (or
    ///      account for one a third party already claimed) and return it.
    function _pullSellerShare(bytes32 intentId, bytes calldata ciphertext, bytes calldata witness)
        private
        returns (uint256)
    {
        AgentPactEscrowV3.Intent memory it = escrow.getIntent(intentId);
        if (it.sellerTarget != address(this)) revert NotGatewayPayout();
        if (it.status == AgentPactEscrowV3.IntentStatus.ClaimedA) {
            // Claimed directly at the escrow; the seller share already sits here.
            return it.maxPrice - (it.maxPrice * escrow.platformFeeBps()) / 10000;
        }
        if (it.status != AgentPactEscrowV3.IntentStatus.Open) revert NotClaimable();
        uint256 balanceBefore = usdc.balanceOf(address(this));
        escrow.claimIntentForSeller(intentId, ciphertext, witness);
        return usdc.balanceOf(address(this)) - balanceBefore;
    }

    function _validateDeposit(bytes calldata hookData, uint256 net)
        private
        view
        returns (RejectReason reason, HookDataV1 memory h, bytes32 expectedId)
    {
        if (hookData.length < 32) return (RejectReason.MalformedHookData, h, bytes32(0));
        if (uint256(bytes32(hookData[0:32])) != HOOK_VERSION_1) return (RejectReason.UnknownHookVersion, h, bytes32(0));
        if (!_isCanonicalHookV1(hookData)) return (RejectReason.MalformedHookData, h, bytes32(0));
        h = _decodeHookV1(hookData);

        if (h.expiresAt <= block.timestamp) return (RejectReason.Expired, h, bytes32(0));
        if (!escrow.predicateRegistry().isApproved(h.verifier)) return (RejectReason.VerifierNotApproved, h, bytes32(0));
        if (h.price == 0 || net < h.price) return (RejectReason.Underfunded, h, bytes32(0));
        if (!_isValidDepositRoute(h)) return (RejectReason.InvalidPayoutRoute, h, bytes32(0));
        if (h.dealRef == bytes32(0)) return (RejectReason.ZeroDealRef, h, bytes32(0));

        expectedId = _expectedIntentId(h.verifier, h.params, net, h.expiresAt);
        if (escrow.getIntent(expectedId).status != AgentPactEscrowV3.IntentStatus.None) {
            return (RejectReason.DuplicateIntent, h, bytes32(0));
        }
        return (RejectReason.None, h, expectedId);
    }

    /// @dev Same-chain payout: sellerTarget is the seller and payoutRecipient
    ///      repeats it. Cross-chain payout: sellerTarget is this gateway and
    ///      the payout route is a non-zero recipient on another domain.
    function _isValidDepositRoute(HookDataV1 memory h) private view returns (bool) {
        if (h.payoutDomain == localDomain) {
            return h.sellerTarget != address(0) && h.sellerTarget != address(this)
                && h.payoutRecipient == CctpMessageV2.toBytes32(h.sellerTarget);
        }
        return h.sellerTarget == address(this) && h.payoutRecipient != bytes32(0);
    }

    /// @dev Strict check that `hookData` is exactly the canonical
    ///      `abi.encode` of the v1 tuple, so `abi.decode` cannot revert.
    function _isCanonicalHookV1(bytes calldata hd) private pure returns (bool) {
        // 10 head words + 1 length word for `params`.
        if (hd.length < 352) return false;
        if (uint256(bytes32(hd[0:32])) != HOOK_VERSION_1) return false;
        if (uint256(bytes32(hd[64:96])) >> 160 != 0) return false; // verifier
        if (uint256(bytes32(hd[96:128])) != 320) return false; // params offset
        if (uint256(bytes32(hd[128:160])) >> 160 != 0) return false; // sellerTarget
        if (uint256(bytes32(hd[160:192])) >> 64 != 0) return false; // expiresAt
        if (uint256(bytes32(hd[256:288])) >> 32 != 0) return false; // payoutDomain
        // The tail after the length word is `params` right-padded to 32 bytes.
        uint256 paramsLen = uint256(bytes32(hd[320:352]));
        uint256 tail = hd.length - 352;
        return tail % 32 == 0 && tail >= paramsLen && tail - paramsLen < 32;
    }

    function _decodeHookV1(bytes calldata hd) private pure returns (HookDataV1 memory h) {
        (, h.dealRef, h.verifier, h.params, h.sellerTarget, h.expiresAt, h.price, h.refundRecipient, h.payoutDomain,
            h.payoutRecipient) =
            abi.decode(hd, (uint8, bytes32, address, bytes, address, uint64, uint256, bytes32, uint32, bytes32));
    }

    /// @dev Mirrors AgentPactEscrowV3._deriveIntentId with buyer = this gateway.
    function _expectedIntentId(address verifier, bytes memory params, uint256 amount, uint64 expiresAt)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                address(this), verifier, params, amount, expiresAt, block.number, block.prevrandao, address(escrow)
            )
        );
    }

    function _rejectAndRefund(bytes32 messageHash, RejectReason reason, uint32 domain, bytes32 recipient, uint256 amount)
        private
    {
        emit CctpDepositRejected(messageHash, uint8(reason));
        // A CCTP mint is always > 0 (feeExecuted < amount); nothing to send otherwise.
        if (amount < 1) return;

        // Standard finality, fee bounded by the construction-time cap.
        uint256 maxFee = feeCap(amount);
        usdc.forceApprove(address(tokenMessenger), amount);
        try tokenMessenger.depositForBurnWithHook(
            amount,
            domain,
            recipient,
            address(usdc),
            bytes32(0),
            maxFee,
            FINALITY_THRESHOLD_FINALIZED,
            FORWARD_HOOK_DATA
        ) {
            emit CctpRejectRefundSent(messageHash, domain, recipient, amount, maxFee);
        } catch {
            // The mint is final; never revert after it. Park the refund for
            // `retryRejectedRefund` instead.
            usdc.forceApprove(address(tokenMessenger), 0);
            pendingRejectRefunds[messageHash] = PendingRefund({domain: domain, recipient: recipient, amount: amount});
            emit CctpRejectRefundPending(messageHash, domain, recipient, amount);
        }
    }

    /// @dev Burn `amount` to (domain, recipient) via the Forwarding Service.
    ///      TokenMessengerV2 pulls with transferFrom, so a zero allowance
    ///      afterwards proves exactly `amount` left the gateway.
    function _burn(uint32 domain, bytes32 recipient, uint256 amount, uint256 maxFee, uint32 minFinalityThreshold)
        private
    {
        _checkFeeParams(amount, maxFee, minFinalityThreshold);
        usdc.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurnWithHook(
            amount, domain, recipient, address(usdc), bytes32(0), maxFee, minFinalityThreshold, FORWARD_HOOK_DATA
        );
        if (usdc.allowance(address(this), address(tokenMessenger)) != 0) revert BurnAmountMismatch();
    }

    function _checkFeeParams(uint256 amount, uint256 maxFee, uint32 minFinalityThreshold) private view {
        if (minFinalityThreshold < FINALITY_THRESHOLD_CONFIRMED || minFinalityThreshold > FINALITY_THRESHOLD_FINALIZED) {
            revert BadFinalityThreshold(minFinalityThreshold);
        }
        uint256 cap = feeCap(amount);
        if (maxFee > cap) revert MaxFeeTooHigh(maxFee, cap);
    }

    function _setPayoutRoute(bytes32 intentId, uint32 domain, bytes32 recipient, address authorizer) private {
        if (payoutRoutes[intentId].recipient != bytes32(0)) revert PayoutRouteAlreadySet();
        if (recipient == bytes32(0) || domain == localDomain) revert InvalidRoute();
        AgentPactEscrowV3.Intent memory it = escrow.getIntent(intentId);
        if (it.buyer == address(0) || it.buyer != authorizer) revert NotIntentBuyer();
        if (it.sellerTarget != address(this)) revert NotGatewayPayout();
        // Only before any claim: a share already claimed into the gateway must
        // not be redirectable by the buyer after the fact.
        if (it.status != AgentPactEscrowV3.IntentStatus.Open) revert NotClaimable();
        payoutRoutes[intentId] = PayoutRoute({domain: domain, recipient: recipient});
        emit PayoutRouteSet(intentId, domain, recipient, authorizer);
    }

    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length > 0) {
            try IERC1271Minimal(signer).isValidSignature(digest, signature) returns (bytes4 magic) {
                return magic == _ERC1271_MAGIC;
            } catch {
                return false;
            }
        }
        return ECDSA.recover(digest, signature) == signer; // reverts on a malformed signature
    }
}
