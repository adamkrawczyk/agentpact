// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title StreamingEngine
 * @notice Library implementing Class C streaming / per-unit settlement math.
 *
 * @dev Per AgentPact v2 § 1 Class C specification:
 *      - Buyer locks `maxTotal = perUnitPrice * maxUnits` at intent creation.
 *      - Each unit submits a witness against a Class A verifier (typically
 *        `HashPreimagePredicate`). The escrow verifies the witness and, if it
 *        passes, immediately pays out for that single unit.
 *      - Buyer or seller may cancel; consumed units final; unused balance
 *        refunded to buyer.
 *
 * @dev Library is stateless/pure. The escrow owns the per-intent unit counter
 *      and the cumulative-claimed accounting; this library exposes the
 *      payout math and an idempotent unit-index check helper.
 */
library StreamingEngine {
    /**
     * @notice Compute per-unit payout split: seller share + platform share.
     * @param perUnitPriceUsdc6  Per-unit price in USDC 6-decimal units.
     * @param platformFeeBps     Platform fee in basis points (1000 = 10%).
     *                           Constrained by escrow constructor: 0..10000.
     * @return sellerShare       USDC paid to seller for this unit.
     * @return platformShare     USDC paid to platform fee wallet for this unit.
     *
     * @dev Rounding: integer division floors. If the per-unit price is too small
     *      relative to the fee (e.g. perUnitPrice = 5 with 10% fee), the
     *      platform share rounds to 0 and the seller gets the full unit. This
     *      is acceptable for the 6-decimal-USDC unit-size we expect (per-unit
     *      minimum should be ≥ $0.001 = 1000 6-decimal units, well above the
     *      rounding-loss threshold).
     */
    function unitPayout(uint256 perUnitPriceUsdc6, uint256 platformFeeBps)
        internal
        pure
        returns (uint256 sellerShare, uint256 platformShare)
    {
        platformShare = (perUnitPriceUsdc6 * platformFeeBps) / 10000;
        sellerShare = perUnitPriceUsdc6 - platformShare;
    }

    /**
     * @notice Validate that a unit-index claim is monotonic and within bounds.
     * @dev The escrow stores `unitsClaimed` per streaming intent. This helper
     *      enforces the dispatcher contract:
     *        - The next unit index must equal `unitsClaimed` (strict monotonic;
     *          no out-of-order claims, no skipped units).
     *        - The claim must not exceed `maxUnits`.
     *      Reverts with explicit reasons so the relayer can surface errors.
     */
    function checkUnitOrder(
        uint256 claimedUnitIndex,
        uint256 unitsAlreadyClaimed,
        uint256 maxUnits
    ) internal pure {
        require(claimedUnitIndex == unitsAlreadyClaimed, "StreamingEngine: bad unit index");
        require(claimedUnitIndex < maxUnits, "StreamingEngine: max units reached");
    }

    /**
     * @notice Compute refund on stream cancellation.
     * @dev `lockedTotal` is the buyer's original full-stream lock.
     *      `unitsClaimed * perUnitPrice` is the cumulative consumed-and-paid amount.
     *      Refund is the unconsumed remainder. Math underflow is impossible because
     *      the escrow strictly maintains `unitsClaimed <= maxUnits` and
     *      `unitsClaimed * perUnitPrice <= maxUnits * perUnitPrice == lockedTotal`.
     */
    function cancelRefund(
        uint256 lockedTotal,
        uint256 unitsClaimed,
        uint256 perUnitPriceUsdc6
    ) internal pure returns (uint256 refundToBuyer) {
        uint256 consumed = unitsClaimed * perUnitPriceUsdc6;
        refundToBuyer = lockedTotal - consumed;
    }
}
