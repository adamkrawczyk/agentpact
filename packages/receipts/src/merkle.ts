// RFC 6962 / RFC 9162 Merkle tree over receipt payload hashes.
//
// Domain-separated hashing (leaf = H(0x00 || d), node = H(0x01 || l || r))
// so an interior node can never be passed off as a leaf (second-preimage), and
// the tree shape for n leaves is the RFC's "largest power of two smaller than
// n" split, so any RFC 6962 verifier can check our proofs without our code.
//
// Leaves are the 32-byte payload hashes, in the batch's leaf order.

import { createHash } from "node:crypto";

export interface MerkleProof {
  index: number;
  leaf_count: number;
  /** audit path, leaf-to-root order, lowercase hex */
  siblings: string[];
}

const HEX32 = /^[0-9a-f]{64}$/;

function bytes(hex: string): Buffer {
  const h = String(hex).toLowerCase();
  if (!HEX32.test(h)) throw new Error(`merkle: expected 32-byte lowercase hex, got ${JSON.stringify(hex)}`);
  return Buffer.from(h, "hex");
}

function leafHash(leaf: Buffer): Buffer {
  return createHash("sha256").update(Buffer.from([0])).update(leaf).digest();
}

function nodeHash(l: Buffer, r: Buffer): Buffer {
  return createHash("sha256").update(Buffer.from([1])).update(l).update(r).digest();
}

function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function mth(leaves: Buffer[]): Buffer {
  if (leaves.length === 1) return leafHash(leaves[0]);
  const k = splitPoint(leaves.length);
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

function path(m: number, leaves: Buffer[]): Buffer[] {
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  return m < k
    ? [...path(m, leaves.slice(0, k)), mth(leaves.slice(k))]
    : [...path(m - k, leaves.slice(k)), mth(leaves.slice(0, k))];
}

export function merkleRoot(leavesHex: string[]): string {
  if (leavesHex.length === 0) throw new Error("merkle: empty tree has no root");
  return mth(leavesHex.map(bytes)).toString("hex");
}

export function merkleProof(leavesHex: string[], index: number): MerkleProof {
  if (!Number.isInteger(index) || index < 0 || index >= leavesHex.length) {
    throw new Error(`merkle: index ${index} out of range for ${leavesHex.length} leaves`);
  }
  return {
    index,
    leaf_count: leavesHex.length,
    siblings: path(index, leavesHex.map(bytes)).map((b) => b.toString("hex")),
  };
}

/** RFC 9162 §2.1.3.2 inclusion-proof verification. Never throws. */
export function verifyMerkleProof(leafHex: string, proof: MerkleProof, rootHex: string): boolean {
  try {
    const { index, leaf_count: n, siblings } = proof;
    if (!Number.isInteger(index) || !Number.isInteger(n) || index < 0 || index >= n || !Array.isArray(siblings)) return false;
    let fn = index;
    let sn = n - 1;
    let r = leafHash(bytes(leafHex));
    for (const s of siblings) {
      const p = bytes(s);
      if (sn === 0) return false;
      if (fn % 2 === 1 || fn === sn) {
        r = nodeHash(p, r);
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      } else {
        r = nodeHash(r, p);
      }
      fn = Math.floor(fn / 2);
      sn = Math.floor(sn / 2);
    }
    return sn === 0 && r.equals(bytes(rootHex));
  } catch {
    return false;
  }
}
