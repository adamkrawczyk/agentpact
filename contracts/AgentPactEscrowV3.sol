// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "./predicates/IPredicateVerifier.sol";
import "./predicates/PredicateRegistry.sol";
import "./schelling/SchellingCommitReveal.sol";
import "./streaming/StreamingEngine.sol";

/**
 * @title IUSDCAuth
 * @notice Interface for USDC that supports both standard ERC-20 transfers and
 *         EIP-3009 receiveWithAuthorization.
 */
interface IUSDCAuth {
    function receiveWithAuthorization(
        address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external;
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title AgentPactEscrowV3
 * @notice Extends AgentPactEscrowV2 with a single new entry point:
 *         `createIntentWithAuthorization` — gasless Class-A intent creation via
 *         EIP-3009. The relayer (msg.sender) broadcasts this transaction while
 *         the buyer's USDC is pulled from the buyer's wallet under a
 *         buyer-signed EIP-3009 authorization. Buyer needs NO ETH.
 *
 *         All V2 functionality (Class A claim/refund, Class B Schelling,
 *         Class C streaming, fee split, platformWallet, platformFeeBps)
 *         is carried over unchanged.
 *
 * @dev    Security invariants (extended from V2):
 *         I7. it.buyer = buyer (the EIP-3009 authorizer), NEVER msg.sender
 *             (the relayer). A relayer must never be the refund target.
 *         I8. nonReentrant on the new entry point.
 *         I9. receiveWithAuthorization revert (bad sig / replay / expired)
 *             propagates directly — there is no swallowing.
 */
contract AgentPactEscrowV3 is ReentrancyGuard {
    using SchellingCommitReveal for uint256;
    using StreamingEngine for uint256;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------

    IUSDCAuth public immutable usdc;
    PredicateRegistry public immutable predicateRegistry;
    address public immutable platformWallet;
    address public immutable burnTo;
    uint256 public immutable platformFeeBps;

    // ------------------------------------------------------------------
    // Settlement-class types
    // ------------------------------------------------------------------

    enum SettlementClass { ClassA, ClassB, ClassC }

    enum IntentStatus {
        None,
        // Class A / Class C
        Open,
        ClaimedA,
        CancelledByExpiry,
        // Class B
        AwaitingAccept,
        Accepted,
        Delivered,
        Acknowledged,
        Round1Commit,
        Round2Reveal,
        SettledSchelling,
        // Class C
        Streaming,
        StreamCancelled
    }

    struct Intent {
        SettlementClass class;
        IntentStatus status;
        address buyer;
        address sellerTarget;
        address acceptedSeller;
        address verifier;
        bytes32 predicateHash;
        uint256 maxPrice;
        uint256 buyerStake;
        uint256 sellerStake;
        uint256 lockedTotal;
        uint64 expiresAt;
        uint64 ackDeadline;
        uint64 round1Deadline;
        uint64 round2Deadline;
        uint256 perUnitPrice;
        uint256 maxUnits;
        uint256 unitsClaimed;
        bytes32 buyerCommit;
        bytes32 sellerCommit;
        bytes buyerReveal;
        bytes sellerReveal;
        bytes32 buyerSalt;
        bytes32 sellerSalt;
    }

    mapping(bytes32 => Intent) private _intents;
    mapping(bytes32 => bytes) public predicateParams;

    // ------------------------------------------------------------------
    // Events (identical to V2 plus no additions needed)
    // ------------------------------------------------------------------

    event IntentCreated(
        bytes32 indexed intentId,
        SettlementClass class,
        address indexed buyer,
        address indexed sellerTarget,
        address verifier,
        uint256 maxPrice,
        uint64 expiresAt
    );
    event IntentClaimedA(
        bytes32 indexed intentId,
        address indexed seller,
        uint256 sellerAmount,
        uint256 platformFee
    );
    event IntentExpired(bytes32 indexed intentId);

    event ClassBAccepted(bytes32 indexed intentId, address indexed seller, uint256 sellerStake, uint64 ackDeadline);
    event ClassBDelivered(bytes32 indexed intentId);
    event ClassBAcknowledged(bytes32 indexed intentId, uint256 sellerAmount, uint256 platformFee);
    event ClassBRejected(bytes32 indexed intentId, bytes32 buyerCommit, uint64 round1Deadline);
    event ClassBSellerCommitted(bytes32 indexed intentId, bytes32 sellerCommit);
    event ClassBRevealed(bytes32 indexed intentId, address indexed who);
    event ClassBSettled(bytes32 indexed intentId, SchellingCommitReveal.Outcome outcome);
    event StakesBurned(bytes32 indexed intentId, uint256 totalBurned, uint256 buyerRefund);

    event StreamingUnitClaimed(
        bytes32 indexed intentId,
        uint256 indexed unitIndex,
        address indexed seller,
        uint256 sellerShare,
        uint256 platformShare
    );
    event StreamCancelled(bytes32 indexed intentId, address indexed by, uint256 refundToBuyer);

    event KeyDeliveryRequested(bytes32 indexed intentId, address indexed buyer);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        address _usdc,
        address _registry,
        address _platformWallet,
        address _burnTo,
        uint256 _platformFeeBps
    ) {
        require(_usdc != address(0), "Escrow: zero usdc");
        require(_registry != address(0), "Escrow: zero registry");
        require(_platformWallet != address(0), "Escrow: zero platform wallet");
        require(_burnTo != address(0), "Escrow: zero burn addr");
        require(_platformFeeBps <= 10000, "Escrow: fee >100%");
        usdc = IUSDCAuth(_usdc);
        predicateRegistry = PredicateRegistry(_registry);
        platformWallet = _platformWallet;
        burnTo = _burnTo;
        platformFeeBps = _platformFeeBps;
    }

    // ------------------------------------------------------------------
    // Read accessors
    // ------------------------------------------------------------------

    function getIntent(bytes32 intentId) external view returns (Intent memory) {
        return _intents[intentId];
    }

    // ------------------------------------------------------------------
    // Class A — create (standard, transferFrom path)
    // ------------------------------------------------------------------

    /**
     * @notice Create a Class A intent. Buyer must be msg.sender; USDC locked
     *         immediately via transferFrom (requires prior approve).
     */
    function createIntent(
        SettlementClass class,
        address verifier,
        bytes calldata params,
        address sellerTarget,
        uint256 maxPrice,
        uint64 expiresAt
    ) external nonReentrant returns (bytes32 intentId) {
        require(class == SettlementClass.ClassA, "Escrow: use createIntentB/Streaming");
        require(predicateRegistry.isApproved(verifier), "Escrow: verifier not approved");
        require(maxPrice > 0, "Escrow: zero price");
        require(expiresAt > block.timestamp, "Escrow: bad expiry");

        intentId = _deriveIntentId(msg.sender, verifier, params, maxPrice, expiresAt);
        require(_intents[intentId].status == IntentStatus.None, "Escrow: dup intent");

        Intent storage it = _intents[intentId];
        it.class = SettlementClass.ClassA;
        it.status = IntentStatus.Open;
        it.buyer = msg.sender;
        it.sellerTarget = sellerTarget;
        it.verifier = verifier;
        it.predicateHash = keccak256(abi.encodePacked(verifier, params));
        it.maxPrice = maxPrice;
        it.lockedTotal = maxPrice;
        it.expiresAt = expiresAt;

        predicateParams[intentId] = params;

        require(usdc.transferFrom(msg.sender, address(this), maxPrice), "Escrow: lock failed");

        emit IntentCreated(intentId, SettlementClass.ClassA, msg.sender, sellerTarget, verifier, maxPrice, expiresAt);
    }

    // ------------------------------------------------------------------
    // Class A — NEW: gasless creation via EIP-3009
    // ------------------------------------------------------------------

    /**
     * @notice Gasless Class-A intent creation. The relayer (msg.sender) broadcasts
     *         this; USDC is pulled from `buyer` via their EIP-3009
     *         receiveWithAuthorization signature. Buyer needs NO ETH and need
     *         not be online at broadcast time.
     *
     * @dev    1. Calls usdc.receiveWithAuthorization(buyer, address(this), value,
     *            validAfter, validBefore, nonce, v, r, s) — pulls `value` USDC
     *            from buyer to escrow.
     *         2. require(value == maxPrice).
     *         3. Builds the Class-A Intent exactly as createIntent does, but with
     *            it.buyer = `buyer` (NOT msg.sender), it.lockedTotal = value.
     *         4. `_deriveIntentId` uses `buyer` (not msg.sender) consistently.
     *         5. Emits IntentCreated(intentId, ClassA, buyer, sellerTarget, verifier,
     *            maxPrice, expiresAt).
     *
     * @param buyer         The USDC holder who signed the EIP-3009 authorization.
     *                      This wallet becomes the intent's refund target.
     * @param verifier      Address of an approved IPredicateVerifier.
     * @param params        ABI-encoded predicate params. Frozen at creation.
     * @param sellerTarget  0x0 to open; non-zero to bind to a specific seller.
     * @param maxPrice      Full locked amount (USDC 6-decimal).
     * @param expiresAt     Unix seconds; must be in the future.
     * @param value         Must equal maxPrice (EIP-3009 transfer amount).
     * @param validAfter    EIP-3009 authorization not valid at or before this time.
     * @param validBefore   EIP-3009 authorization not valid at or after this time.
     * @param nonce         Unique bytes32 per authorization (replay protection).
     * @param v             EIP-712 signature component.
     * @param r             EIP-712 signature component.
     * @param s             EIP-712 signature component.
     * @return intentId     The created intent's id.
     */
    function createIntentWithAuthorization(
        address buyer,
        address verifier,
        bytes calldata params,
        address sellerTarget,
        uint256 maxPrice,
        uint64  expiresAt,
        // EIP-3009 receiveWithAuthorization params (signed by buyer off-chain):
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32 intentId) {
        // Basic input validation.
        require(buyer != address(0), "Escrow: zero buyer");
        require(predicateRegistry.isApproved(verifier), "Escrow: verifier not approved");
        require(maxPrice > 0, "Escrow: zero price");
        require(expiresAt > block.timestamp, "Escrow: bad expiry");

        // The authorization must cover exactly maxPrice — no more, no less.
        require(value == maxPrice, "Escrow: value != maxPrice");

        // Derive the intent id using `buyer` (the authorizer) exactly as
        // createIntent uses msg.sender — so the id is identical whether the
        // intent is funded directly or via authorization.
        intentId = _deriveIntentId(buyer, verifier, params, maxPrice, expiresAt);
        require(_intents[intentId].status == IntentStatus.None, "Escrow: dup intent");

        // Store intent state BEFORE the external USDC call (Checks-Effects-Interactions).
        Intent storage it = _intents[intentId];
        it.class = SettlementClass.ClassA;
        it.status = IntentStatus.Open;
        it.buyer = buyer;                        // I7: authorizer, NOT relayer
        it.sellerTarget = sellerTarget;
        it.verifier = verifier;
        it.predicateHash = keccak256(abi.encodePacked(verifier, params));
        it.maxPrice = maxPrice;
        it.lockedTotal = value;
        it.expiresAt = expiresAt;

        predicateParams[intentId] = params;

        // Interaction: pull USDC from buyer via their signed authorization.
        // If the authorization is invalid (bad sig, replayed nonce, expired window),
        // this call reverts and the effect above is rolled back — nothing is stored.
        usdc.receiveWithAuthorization(
            buyer,
            address(this),
            value,
            validAfter,
            validBefore,
            nonce,
            v, r, s
        );

        emit IntentCreated(intentId, SettlementClass.ClassA, buyer, sellerTarget, verifier, maxPrice, expiresAt);
    }

    // ------------------------------------------------------------------
    // Class A — claim + refund
    // ------------------------------------------------------------------

    /**
     * @notice Seller claims a Class A intent by presenting ciphertext + witness.
     */
    function claimIntent(
        bytes32 intentId,
        bytes calldata ciphertext,
        bytes calldata witness
    ) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Open && it.class == SettlementClass.ClassA, "Escrow: not Class A open");
        require(block.timestamp < it.expiresAt, "Escrow: expired");
        require(
            it.sellerTarget == address(0) || it.sellerTarget == msg.sender,
            "Escrow: INTENT_TARGETED_TO_OTHER_SELLER"
        );

        bytes memory params = predicateParams[intentId];
        bool ok = IPredicateVerifier(it.verifier).verify(params, ciphertext, witness);
        require(ok, "Escrow: predicate failed");

        // Effects FIRST.
        it.status = IntentStatus.ClaimedA;
        it.acceptedSeller = msg.sender;

        (uint256 sellerShare, uint256 platformShare) = StreamingEngine.unitPayout(it.maxPrice, platformFeeBps);

        // Interactions.
        require(usdc.transfer(msg.sender, sellerShare), "Escrow: seller xfer failed");
        if (platformShare > 0) {
            require(usdc.transfer(platformWallet, platformShare), "Escrow: platform xfer failed");
        }

        emit IntentClaimedA(intentId, msg.sender, sellerShare, platformShare);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    /**
     * @notice Relayer-brokered Class A claim. Anyone (typically the autoclose
     *         relayer) may broadcast this, but the seller's 90% share is paid to
     *         the intent's designated `sellerTarget` — NOT to msg.sender. This is
     *         the gasless-for-both-parties settlement path: the seller never needs
     *         ETH, the relayer sponsors gas, and funds settle to the correct
     *         seller address with no custodial hop (the relayer never receives
     *         the seller's money). Requires a non-zero sellerTarget (an untargeted
     *         intent has no canonical payee, so this path is disallowed for it —
     *         use claimIntent for the self-claim case).
     * @dev    The predicate still gates correctness identically to claimIntent;
     *         broadcasting authority is decoupled from payee. The off-chain layer
     *         (API reveal endpoint) enforces that only the deal's seller can
     *         trigger a reveal, which is what queues this claim.
     */
    function claimIntentForSeller(
        bytes32 intentId,
        bytes calldata ciphertext,
        bytes calldata witness
    ) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Open && it.class == SettlementClass.ClassA, "Escrow: not Class A open");
        require(block.timestamp < it.expiresAt, "Escrow: expired");
        require(it.sellerTarget != address(0), "Escrow: NO_SELLER_TARGET");

        bytes memory params = predicateParams[intentId];
        bool ok = IPredicateVerifier(it.verifier).verify(params, ciphertext, witness);
        require(ok, "Escrow: predicate failed");

        // Effects FIRST.
        it.status = IntentStatus.ClaimedA;
        it.acceptedSeller = it.sellerTarget;

        (uint256 sellerShare, uint256 platformShare) = StreamingEngine.unitPayout(it.maxPrice, platformFeeBps);

        // Interactions — seller share goes to the designated sellerTarget, never msg.sender.
        require(usdc.transfer(it.sellerTarget, sellerShare), "Escrow: seller xfer failed");
        if (platformShare > 0) {
            require(usdc.transfer(platformWallet, platformShare), "Escrow: platform xfer failed");
        }

        emit IntentClaimedA(intentId, it.sellerTarget, sellerShare, platformShare);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    /**
     * @notice Refund an expired open intent to the buyer.
     * @dev The refund target is the stored `buyer` (invariant I7), not msg.sender.
     */
    function refundExpiredIntent(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Open, "Escrow: not open");
        require(block.timestamp >= it.expiresAt, "Escrow: not expired");

        it.status = IntentStatus.CancelledByExpiry;
        uint256 refund = it.lockedTotal;

        require(usdc.transfer(it.buyer, refund), "Escrow: refund failed");
        emit IntentExpired(intentId);
    }

    // ------------------------------------------------------------------
    // Class B — Schelling commit-reveal
    // ------------------------------------------------------------------

    function createIntentB(
        address verifier,
        bytes calldata params,
        address sellerTarget,
        uint256 maxPrice,
        uint16 buyerStakeBps,
        uint64 expiresAt
    ) external nonReentrant returns (bytes32 intentId) {
        require(predicateRegistry.isApproved(verifier), "Escrow: verifier not approved");
        require(maxPrice > 0, "Escrow: zero price");
        require(buyerStakeBps <= 10000, "Escrow: stake bps too high");
        require(expiresAt > block.timestamp, "Escrow: bad expiry");

        uint256 buyerStake = (maxPrice * buyerStakeBps) / 10000;
        uint256 lockTotal = maxPrice + buyerStake;

        intentId = _deriveIntentId(msg.sender, verifier, params, maxPrice, expiresAt);
        require(_intents[intentId].status == IntentStatus.None, "Escrow: dup intent");

        Intent storage it = _intents[intentId];
        it.class = SettlementClass.ClassB;
        it.status = IntentStatus.AwaitingAccept;
        it.buyer = msg.sender;
        it.sellerTarget = sellerTarget;
        it.verifier = verifier;
        it.predicateHash = keccak256(abi.encodePacked(verifier, params));
        it.maxPrice = maxPrice;
        it.buyerStake = buyerStake;
        it.lockedTotal = lockTotal;
        it.expiresAt = expiresAt;
        predicateParams[intentId] = params;

        require(usdc.transferFrom(msg.sender, address(this), lockTotal), "Escrow: lock failed");
        emit IntentCreated(intentId, SettlementClass.ClassB, msg.sender, sellerTarget, verifier, maxPrice, expiresAt);
    }

    function acceptIntentB(bytes32 intentId, uint16 sellerStakeBps) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.AwaitingAccept, "Escrow: not awaiting accept");
        require(block.timestamp < it.expiresAt, "Escrow: expired");
        require(
            it.sellerTarget == address(0) || it.sellerTarget == msg.sender,
            "Escrow: INTENT_TARGETED_TO_OTHER_SELLER"
        );
        require(sellerStakeBps <= 10000, "Escrow: stake bps too high");

        uint256 sellerStake = (it.maxPrice * sellerStakeBps) / 10000;
        uint256 cap = SchellingCommitReveal.sellerStakeCap(it.maxPrice);
        require(sellerStake <= cap, "STAKE_EXCEEDS_CAP");

        it.status = IntentStatus.Accepted;
        it.acceptedSeller = msg.sender;
        it.sellerStake = sellerStake;
        it.lockedTotal += sellerStake;

        require(usdc.transferFrom(msg.sender, address(this), sellerStake), "Escrow: stake lock failed");
        emit ClassBAccepted(intentId, msg.sender, sellerStake, 0);
    }

    function deliver(bytes32 intentId, bytes calldata /* ciphertext */) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Accepted, "Escrow: not accepted");
        require(msg.sender == it.acceptedSeller, "Escrow: not seller");

        it.status = IntentStatus.Delivered;
        it.ackDeadline = uint64(block.timestamp) + SchellingCommitReveal.ackWindowSeconds(it.maxPrice);
        emit ClassBDelivered(intentId);
    }

    function acknowledge(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Delivered, "Escrow: not delivered");
        require(msg.sender == it.buyer, "Escrow: not buyer");
        _settleAckSellerWins(intentId, it);
    }

    function acknowledgeTimeout(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Delivered, "Escrow: not delivered");
        require(block.timestamp >= it.ackDeadline, "Escrow: ack window open");
        _settleAckSellerWins(intentId, it);
    }

    function _settleAckSellerWins(bytes32 intentId, Intent storage it) private {
        it.status = IntentStatus.Acknowledged;
        (uint256 sellerShare, uint256 platformShare) =
            StreamingEngine.unitPayout(it.maxPrice, platformFeeBps);

        uint256 buyerStake = it.buyerStake;
        uint256 sellerStake = it.sellerStake;

        require(usdc.transfer(it.buyer, buyerStake), "Escrow: buyer stake refund failed");
        require(usdc.transfer(it.acceptedSeller, sellerShare + sellerStake), "Escrow: seller payout failed");
        if (platformShare > 0) {
            require(usdc.transfer(platformWallet, platformShare), "Escrow: platform xfer failed");
        }
        emit ClassBAcknowledged(intentId, sellerShare, platformShare);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    function reject(bytes32 intentId, bytes32 commitHash) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Delivered, "Escrow: not delivered");
        require(msg.sender == it.buyer, "Escrow: not buyer");
        require(block.timestamp < it.ackDeadline, "Escrow: ack window closed");
        require(commitHash != bytes32(0), "Escrow: empty commit");

        it.status = IntentStatus.Round1Commit;
        it.buyerCommit = commitHash;
        it.round1Deadline = uint64(block.timestamp) + 24 hours;
        emit ClassBRejected(intentId, commitHash, it.round1Deadline);
    }

    function commitRound1Seller(bytes32 intentId, bytes32 commitHash) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Round1Commit, "Escrow: not round1");
        require(msg.sender == it.acceptedSeller, "Escrow: not seller");
        require(block.timestamp < it.round1Deadline, "Escrow: round1 closed");
        require(commitHash != bytes32(0), "Escrow: empty commit");

        it.sellerCommit = commitHash;
        it.status = IntentStatus.Round2Reveal;
        it.round2Deadline = uint64(block.timestamp) + 24 hours;
        emit ClassBSellerCommitted(intentId, commitHash);
    }

    function revealRound2Buyer(bytes32 intentId, bytes calldata deliverable, bytes32 salt) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Round2Reveal, "Escrow: not round2");
        require(msg.sender == it.buyer, "Escrow: not buyer");
        require(block.timestamp < it.round2Deadline, "Escrow: round2 closed");
        require(
            keccak256(abi.encodePacked(deliverable, salt)) == it.buyerCommit,
            "Escrow: reveal mismatch"
        );
        it.buyerReveal = deliverable;
        it.buyerSalt = salt;
        emit ClassBRevealed(intentId, msg.sender);
    }

    function revealRound2Seller(bytes32 intentId, bytes calldata deliverable, bytes32 salt) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Round2Reveal, "Escrow: not round2");
        require(msg.sender == it.acceptedSeller, "Escrow: not seller");
        require(block.timestamp < it.round2Deadline, "Escrow: round2 closed");
        require(
            keccak256(abi.encodePacked(deliverable, salt)) == it.sellerCommit,
            "Escrow: reveal mismatch"
        );
        it.sellerReveal = deliverable;
        it.sellerSalt = salt;
        emit ClassBRevealed(intentId, msg.sender);
    }

    function settleSchelling(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(
            it.status == IntentStatus.Round1Commit || it.status == IntentStatus.Round2Reveal,
            "Escrow: not pending settle"
        );

        if (it.status == IntentStatus.Round1Commit) {
            require(block.timestamp >= it.round1Deadline, "Escrow: round1 still open");
            _settleSellerDefault(intentId, it, SchellingCommitReveal.Outcome.SellerDefaulted_Round1);
            return;
        }

        require(block.timestamp >= it.round2Deadline, "Escrow: round2 still open");
        bool buyerRevealed = it.buyerReveal.length > 0;
        bool sellerRevealed = it.sellerReveal.length > 0;

        if (!buyerRevealed && !sellerRevealed) {
            _settleBuyerDefault(intentId, it, SchellingCommitReveal.Outcome.BuyerDefaulted_Round2);
            return;
        }
        if (!buyerRevealed) {
            _settleBuyerDefault(intentId, it, SchellingCommitReveal.Outcome.BuyerDefaulted_Round2);
            return;
        }
        if (!sellerRevealed) {
            _settleSellerDefault(intentId, it, SchellingCommitReveal.Outcome.SellerDefaulted_Round2);
            return;
        }

        bool match_ = SchellingCommitReveal.revealsMatch(
            it.buyerReveal, it.buyerSalt, it.buyerCommit,
            it.sellerReveal, it.sellerSalt, it.sellerCommit
        );

        if (match_) {
            _settleHashMatchSellerWins(intentId, it);
        } else {
            _settleHashMismatchBothBurn(intentId, it);
        }
    }

    function _settleHashMatchSellerWins(bytes32 intentId, Intent storage it) private {
        it.status = IntentStatus.SettledSchelling;
        (uint256 sellerShare, uint256 priceFee) = StreamingEngine.unitPayout(it.maxPrice, platformFeeBps);
        uint256 buyerStakeToSeller = (it.buyerStake * 9000) / 10000;
        uint256 buyerStakeToPlatform = it.buyerStake - buyerStakeToSeller;
        require(usdc.transfer(it.acceptedSeller, sellerShare + it.sellerStake + buyerStakeToSeller), "Escrow: seller payout failed");
        uint256 platformOut = priceFee + buyerStakeToPlatform;
        if (platformOut > 0) {
            require(usdc.transfer(platformWallet, platformOut), "Escrow: platform xfer failed");
        }
        emit ClassBSettled(intentId, SchellingCommitReveal.Outcome.SellerWins_HashMatch);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    function _settleHashMismatchBothBurn(bytes32 intentId, Intent storage it) private {
        it.status = IntentStatus.SettledSchelling;
        uint256 totalBurn = it.buyerStake + it.sellerStake;
        require(usdc.transfer(it.buyer, it.maxPrice), "Escrow: buyer refund failed");
        if (totalBurn > 0) {
            require(usdc.transfer(burnTo, totalBurn), "Escrow: burn xfer failed");
        }
        emit ClassBSettled(intentId, SchellingCommitReveal.Outcome.BothBurn_HashMismatch);
        emit StakesBurned(intentId, totalBurn, it.maxPrice);
    }

    function _settleBuyerDefault(bytes32 intentId, Intent storage it, SchellingCommitReveal.Outcome outcome) private {
        it.status = IntentStatus.SettledSchelling;
        (uint256 sellerShare, uint256 platformShare) = StreamingEngine.unitPayout(it.maxPrice, platformFeeBps);
        require(usdc.transfer(it.acceptedSeller, sellerShare + it.sellerStake), "Escrow: seller payout failed");
        if (platformShare > 0) {
            require(usdc.transfer(platformWallet, platformShare), "Escrow: platform xfer failed");
        }
        if (it.buyerStake > 0) {
            require(usdc.transfer(burnTo, it.buyerStake), "Escrow: burn xfer failed");
        }
        emit ClassBSettled(intentId, outcome);
        emit StakesBurned(intentId, it.buyerStake, 0);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    function _settleSellerDefault(bytes32 intentId, Intent storage it, SchellingCommitReveal.Outcome outcome) private {
        it.status = IntentStatus.SettledSchelling;
        require(usdc.transfer(it.buyer, it.maxPrice + it.buyerStake), "Escrow: buyer refund failed");
        if (it.sellerStake > 0) {
            require(usdc.transfer(burnTo, it.sellerStake), "Escrow: burn xfer failed");
        }
        emit ClassBSettled(intentId, outcome);
        emit StakesBurned(intentId, it.sellerStake, it.maxPrice + it.buyerStake);
    }

    // ------------------------------------------------------------------
    // Class C — streaming / per-unit
    // ------------------------------------------------------------------

    function createStreamingIntent(
        address verifier,
        bytes calldata params,
        address sellerTarget,
        uint256 perUnitPrice,
        uint256 maxUnits,
        uint64 expiresAt
    ) external nonReentrant returns (bytes32 intentId) {
        require(predicateRegistry.isApproved(verifier), "Escrow: verifier not approved");
        require(perUnitPrice > 0 && maxUnits > 0, "Escrow: zero stream");
        require(expiresAt > block.timestamp, "Escrow: bad expiry");

        uint256 lockTotal = perUnitPrice * maxUnits;
        require(lockTotal / maxUnits == perUnitPrice, "Escrow: overflow");

        intentId = _deriveIntentId(msg.sender, verifier, params, lockTotal, expiresAt);
        require(_intents[intentId].status == IntentStatus.None, "Escrow: dup intent");

        Intent storage it = _intents[intentId];
        it.class = SettlementClass.ClassC;
        it.status = IntentStatus.Streaming;
        it.buyer = msg.sender;
        it.sellerTarget = sellerTarget;
        it.verifier = verifier;
        it.predicateHash = keccak256(abi.encodePacked(verifier, params));
        it.maxPrice = lockTotal;
        it.lockedTotal = lockTotal;
        it.perUnitPrice = perUnitPrice;
        it.maxUnits = maxUnits;
        it.expiresAt = expiresAt;
        predicateParams[intentId] = params;

        require(usdc.transferFrom(msg.sender, address(this), lockTotal), "Escrow: lock failed");
        emit IntentCreated(intentId, SettlementClass.ClassC, msg.sender, sellerTarget, verifier, lockTotal, expiresAt);
    }

    function claimUnit(
        bytes32 intentId,
        uint256 unitIndex,
        bytes calldata ciphertext,
        bytes calldata witness
    ) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Streaming, "Escrow: not streaming");
        require(block.timestamp < it.expiresAt, "Escrow: expired");
        require(
            it.sellerTarget == address(0) || it.sellerTarget == msg.sender,
            "Escrow: INTENT_TARGETED_TO_OTHER_SELLER"
        );

        StreamingEngine.checkUnitOrder(unitIndex, it.unitsClaimed, it.maxUnits);

        if (it.acceptedSeller == address(0)) {
            it.acceptedSeller = msg.sender;
        } else {
            require(it.acceptedSeller == msg.sender, "Escrow: stream owned by another seller");
        }

        bytes memory params = predicateParams[intentId];
        bool ok = IPredicateVerifier(it.verifier).verify(params, ciphertext, witness);
        require(ok, "Escrow: predicate failed");

        it.unitsClaimed = unitIndex + 1;
        (uint256 sellerShare, uint256 platformShare) = StreamingEngine.unitPayout(it.perUnitPrice, platformFeeBps);

        require(usdc.transfer(msg.sender, sellerShare), "Escrow: seller xfer failed");
        if (platformShare > 0) {
            require(usdc.transfer(platformWallet, platformShare), "Escrow: platform xfer failed");
        }
        emit StreamingUnitClaimed(intentId, unitIndex, msg.sender, sellerShare, platformShare);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    function cancelStream(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Streaming, "Escrow: not streaming");
        require(
            msg.sender == it.buyer || msg.sender == it.acceptedSeller,
            "Escrow: not party"
        );

        it.status = IntentStatus.StreamCancelled;
        uint256 refund = StreamingEngine.cancelRefund(it.lockedTotal, it.unitsClaimed, it.perUnitPrice);

        if (refund > 0) {
            require(usdc.transfer(it.buyer, refund), "Escrow: refund failed");
        }
        emit StreamCancelled(intentId, msg.sender, refund);
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * @notice Derive a deterministic intent id from buyer address + predicate
     *         inputs + block entropy.
     * @dev Uses `buyer` parameter so that createIntent (buyer=msg.sender) and
     *      createIntentWithAuthorization (buyer=the authorizer) derive
     *      identical ids for the same logical buyer.
     */
    function _deriveIntentId(
        address buyer,
        address verifier,
        bytes calldata params,
        uint256 amount,
        uint64 expiresAt
    ) private view returns (bytes32) {
        return keccak256(abi.encodePacked(
            buyer,
            verifier,
            params,
            amount,
            expiresAt,
            block.number,
            block.prevrandao,
            address(this)
        ));
    }
}
