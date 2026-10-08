// ed25519 signing + verification of apr-1 receipts (node:crypto only).
//
// The signature covers the canonical payload BYTES (JCS), not the hash string,
// so a verifier that recomputes the hash and a verifier that checks the
// signature are checking the same thing two independent ways.
//
// Key material: RECEIPT_SIGNING_KEY is a base64 32-byte ed25519 seed. Public
// keys are published by key id; rotation adds a new id and never removes an
// old one, so every receipt ever issued stays verifiable.

import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize, payloadHash } from "./canonical.js";
import { RECEIPT_VERSION, type ReceiptPayload } from "./payload.js";

// DER prefixes for raw ed25519 keys (RFC 8410): PKCS#8 private, SPKI public.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ReceiptSigner {
  keyId: string;
  /** base64 raw 32-byte ed25519 public key */
  publicKey: string;
  sign(message: Uint8Array): string;
}

export interface SignedReceipt {
  version: typeof RECEIPT_VERSION;
  key_id: string;
  payload: ReceiptPayload;
  /** sha256(JCS(payload)), lowercase hex */
  payload_hash: string;
  /** base64 ed25519 signature over the JCS(payload) bytes */
  signature: string;
}

/** Published key set: key id -> base64 raw public key. */
export type ReceiptKeySet = Record<string, string>;

function seedBytes(seedB64: string): Buffer {
  const seed = Buffer.from(seedB64 ?? "", "base64");
  // Buffer.from silently drops invalid base64 characters, so re-encode and
  // compare: a seed that does not round-trip is a typo, not a key.
  if (seed.length !== 32 || seed.toString("base64").replace(/=+$/, "") !== String(seedB64).trim().replace(/=+$/, "")) {
    throw new Error("RECEIPT_SIGNING_KEY must be a base64-encoded 32 bytes ed25519 seed");
  }
  return seed;
}

function privateKeyFromSeed(seedB64: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seedBytes(seedB64)]), format: "der", type: "pkcs8" });
}

function publicKeyObject(publicKeyB64: string): KeyObject {
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

/** base64 raw public key for a base64 seed. */
export function publicKeyFromSeed(seedB64: string): string {
  const spki = createPublicKey(privateKeyFromSeed(seedB64)).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(SPKI_ED25519_PREFIX.length)).toString("base64");
}

/** A fresh random seed (tests, key generation). */
export function generateSeed(): string {
  return randomBytes(32).toString("base64");
}

export function signerFromSeed(seedB64: string, keyId: string): ReceiptSigner {
  if (!keyId || !/^[A-Za-z0-9._:-]{1,64}$/.test(keyId)) {
    throw new Error("RECEIPT_KEY_ID must be a non-empty key id ([A-Za-z0-9._:-], max 64)");
  }
  const key = privateKeyFromSeed(seedB64);
  return {
    keyId,
    publicKey: publicKeyFromSeed(seedB64),
    sign: (message) => sign(null, message, key).toString("base64"),
  };
}

export function signReceipt(payload: ReceiptPayload, signer: ReceiptSigner): SignedReceipt {
  const bytes = Buffer.from(canonicalize(payload), "utf8");
  return {
    version: RECEIPT_VERSION,
    key_id: signer.keyId,
    payload,
    payload_hash: payloadHash(payload),
    signature: signer.sign(bytes),
  };
}

export interface ReceiptVerification {
  valid: boolean;
  checks: { hash: boolean; key_known: boolean; signature: boolean };
  errors: string[];
}

/**
 * Verify hash + signature. Never throws on hostile input: a verifier that can
 * be crashed by a malformed receipt is a verifier nobody can call publicly.
 */
export function verifyReceipt(receipt: SignedReceipt, keys: ReceiptKeySet): ReceiptVerification {
  const checks = { hash: false, key_known: false, signature: false };
  const errors: string[] = [];
  if (!receipt || typeof receipt !== "object" || !receipt.payload || typeof receipt.payload !== "object") {
    return { valid: false, checks, errors: ["receipt.payload missing"] };
  }
  if (receipt.version !== RECEIPT_VERSION) errors.push(`unsupported version ${String(receipt.version)}`);

  let bytes: Buffer;
  try {
    bytes = Buffer.from(canonicalize(receipt.payload), "utf8");
  } catch (err) {
    return { valid: false, checks, errors: [`payload not canonicalizable: ${(err as Error).message}`] };
  }

  checks.hash = typeof receipt.payload_hash === "string" && payloadHash(receipt.payload) === receipt.payload_hash.toLowerCase();
  if (!checks.hash) errors.push("payload_hash does not match sha256(JCS(payload))");

  const pub = typeof receipt.key_id === "string" && Object.prototype.hasOwnProperty.call(keys, receipt.key_id)
    ? keys[receipt.key_id]
    : undefined;
  checks.key_known = Boolean(pub);
  if (!pub) {
    errors.push(`unknown key_id ${String(receipt.key_id)}`);
  } else {
    try {
      const sig = Buffer.from(String(receipt.signature ?? ""), "base64");
      checks.signature = sig.length === 64 && verify(null, bytes, publicKeyObject(pub), sig);
    } catch {
      checks.signature = false;
    }
    if (!checks.signature) errors.push("signature does not verify for key_id");
  }

  return { valid: errors.length === 0 && checks.hash && checks.key_known && checks.signature, checks, errors };
}
