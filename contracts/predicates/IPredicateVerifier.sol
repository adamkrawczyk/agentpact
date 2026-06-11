// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPredicateVerifier
 * @notice Verifier contract for Class A (cryptographically verifiable) settlement.
 *
 * @dev A verifier is a pure, stateless contract that decides whether a seller-provided
 *      witness `W` proves that ciphertext `C` (when decrypted with key `K`) satisfies
 *      a predicate parameterised by `params` (set at intent creation).
 *
 *      Verifier contracts MUST be:
 *        - pure (no external state reads beyond their own immutables)
 *        - deterministic
 *        - bounded in gas (no unbounded loops over user-supplied data)
 *        - re-entrancy safe by construction (they perform no transfers)
 *
 *      Verifiers are registered in {PredicateRegistry} at deploy time. The escrow
 *      contract dispatches by reading the verifier address from the intent's
 *      `predicateHash` (which commits to `verifier || params`).
 *
 *      Predicate semantics overview (each implementation file documents its own
 *      `params` and `witness` ABI):
 *        - HashPreimagePredicate:    keccak256(decrypt(C, K)) == commitment
 *        - SignedBlobPredicate:      ECDSA.recover(decrypt(C, K), sig) == issuerKey
 *        - MerkleMembershipPredicate: decrypted blob is a leaf in `merkleRoot`
 *
 *      For a Class A claim to release escrow, `verify(...)` must return `true`
 *      under the buyer's chosen `(verifier, params, ciphertext, witness)` tuple.
 *      A revert is treated as a failed verification by the caller (escrow).
 */
interface IPredicateVerifier {
    /**
     * @notice Verify that `ciphertext` (paired with off-chain witness `witness`)
     *         satisfies the predicate encoded in `params`.
     *
     * @param params      ABI-encoded predicate-specific parameters frozen at intent
     *                    creation. Together with the verifier address, the
     *                    keccak256 hash of these bytes is the `predicateHash` stored
     *                    on-chain. Mutating them after intent creation is
     *                    impossible (the hash would change).
     * @param ciphertext  The seller's ciphertext blob. Verifiers may inspect bytes
     *                    of the ciphertext directly OR ignore it entirely depending
     *                    on the predicate semantics.
     * @param witness     Verifier-specific proof bytes (e.g. a signature, a Merkle
     *                    path, a hash preimage). Decoded inside the verifier.
     *
     * @return ok         `true` iff the predicate is satisfied. Verifiers MUST NOT
     *                    return `false` when the inputs are malformed — they MUST
     *                    revert in that case. A `false` return is reserved for
     *                    well-formed-but-failing proofs.
     */
    function verify(
        bytes calldata params,
        bytes calldata ciphertext,
        bytes calldata witness
    ) external view returns (bool ok);

    /**
     * @notice Human-readable identifier for this verifier ("hash-preimage-v1",
     *         "signed-blob-v1", "merkle-membership-v1"). Used in events and
     *         off-chain telemetry; not consulted on the verification path.
     */
    function predicateId() external view returns (string memory);
}
