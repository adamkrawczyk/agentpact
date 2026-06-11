// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IPredicateVerifier.sol";

/**
 * @title HashPreimagePredicate
 * @notice Class A verifier: settlement releases iff `keccak256(plaintext) == commitment`.
 *
 * @dev Use this verifier when the buyer knows the EXPECTED hash of the deliverable
 *      up-front. Example: "deliver the file whose contents hash to 0xabc…".
 *
 *      params  ABI: `bytes32 commitment` — the expected keccak256 hash of the
 *                   plaintext that the ciphertext will decrypt to.
 *      witness ABI: `bytes plaintext`    — the seller's claimed plaintext. The
 *                   verifier hashes it and compares to `commitment`.
 *
 *      The verifier does NOT inspect `ciphertext` directly. The contractual
 *      promise is: when the buyer obtains the symmetric key `K` (via the
 *      escrow's KeyDelivered event), `decrypt(ciphertext, K)` MUST equal
 *      the `plaintext` the seller supplied as the witness. The key-release
 *      mechanism (server-custodial in v2.0, adaptor-signature atomic in v2.3)
 *      ensures the seller cannot release ciphertext that decrypts differently.
 *
 *      Gas profile: O(plaintext length) — one keccak256 over the witness.
 *      No unbounded loops, no external calls, no state reads beyond params.
 *
 *      Re-entrancy: `view` function; no state writes; safe by construction.
 */
contract HashPreimagePredicate is IPredicateVerifier {
    /// @inheritdoc IPredicateVerifier
    function predicateId() external pure override returns (string memory) {
        return "hash-preimage-v1";
    }

    /// @inheritdoc IPredicateVerifier
    function verify(
        bytes calldata params,
        bytes calldata /* ciphertext */,
        bytes calldata witness
    ) external pure override returns (bool ok) {
        // Strict ABI decode: params MUST be exactly one bytes32.
        // Reverts on length mismatch — see IPredicateVerifier docstring contract:
        // malformed inputs revert, well-formed-but-failing inputs return false.
        if (params.length != 32) revert("HashPreimagePredicate: bad params length");

        bytes32 commitment = abi.decode(params, (bytes32));
        bytes32 actual = keccak256(witness);
        return actual == commitment;
    }
}
