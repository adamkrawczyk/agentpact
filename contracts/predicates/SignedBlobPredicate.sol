// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./IPredicateVerifier.sol";

/**
 * @title SignedBlobPredicate
 * @notice Class A verifier: settlement releases iff the witness contains a valid
 *         secp256k1 signature over the plaintext by a buyer-specified issuer.
 *
 * @dev Use this verifier for "deliver a credential signed by issuer X" deals —
 *      API keys, bearer tokens, attestations, license keys, etc. The signature
 *      is by an off-chain issuer; the buyer trusts the issuer's pubkey but does
 *      NOT trust the seller. The verifier checks the seller's claimed plaintext
 *      was actually signed by the issuer.
 *
 *      params  ABI: `(address issuer, bytes32 domainTag)` — the expected ECDSA
 *                   signer address and a domain-separation tag the issuer used
 *                   when signing (prevents cross-context replay).
 *      witness ABI: `(bytes plaintext, bytes signature)` — seller's claimed
 *                   plaintext + 65-byte ECDSA signature `(r, s, v)` over
 *                   `keccak256(abi.encodePacked(domainTag, plaintext))`.
 *
 *      The domainTag is critical: if the issuer signs raw `keccak256(plaintext)`
 *      without a tag, a signature minted for context A could be replayed in
 *      context B. Forcing the tag inside the hash binds the signature to the
 *      specific buy.
 *
 *      Like {HashPreimagePredicate}, this verifier does NOT inspect ciphertext;
 *      the symmetric-key release path (escrow KeyDelivered) ensures the
 *      plaintext-the-buyer-eventually-decrypts equals the plaintext-that-was-signed.
 *
 *      Re-entrancy: `view` function; no state writes; safe by construction.
 *      Gas profile: O(plaintext length) + 1 ECDSA recovery (~3000 gas).
 *
 *      ECDSA.recover (OZ 5.4) reverts on malformed signatures (length != 65,
 *      `s` in upper half order, `v` not 27/28). That's the desired contract:
 *      malformed → revert; valid-but-mismatched-signer → return false.
 */
contract SignedBlobPredicate is IPredicateVerifier {
    using ECDSA for bytes32;

    /// @inheritdoc IPredicateVerifier
    function predicateId() external pure override returns (string memory) {
        return "signed-blob-v1";
    }

    /// @inheritdoc IPredicateVerifier
    function verify(
        bytes calldata params,
        bytes calldata /* ciphertext */,
        bytes calldata witness
    ) external pure override returns (bool ok) {
        (address issuer, bytes32 domainTag) = abi.decode(params, (address, bytes32));
        if (issuer == address(0)) revert("SignedBlobPredicate: zero issuer");

        (bytes memory plaintext, bytes memory signature) = abi.decode(
            witness,
            (bytes, bytes)
        );

        bytes32 digest = keccak256(abi.encodePacked(domainTag, plaintext));

        // ECDSA.recover reverts on malformed sig; that's the documented contract.
        address recovered = digest.recover(signature);
        return recovered == issuer;
    }
}
