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
 * @title AgentPactEscrowV2
 * @notice Verifiable settlement protocol — three classes (A, B, C), zero
 *         arbiters in the settlement loop, money locks at intent creation.
 *
 * @dev For the full specification, see the v2 settlement protocol design
 *      doc referenced in the project's internal docs. Public observable summary:
 *
 *        Class A — cryptographically verifiable (predicate-check inside EVM).
 *                  Settlement = 1 tx, no judge, no dispute window.
 *        Class B — subjective deliverables resolved via Schelling commit-reveal.
 *                  Dual-stake; non-action = ack; hash-mismatch burns both stakes;
 *                  default loses defaulter's stake to non-defaulter.
 *        Class C — streaming / per-unit; reuses Class A verifiers per unit.
 *
 *      Invariants the contract enforces:
 *        I1. Money never moves except via verified state transitions.
 *        I2. Each intent has exactly one terminal status (claimed/acked/burned/refunded/cancelled).
 *        I3. Total USDC leaving the contract for an intent ≤ total USDC that
 *            entered for that intent (no inflation).
 *        I4. The predicate registry is immutable after construction.
 *        I5. The platform fee constant is immutable after construction.
 *        I6. `sellerTarget != 0` claims/accepts are restricted to that seller.
 *
 *      Out-of-scope (deferred to v2.1+):
 *        - Reclaim zkTLS / Risc Zero zkVM verifiers (registry would need to be
 *          versioned; this is why a new escrow ships when new verifiers ship).
 *        - Adaptor-signature atomic key release (v2.3) — server still custodies
 *          the symmetric key between deliver() and acknowledge() in v2.0.
 *        - Smart-wallet (EIP-1271) pubkey registration (v2.1) — EOA-only here.
 *
 *      Solidity invariants relied on:
 *        - 0.8.x checked arithmetic (overflow reverts; we don't `unchecked`).
 *        - ReentrancyGuard on every state-changing entry point.
 *        - Checks-Effects-Interactions on every USDC transfer.
 */
contract AgentPactEscrowV2 is ReentrancyGuard {
    using SchellingCommitReveal for uint256;
    using StreamingEngine for uint256;

    // ─────────────────────────────────────────────────────────────────────
    // Immutables
    // ─────────────────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    PredicateRegistry public immutable predicateRegistry;
    address public immutable platformWallet;
    /// @notice Burn destination for Class B disagreement outcomes. Per Q1=B:
    ///         defaults to 0x…dEaD; configurable at deploy time only.
    address public immutable burnTo;
    /// @notice Platform fee in basis points. 1000 = 10 %. Frozen at deploy.
    uint256 public immutable platformFeeBps;

    // ─────────────────────────────────────────────────────────────────────
    // Settlement-class types
    // ─────────────────────────────────────────────────────────────────────

    enum SettlementClass { ClassA, ClassB, ClassC }

    enum IntentStatus {
        None,
        // Class A / Class C
        Open,
        ClaimedA,                 // Class A: claim verified, settled (terminal)
        CancelledByExpiry,        // expired before claim (terminal)
        // Class B
        AwaitingAccept,           // Class B: open, waiting for seller acceptIntentB
        Accepted,                 // Class B: seller accepted; awaiting deliver()
        Delivered,                // Class B: seller delivered; ack window open
        Acknowledged,             // Class B: buyer ack (or auto-ack) → seller paid (terminal)
        Round1Commit,             // Class B: buyer rejected; commit phase
        Round2Reveal,             // Class B: both committed; reveal phase
        SettledSchelling,         // Class B: schelling settled (terminal)
        // Class C
        Streaming,                // Class C: open, accepting per-unit claims
        StreamCancelled           // Class C: cancelled; remaining refunded (terminal)
    }

    struct Intent {
        SettlementClass class;
        IntentStatus status;
        address buyer;
        address sellerTarget;     // 0x0 → open to any seller; else restricted
        address acceptedSeller;   // populated once a Class B/C seller is bound
        address verifier;         // PredicateRegistry-approved
        bytes32 predicateHash;    // keccak256(verifier || params); committed at creation
        uint256 maxPrice;         // USDC 6-decimal
        uint256 buyerStake;       // Class B only
        uint256 sellerStake;      // Class B only
        uint256 lockedTotal;      // total USDC locked (price + stakes + stream)
        uint64 expiresAt;
        uint64 ackDeadline;       // Class B only
        uint64 round1Deadline;    // Class B only
        uint64 round2Deadline;    // Class B only
        // Class C only
        uint256 perUnitPrice;
        uint256 maxUnits;
        uint256 unitsClaimed;
        // Schelling state (Class B)
        bytes32 buyerCommit;
        bytes32 sellerCommit;
        bytes  buyerReveal;
        bytes  sellerReveal;
        bytes32 buyerSalt;
        bytes32 sellerSalt;
    }

    mapping(bytes32 => Intent) private _intents;
    /// @notice Predicate parameter bytes stored alongside intents (kept in
    ///         separate mapping so the Intent struct stays slot-efficient).
    mapping(bytes32 => bytes) public predicateParams;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

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

    // For Class A and Class C, off-chain key-custody server listens for this
    // event and releases the symmetric key sealed to the buyer's pubkey.
    event KeyDeliveryRequested(bytes32 indexed intentId, address indexed buyer);

    // ─────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────

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
        usdc = IERC20(_usdc);
        predicateRegistry = PredicateRegistry(_registry);
        platformWallet = _platformWallet;
        burnTo = _burnTo;
        platformFeeBps = _platformFeeBps;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Read accessors
    // ─────────────────────────────────────────────────────────────────────

    function getIntent(bytes32 intentId) external view returns (Intent memory) {
        return _intents[intentId];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Class A — create + claim
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a Class A (verifiable) or Class C (streaming) intent.
     *         USDC locks immediately via `transferFrom` (caller must `approve`
     *         this contract first — or use a relayer-broadcast EIP-3009
     *         permit via the higher-level routes).
     *
     * @param class         ClassA or ClassC. Class B uses {createIntentB}.
     * @param verifier      Address of an approved {IPredicateVerifier}.
     * @param params        ABI-encoded predicate params. Frozen at creation.
     * @param sellerTarget  0x0 to open; non-zero to bind to a specific seller.
     * @param maxPrice      For Class A: full locked amount (USDC 6-decimal).
     *                      For Class C: ignored — see {createStreamingIntent}.
     * @param expiresAt     Unix seconds; must be in the future.
     * @return intentId     The created intent's id.
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

    /**
     * @notice Seller claims a Class A intent by presenting ciphertext + witness.
     * @dev The verifier is called via STATICCALL semantics (it's a `view` function);
     *      a revert from the verifier propagates here, reverting the claim. A
     *      well-formed-but-failing proof returns `false` and we revert with
     *      `Escrow: predicate failed`.
     *
     *      Settlement is single-tx: verify → pay seller → pay platform → emit
     *      key-delivery event for off-chain key custodian.
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
     * @notice Refund an expired open intent to the buyer.
     * @dev Anyone can call (typically a sweeper). The refund target is the
     *      stored `buyer`, not msg.sender, so callers cannot redirect funds.
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

    // ─────────────────────────────────────────────────────────────────────
    // Class B — Schelling commit-reveal
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a Class B intent. Buyer locks `price + buyerStake`.
     * @dev buyerStakeBps capped at 10000 (100% of price); typical value 1000 (10%).
     */
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

    /**
     * @notice Seller accepts a Class B intent, locking their stake.
     * @dev Stake cap enforced on-chain per § 2.2:
     *        sellerStake_computed = (maxPrice * sellerStakeBps) / 10000
     *        require(sellerStake_computed <= min(maxPrice / 2, 50e6))
     */
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

        // Effects
        it.status = IntentStatus.Accepted;
        it.acceptedSeller = msg.sender;
        it.sellerStake = sellerStake;
        it.lockedTotal += sellerStake;

        // Interactions
        require(usdc.transferFrom(msg.sender, address(this), sellerStake), "Escrow: stake lock failed");
        // ackDeadline is set on deliver(), not here — seller might delay delivery.
        emit ClassBAccepted(intentId, msg.sender, sellerStake, 0);
    }

    /**
     * @notice Seller submits ciphertext for buyer review. Starts the ack window.
     * @dev `ciphertext` is recorded only via event (not stored on-chain) to keep
     *      gas bounded; the relayer/key-vault persists the canonical copy.
     */
    function deliver(bytes32 intentId, bytes calldata /* ciphertext */) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Accepted, "Escrow: not accepted");
        require(msg.sender == it.acceptedSeller, "Escrow: not seller");

        it.status = IntentStatus.Delivered;
        it.ackDeadline = uint64(block.timestamp) + SchellingCommitReveal.ackWindowSeconds(it.maxPrice);
        emit ClassBDelivered(intentId);
    }

    /// @notice Buyer acknowledges the deliverable — seller paid, stakes returned.
    function acknowledge(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Delivered, "Escrow: not delivered");
        require(msg.sender == it.buyer, "Escrow: not buyer");
        _settleAckSellerWins(intentId, it);
    }

    /// @notice Sweeper triggers auto-ack once the buyer's window has elapsed.
    function acknowledgeTimeout(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Delivered, "Escrow: not delivered");
        require(block.timestamp >= it.ackDeadline, "Escrow: ack window open");
        _settleAckSellerWins(intentId, it);
    }

    function _settleAckSellerWins(bytes32 intentId, Intent storage it) private {
        // Effects
        it.status = IntentStatus.Acknowledged;
        (uint256 sellerShare, uint256 platformShare) =
            StreamingEngine.unitPayout(it.maxPrice, platformFeeBps);

        // Refund both stakes; pay seller; pay platform.
        uint256 buyerStake = it.buyerStake;
        uint256 sellerStake = it.sellerStake;

        // Interactions
        require(usdc.transfer(it.buyer, buyerStake), "Escrow: buyer stake refund failed");
        require(usdc.transfer(it.acceptedSeller, sellerShare + sellerStake), "Escrow: seller payout failed");
        if (platformShare > 0) {
            require(usdc.transfer(platformWallet, platformShare), "Escrow: platform xfer failed");
        }
        emit ClassBAcknowledged(intentId, sellerShare, platformShare);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    /// @notice Buyer rejects the deliverable, posting their commit hash.
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

    /// @notice Seller responds with their commit hash during round 1.
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

    /// @notice Buyer reveals their observed deliverable + salt during round 2.
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

    /// @notice Seller reveals their observed deliverable + salt during round 2.
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

    /**
     * @notice Settle the Schelling subprotocol once round 2 is over.
     * @dev Callable by anyone (relayer/sweeper). Outcome computed from on-chain
     *      state: who revealed, whose reveals match commitments, whether the
     *      two revealed deliverables hash-match.
     */
    function settleSchelling(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(
            it.status == IntentStatus.Round1Commit || it.status == IntentStatus.Round2Reveal,
            "Escrow: not pending settle"
        );

        // ── Round 1 default branches (no progress out of Round1Commit) ──
        if (it.status == IntentStatus.Round1Commit) {
            require(block.timestamp >= it.round1Deadline, "Escrow: round1 still open");
            // Seller failed to commit → seller defaulted.
            _settleSellerDefault(
                intentId,
                it,
                SchellingCommitReveal.Outcome.SellerDefaulted_Round1
            );
            return;
        }

        // ── Round 2 branches ──
        require(block.timestamp >= it.round2Deadline, "Escrow: round2 still open");
        bool buyerRevealed = it.buyerReveal.length > 0;
        bool sellerRevealed = it.sellerReveal.length > 0;

        if (!buyerRevealed && !sellerRevealed) {
            // Both defaulted → treat as buyer default (seller already committed
            // honestly by reaching round 2; buyer rejected then ghosted).
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

        // Both revealed honestly. Adjudicate match vs mismatch.
        bool match_ = SchellingCommitReveal.revealsMatch(
            it.buyerReveal,
            it.buyerSalt,
            it.buyerCommit,
            it.sellerReveal,
            it.sellerSalt,
            it.sellerCommit
        );

        if (match_) {
            _settleHashMatchSellerWins(intentId, it);
        } else {
            _settleHashMismatchBothBurn(intentId, it);
        }
    }

    // ── Schelling settlement payouts ─────────────────────────────────────

    function _settleHashMatchSellerWins(bytes32 intentId, Intent storage it) private {
        // Buyer false-rejected. Seller gets price + own stake refunded + 90 % of
        // buyer stake; platform gets 10 % of buyer stake + price fee.
        it.status = IntentStatus.SettledSchelling;

        (uint256 sellerShare, uint256 priceFee) =
            StreamingEngine.unitPayout(it.maxPrice, platformFeeBps);

        uint256 buyerStakeToSeller = (it.buyerStake * 9000) / 10000;
        uint256 buyerStakeToPlatform = it.buyerStake - buyerStakeToSeller;

        // Seller payout = price minus its 10% fee + own stake back + 90% of buyer stake
        require(
            usdc.transfer(it.acceptedSeller, sellerShare + it.sellerStake + buyerStakeToSeller),
            "Escrow: seller payout failed"
        );
        uint256 platformOut = priceFee + buyerStakeToPlatform;
        if (platformOut > 0) {
            require(usdc.transfer(platformWallet, platformOut), "Escrow: platform xfer failed");
        }
        emit ClassBSettled(intentId, SchellingCommitReveal.Outcome.SellerWins_HashMatch);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    function _settleHashMismatchBothBurn(bytes32 intentId, Intent storage it) private {
        // Genuine disagreement: both stakes burn; buyer refunded original price.
        it.status = IntentStatus.SettledSchelling;

        uint256 totalBurn = it.buyerStake + it.sellerStake;
        require(usdc.transfer(it.buyer, it.maxPrice), "Escrow: buyer refund failed");
        if (totalBurn > 0) {
            require(usdc.transfer(burnTo, totalBurn), "Escrow: burn xfer failed");
        }
        emit ClassBSettled(intentId, SchellingCommitReveal.Outcome.BothBurn_HashMismatch);
        emit StakesBurned(intentId, totalBurn, it.maxPrice);
    }

    function _settleBuyerDefault(
        bytes32 intentId,
        Intent storage it,
        SchellingCommitReveal.Outcome outcome
    ) private {
        // Buyer defaulted → buyer stake burns; seller paid in full + own stake back.
        it.status = IntentStatus.SettledSchelling;
        (uint256 sellerShare, uint256 platformShare) =
            StreamingEngine.unitPayout(it.maxPrice, platformFeeBps);

        require(
            usdc.transfer(it.acceptedSeller, sellerShare + it.sellerStake),
            "Escrow: seller payout failed"
        );
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

    function _settleSellerDefault(
        bytes32 intentId,
        Intent storage it,
        SchellingCommitReveal.Outcome outcome
    ) private {
        // Seller defaulted → seller stake burns; buyer refunded price + own stake.
        it.status = IntentStatus.SettledSchelling;
        require(usdc.transfer(it.buyer, it.maxPrice + it.buyerStake), "Escrow: buyer refund failed");
        if (it.sellerStake > 0) {
            require(usdc.transfer(burnTo, it.sellerStake), "Escrow: burn xfer failed");
        }
        emit ClassBSettled(intentId, outcome);
        emit StakesBurned(intentId, it.sellerStake, it.maxPrice + it.buyerStake);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Class C — streaming / per-unit
    // ─────────────────────────────────────────────────────────────────────

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
        // 0.8.x guards overflow on `*`; explicit check keeps the revert reason
        // friendly and predictable when callers supply silly inputs.
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

    /**
     * @notice Seller claims a single unit by presenting its witness.
     * @param unitIndex MUST equal `unitsClaimed` (strict monotonic).
     */
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

        // Bind the seller on first unit. After that, only that seller may claim.
        if (it.acceptedSeller == address(0)) {
            it.acceptedSeller = msg.sender;
        } else {
            require(it.acceptedSeller == msg.sender, "Escrow: stream owned by another seller");
        }

        // Verify
        bytes memory params = predicateParams[intentId];
        bool ok = IPredicateVerifier(it.verifier).verify(params, ciphertext, witness);
        require(ok, "Escrow: predicate failed");

        // Effects
        it.unitsClaimed = unitIndex + 1;
        (uint256 sellerShare, uint256 platformShare) =
            StreamingEngine.unitPayout(it.perUnitPrice, platformFeeBps);

        // Interactions
        require(usdc.transfer(msg.sender, sellerShare), "Escrow: seller xfer failed");
        if (platformShare > 0) {
            require(usdc.transfer(platformWallet, platformShare), "Escrow: platform xfer failed");
        }
        emit StreamingUnitClaimed(intentId, unitIndex, msg.sender, sellerShare, platformShare);
        emit KeyDeliveryRequested(intentId, it.buyer);
    }

    /// @notice Either party cancels a streaming intent. Unused balance refunds to buyer.
    function cancelStream(bytes32 intentId) external nonReentrant {
        Intent storage it = _intents[intentId];
        require(it.status == IntentStatus.Streaming, "Escrow: not streaming");
        require(
            msg.sender == it.buyer || msg.sender == it.acceptedSeller,
            "Escrow: not party"
        );

        // Effects
        it.status = IntentStatus.StreamCancelled;
        uint256 refund = StreamingEngine.cancelRefund(it.lockedTotal, it.unitsClaimed, it.perUnitPrice);

        // Interactions
        if (refund > 0) {
            require(usdc.transfer(it.buyer, refund), "Escrow: refund failed");
        }
        emit StreamCancelled(intentId, msg.sender, refund);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Derive a deterministic intent id from the inputs + a per-buyer
     *         nonce defeating accidental collisions.
     * @dev We use `block.number` + `block.prevrandao` as cheap salt; with
     *      `msg.sender` and `expiresAt` baked in, two intents from the same
     *      buyer in the same block with identical other inputs would still
     *      collide — but the `_intents[id].status == None` check catches that
     *      explicitly with a `dup intent` revert.
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
