// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./IPredicateVerifier.sol";

/**
 * @title MerkleMembershipPredicate
 * @notice Class A verifier: settlement releases iff the witness proves the
 *         delivered plaintext is a leaf in a buyer-pinned Merkle root.
 *
 * @dev Use this verifier for "deliver any file in commit X of repo Y" or
 *      "any skill in catalog snapshot Z" — the buyer commits to a SET of
 *      acceptable deliverables (the Merkle leaves) at intent creation; the
 *      seller proves their specific deliverable is a member of that set.
 *
 *      params  ABI: `bytes32 merkleRoot` — the root of a Merkle tree of all
 *                   acceptable plaintext leaves. Leaf hash convention:
 *                   `keccak256(abi.encodePacked(plaintext))` — matches the
 *                   default OpenZeppelin MerkleProof convention and is what
 *                   off-chain tooling like `merkletreejs` produces by default.
 *      witness ABI: `(bytes plaintext, bytes32[] proof)` — the seller's claimed
 *                   plaintext + the Merkle inclusion proof against the root.
 *
 *      Tooling note (for off-chain catalog publishers): use sorted-pair leaves
 *      when constructing the tree (OpenZeppelin convention). Otherwise the
 *      proof will not verify here. See `references/merkle-tree-construction.md`
 *      in the SDK package for a worked example.
 *
 *      Re-entrancy: `view` function; no state writes; safe by construction.
 *      Gas profile: O(log N) where N = tree size. ~50 gas per proof step.
 *
 *      OpenZeppelin MerkleProof.verify returns false on length mismatch (it
 *      does not revert on malformed proof depth), so the verifier itself
 *      returns false for bad proofs — consistent with the IPredicateVerifier
 *      contract because length-of-proof is not "malformed input" (any number
 *      of proof elements is structurally well-formed; it just may not match
 *      the root).
 */
contract MerkleMembershipPredicate is IPredicateVerifier {
    /// @inheritdoc IPredicateVerifier
    function predicateId() external pure override returns (string memory) {
        return "merkle-membership-v1";
    }

    /// @inheritdoc IPredicateVerifier
    function verify(
        bytes calldata params,
        bytes calldata /* ciphertext */,
        bytes calldata witness
    ) external pure override returns (bool ok) {
        if (params.length != 32) revert("MerkleMembershipPredicate: bad params length");
        bytes32 merkleRoot = abi.decode(params, (bytes32));

        (bytes memory plaintext, bytes32[] memory proof) = abi.decode(
            witness,
            (bytes, bytes32[])
        );

        bytes32 leaf = keccak256(abi.encodePacked(plaintext));
        return MerkleProof.verify(proof, merkleRoot, leaf);
    }
}
