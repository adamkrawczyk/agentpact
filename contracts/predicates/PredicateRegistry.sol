// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IPredicateVerifier.sol";

/**
 * @title PredicateRegistry
 * @notice Immutable allowlist of Class A predicate verifiers approved at deploy time.
 *
 * @dev Per AgentPact v2 § 13.3 governance decision (codename `settlement protocol`):
 *      the registry is IMMUTABLE in v2.0. No `add()`, no `remove()`, no admin.
 *      The allowed verifier set is fixed at constructor time. To add a new
 *      predicate, deploy a new escrow contract (v2.1, v2.2, …) pointing at a
 *      fresh registry — same versioned-series pattern as Uniswap v2/v3/v4.
 *
 *      Trade-off: less flexibility, more redeploys. Benefit: zero governance
 *      attack surface, no signer bus-factor problem, no "who approves new
 *      verifiers" question. Worth it for the multi-year-unattended posture.
 *
 *      The registry stores verifier addresses + their `predicateId()` strings.
 *      Callers (the escrow contract) check membership via `isApproved()` before
 *      dispatching a Class A verify call. The constructor de-duplicates by
 *      reverting on repeated addresses.
 *
 *      Storage: a packed list of approved verifiers + a quick-lookup mapping.
 *      Gas: O(1) membership check via `_approved` mapping.
 */
contract PredicateRegistry {
    // verifier address -> approved (true if in the set)
    mapping(address => bool) private _approved;

    // ordered list for off-chain enumeration; never mutated post-deploy
    address[] private _verifiers;

    event VerifierRegistered(address indexed verifier, string predicateId);

    /**
     * @param initialVerifiers Non-empty list of {IPredicateVerifier}-compatible
     *                         contract addresses. Duplicates revert. Zero
     *                         addresses revert. Each address MUST point at a
     *                         contract that implements `predicateId()` (used
     *                         purely for event emission / observability).
     */
    constructor(address[] memory initialVerifiers) {
        require(initialVerifiers.length > 0, "PredicateRegistry: empty");
        for (uint256 i = 0; i < initialVerifiers.length; i++) {
            address v = initialVerifiers[i];
            require(v != address(0), "PredicateRegistry: zero address");
            require(!_approved[v], "PredicateRegistry: duplicate");
            _approved[v] = true;
            _verifiers.push(v);

            // External call into the verifier to record its self-declared
            // predicateId in the event log. This is observability-only — the
            // verify() path never reads the id. If the call reverts the entire
            // constructor reverts, which is the desired behaviour (we won't
            // ship a registry pointing at a non-conformant verifier).
            string memory id = IPredicateVerifier(v).predicateId();
            emit VerifierRegistered(v, id);
        }
    }

    /// @notice O(1) membership check used by the escrow contract.
    function isApproved(address verifier) external view returns (bool) {
        return _approved[verifier];
    }

    /// @notice Total number of approved verifiers (frozen at deploy).
    function verifierCount() external view returns (uint256) {
        return _verifiers.length;
    }

    /// @notice Enumerate approved verifiers by index (off-chain UX).
    function verifierAt(uint256 index) external view returns (address) {
        return _verifiers[index];
    }
}
