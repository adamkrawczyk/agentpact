// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SchellingCommitReveal
 * @notice Library implementing the Class B subjective-deliverable subprotocol.
 *
 * @dev Per AgentPact v2 § 1 Class B specification:
 *      - Buyer stakes 10% extra at intent creation; seller stakes 50% at accept
 *        (capped by escrow at `min(maxPrice / 2, 50 USDC)` to defeat micro-intent
 *        griefing).
 *      - Buyer may `acknowledge()` within a deal-size-scaled window. Non-action
 *        equals acknowledgment (a relayer-driven sweeper calls `acknowledgeTimeout`).
 *      - On `reject(commitHash)` the protocol enters a TWO-ROUND commit-reveal:
 *          Round 1 (24h): both parties post `keccak256(observedDeliverable || salt)`.
 *          Round 2 (24h): both parties post `(observedDeliverable, salt)`.
 *      - Outcomes:
 *          hashes-match     → buyer false-rejected. Buyer stake burned; seller
 *                             paid in full + own stake returned + 90% of buyer's
 *                             stake to seller / 10% to platform.
 *          hashes-mismatch  → genuine disagreement. BOTH stakes burned to dEaD;
 *                             original `price` refunded to buyer; seller paid 0.
 *          one-side-default → defaulting party's stake burned; non-defaulting
 *                             party made whole.
 *
 * @dev This library is `internal pure` — it holds no state and does no transfers.
 *      The calling escrow contract owns the storage and the USDC movements. The
 *      library decides outcomes given inputs; the escrow applies them.
 */
library SchellingCommitReveal {
    enum Phase {
        None,
        AwaitingAck,         // seller delivered; buyer's ack window is open
        Round1Commit,        // buyer rejected; both parties must commit hashes
        Round2Reveal,        // both committed; both parties must reveal preimages
        Settled              // outcome computed and applied by escrow
    }

    enum Outcome {
        Pending,
        // Acknowledged or auto-acknowledged: seller paid in full, stakes returned.
        AckSellerWins,
        // Rejection adjudicated: hashes matched → seller wins; buyer false-rejected.
        SellerWins_HashMatch,
        // Rejection adjudicated: hashes mismatched → genuine disagreement; both burn.
        BothBurn_HashMismatch,
        // One side defaulted in round 1 (didn't commit) — outcome favors non-defaulter.
        BuyerDefaulted_Round1,
        SellerDefaulted_Round1,
        // One side defaulted in round 2 (didn't reveal) — outcome favors non-defaulter.
        BuyerDefaulted_Round2,
        SellerDefaulted_Round2
    }

    /**
     * @notice Compute the bounded ack window for a Class B deal.
     * @dev Per § 1 Class B step 4: deal-size-scaled buyer ack window —
     *      10 min for ≤ $10, 1 h for ≤ $100, 24 h above.
     *      Inputs in USDC 6-decimal units.
     */
    function ackWindowSeconds(uint256 maxPriceUsdc6) internal pure returns (uint64) {
        if (maxPriceUsdc6 <= 10_000_000) return 10 minutes;     // ≤ $10
        if (maxPriceUsdc6 <= 100_000_000) return 1 hours;       // ≤ $100
        return 24 hours;                                        // > $100
    }

    /**
     * @notice The seller stake cap, on-chain, in USDC 6-decimal units.
     * @dev Per § 2.2 IAgentPactEscrowV2 acceptIntentB() contract:
     *        seller_stake <= min(maxPrice / 2, 50 USDC)
     *      Returns the max allowed seller stake for the given maxPrice.
     */
    function sellerStakeCap(uint256 maxPriceUsdc6) internal pure returns (uint256) {
        uint256 half = maxPriceUsdc6 / 2;
        uint256 absolute = 50_000_000; // 50 USDC, 6-decimal
        return half < absolute ? half : absolute;
    }

    /**
     * @notice Compare two reveals.
     * @return true iff buyer and seller revealed identical (deliverable, salt) tuples
     *         that ALSO hash to their original commitments.
     */
    function revealsMatch(
        bytes memory buyerDeliverable,
        bytes32 buyerSalt,
        bytes32 buyerCommit,
        bytes memory sellerDeliverable,
        bytes32 sellerSalt,
        bytes32 sellerCommit
    ) internal pure returns (bool) {
        // Each side's reveal MUST hash to its committed value or the reveal is
        // rejected upstream (the escrow asserts this at revealRound2-time).
        // We re-verify here defensively; cheap.
        if (keccak256(abi.encodePacked(buyerDeliverable, buyerSalt)) != buyerCommit) return false;
        if (keccak256(abi.encodePacked(sellerDeliverable, sellerSalt)) != sellerCommit) return false;

        // Hashes match iff the canonical observed-deliverable bytes are identical.
        return keccak256(buyerDeliverable) == keccak256(sellerDeliverable);
    }
}
