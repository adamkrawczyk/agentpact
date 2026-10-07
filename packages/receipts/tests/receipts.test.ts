/**
 * @agentpact/receipts — pure tests, no DB, no network.
 *
 * What these pin:
 *   - RFC 8785 canonical JSON (key order, escaping, number rules)
 *   - builder determinism: same facts -> byte-identical payload + hash
 *   - signature verify + tamper detection on EVERY payload field
 *   - key rotation: a receipt signed by a retired key id still verifies
 *   - outcome mapping for every terminal path, and "no receipt" for the rest
 *   - RFC 6962 Merkle root + audit-path proofs for every leaf of many sizes
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RECEIPT_VERSION,
  buildReceiptPayload,
  canonicalize,
  classifyOutcome,
  decimalToBaseUnits,
  generateSeed,
  merkleProof,
  merkleRoot,
  payloadHash,
  publicKeyFromSeed,
  signReceipt,
  signerFromSeed,
  verifyMerkleProof,
  verifyReceipt,
  type OutcomeFacts,
  type ReceiptFacts,
} from "../src/index.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function facts(over: Partial<ReceiptFacts> = {}): ReceiptFacts {
  return {
    deal_id: "11111111-1111-4111-8111-111111111111",
    deal_status: "completed",
    currency: "USDC",
    payer: { agent_id: "aaaaaaaa-0000-4000-8000-000000000001", handle: "buyer-bot", owner_wallet_key: "0x" + "a".repeat(40) },
    payee: { agent_id: "bbbbbbbb-0000-4000-8000-000000000002", handle: "seller-bot", owner_wallet_key: "0x" + "b".repeat(40) },
    notional_base_units: "5000000",
    ledger_fee_base_units: "500000",
    ledger_fee_pct_at_close: "10.00",
    funding_chain: "base",
    funding_tx_hashes: ["0x" + "2".repeat(64), "0x" + "1".repeat(64)],
    settlement_tx_hashes: ["0x" + "3".repeat(64)],
    acceptance: { source: "milestones", criteria: [{ milestone: 0, criteria: ["CSV with 412 rows", "UTF-8"] }] },
    deliverable_hash: "0x" + "d".repeat(64),
    delivery_checksum: "sha256:" + "e".repeat(64),
    judge: { judge: "jev-1@classifier.dev", verdict: "complete", p: "0.91200", rubric_hash: "abc123", decided_at: "2026-10-01T10:00:00.000Z" },
    dispute: null,
    payment_intent_statuses: ["released"],
    intent: null,
    refund_transfer_completed: false,
    funded: true,
    qualifying: true,
    capital_at_risk: true,
    created_at: "2026-09-30T09:00:00.000Z",
    closed_at: "2026-10-01T10:05:00.000Z",
    ...over,
  };
}

describe("canonicalize (RFC 8785 JCS)", () => {
  it("sorts keys by UTF-16 code units, recursively, with no whitespace", () => {
    assert.equal(canonicalize({ b: 1, a: { d: [3, { z: null, y: true }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}');
    // RFC 8785 §3.2.3 example ordering: code-unit order, not locale order.
    assert.equal(canonicalize({ "€": 1, "\r": 2, "1": 3, "ö": 4, "😀": 5 }), '{"\\r":2,"1":3,"ö":4,"€":1,"😀":5}');
  });

  it("escapes per JSON.stringify and serialises integers in shortest form", () => {
    assert.equal(canonicalize({ s: 'q"\\\n\u0001', n: -0, i: 1e21, f: 0.5 }), '{"f":0.5,"i":1e+21,"n":0,"s":"q\\"\\\\\\n\\u0001"}');
  });

  it("rejects values JSON cannot represent faithfully", () => {
    assert.throws(() => canonicalize({ x: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalize({ x: undefined }), /undefined/);
    assert.throws(() => canonicalize({ x: 10n }), /bigint/);
  });
});

describe("decimalToBaseUnits", () => {
  it("converts NUMERIC strings exactly (no float)", () => {
    assert.equal(decimalToBaseUnits("5"), "5000000");
    assert.equal(decimalToBaseUnits("0.000001"), "1");
    assert.equal(decimalToBaseUnits("12.345678"), "12345678");
    assert.equal(decimalToBaseUnits("1.10"), "1100000");
    // A float path would produce 4.35 * 1e6 = 4349999.999...
    assert.equal(decimalToBaseUnits("4.35"), "4350000");
    assert.equal(decimalToBaseUnits("0"), "0");
  });
  it("refuses sub-base-unit precision and garbage instead of rounding", () => {
    assert.throws(() => decimalToBaseUnits("1.0000001"), /precision/);
    assert.throws(() => decimalToBaseUnits("-1"), /decimal/);
    assert.throws(() => decimalToBaseUnits("1e3"), /decimal/);
  });
});

describe("buildReceiptPayload", () => {
  it("is deterministic: same facts -> byte-identical canonical payload and hash", () => {
    const a = buildReceiptPayload(facts());
    const b = buildReceiptPayload(facts({ funding_tx_hashes: ["0x" + "1".repeat(64), "0x" + "2".repeat(64)] }));
    assert.ok(a && b);
    assert.equal(canonicalize(a), canonicalize(b), "tx hash input order must not change the payload");
    assert.equal(payloadHash(a), payloadHash(b));
    assert.equal(payloadHash(a), sha(canonicalize(a)));
  });

  it("lowercases EVM tx hashes but keeps case-sensitive Solana signatures intact", () => {
    const sol = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    const p = buildReceiptPayload(facts({ funding_tx_hashes: ["0x" + "AB".repeat(32), sol] }))!;
    assert.deepEqual(p.funding.tx_hashes, ["0x" + "ab".repeat(32), sol]);
  });

  it("carries every field the receipt promises", () => {
    const p = buildReceiptPayload(facts())!;
    assert.equal(p.v, RECEIPT_VERSION);
    assert.equal(p.outcome, "settled");
    assert.deepEqual(p.payer, facts().payer);
    assert.deepEqual(p.amount, {
      currency: "USDC", decimals: 6, notional_base_units: "5000000",
      fee_base_units: "500000", fee_source: "ledger", fee_pct_at_close: "10.00",
    });
    assert.deepEqual(p.funding, { chain: "base", tx_hashes: ["0x" + "1".repeat(64), "0x" + "2".repeat(64)] });
    assert.equal(p.acceptance_test.source, "milestones");
    assert.equal(p.acceptance_test.sha256, sha(p.acceptance_test.criteria_text));
    assert.equal(p.artifact.deliverable_hash, "0x" + "d".repeat(64));
    assert.equal(p.judge?.verdict, "complete");
    assert.deepEqual(p.evidence, { qualifying: true, capital_at_risk: true });
  });

  it("never recomputes a fee: refunded deals record no fee charged, a settled deal without a ledger row says 'unrecorded'", () => {
    const refunded = buildReceiptPayload(facts({
      deal_status: "cancelled", payment_intent_statuses: ["refunded"], ledger_fee_base_units: null, ledger_fee_pct_at_close: null,
    }))!;
    assert.equal(refunded.outcome, "refunded");
    assert.equal(refunded.amount.fee_base_units, "0");
    assert.equal(refunded.amount.fee_source, "not_charged");
    const missing = buildReceiptPayload(facts({ ledger_fee_base_units: null, ledger_fee_pct_at_close: null }))!;
    assert.equal(missing.amount.fee_base_units, null);
    assert.equal(missing.amount.fee_source, "unrecorded");
  });

  it("returns null (no receipt) for an unfunded deal even if it is 'completed'", () => {
    assert.equal(buildReceiptPayload(facts({ funded: false, capital_at_risk: false })), null);
  });

  it("returns null for a funded deal that has not reached a terminal outcome", () => {
    assert.equal(buildReceiptPayload(facts({ deal_status: "delivered", payment_intent_statuses: ["funded"] })), null);
  });

  it("rejects a non-canonical timestamp instead of signing something ambiguous", () => {
    assert.throws(() => buildReceiptPayload(facts({ closed_at: "2026-10-01 10:05" })), /ISO/);
  });
});

describe("classifyOutcome — every terminal path", () => {
  const base: OutcomeFacts = {
    funded: true, deal_status: "completed", payment_intent_statuses: [], intent: null,
    disputed: false, refund_transfer_completed: false,
  };
  const cases: Array<[string, Partial<OutcomeFacts>, string | null]> = [
    ["completed + released", { payment_intent_statuses: ["released"] }, "settled"],
    ["completed via escrow intent claim", { deal_status: "completed", intent: { status: "claimed", expired: false } }, "settled"],
    ["cancelled + refunded", { deal_status: "cancelled", payment_intent_statuses: ["refunded"] }, "refunded"],
    ["completed after a dispute", { payment_intent_statuses: ["released"], disputed: true }, "disputed_seller_won"],
    ["cancelled + refunded after a dispute", { deal_status: "cancelled", payment_intent_statuses: ["refunded"], disputed: true }, "disputed_buyer_won"],
    ["escrow intent expired and refunded", { deal_status: "active", intent: { status: "refunded", expired: true } }, "timed_out"],
    ["cancelled + intent expired", { deal_status: "cancelled", intent: { status: "expired", expired: true } }, "timed_out"],
    ["cancelled after funding, no refund recorded", { deal_status: "cancelled", payment_intent_statuses: ["funded"] }, "cancelled_after_funding"],
    ["cross-chain refund landed", { deal_status: "cancelled", refund_transfer_completed: true }, "refunded"],
    ["not funded", { funded: false, payment_intent_statuses: ["released"] }, null],
    ["still delivered", { deal_status: "delivered", payment_intent_statuses: ["funded"] }, null],
    ["disputed, open", { deal_status: "disputed", payment_intent_statuses: ["disputed"], disputed: true }, null],
    ["release pending chain", { deal_status: "release_pending_chain", payment_intent_statuses: ["funded"] }, null],
    ["refund pending", { deal_status: "cancelled", payment_intent_statuses: ["pending_refund"] }, null],
  ];
  for (const [name, over, want] of cases) {
    it(`${name} -> ${want ?? "no receipt"}`, () => {
      assert.equal(classifyOutcome({ ...base, ...over }), want);
    });
  }
});

describe("signing", () => {
  const seed = generateSeed();
  const signer = signerFromSeed(seed, "k1");
  const keys = { k1: publicKeyFromSeed(seed) };

  it("a signed receipt verifies against the published key set", () => {
    const r = signReceipt(buildReceiptPayload(facts())!, signer);
    assert.equal(r.version, RECEIPT_VERSION);
    assert.equal(r.key_id, "k1");
    const v = verifyReceipt(r, keys);
    assert.equal(v.valid, true, JSON.stringify(v));
    assert.deepEqual(v.checks, { hash: true, key_known: true, signature: true });
  });

  it("tamper detection: changing ANY leaf field of the payload fails verification", () => {
    const r = signReceipt(buildReceiptPayload(facts())!, signer);
    const paths: string[][] = [];
    const walk = (o: unknown, p: string[]) => {
      if (o !== null && typeof o === "object") {
        const entries = Array.isArray(o) ? o.map((v, i) => [String(i), v] as const) : Object.entries(o);
        if (entries.length === 0) paths.push(p);
        for (const [k, v] of entries) walk(v, [...p, k]);
      } else paths.push(p);
    };
    walk(r.payload, []);
    assert.ok(paths.length >= 25, `expected many leaves, got ${paths.length}`);
    for (const p of paths) {
      const t = JSON.parse(JSON.stringify(r));
      let o = t.payload;
      for (const k of p.slice(0, -1)) o = o[k];
      const last = p[p.length - 1];
      const cur = o[last];
      o[last] = typeof cur === "string" ? cur + "x" : typeof cur === "boolean" ? !cur : typeof cur === "number" ? cur + 1 : "tampered";
      // Keep the original hash: a verifier must recompute, never trust it.
      const v = verifyReceipt(t, keys);
      assert.equal(v.valid, false, `tampering ${p.join(".")} went undetected`);
      assert.equal(v.checks.hash, false, `hash check missed ${p.join(".")}`);
      // And recomputing the hash does not help a forger: the signature fails.
      t.payload_hash = payloadHash(t.payload);
      const v2 = verifyReceipt(t, keys);
      assert.equal(v2.valid, false);
      assert.equal(v2.checks.signature, false, `signature check missed ${p.join(".")}`);
    }
  });

  it("rejects a signature from an unknown key and a forged key id", () => {
    const other = signerFromSeed(generateSeed(), "k1");
    const forged = signReceipt(buildReceiptPayload(facts())!, other);
    const v = verifyReceipt(forged, keys);
    assert.equal(v.valid, false);
    assert.equal(v.checks.signature, false);
    const unknown = { ...signReceipt(buildReceiptPayload(facts())!, signer), key_id: "nope" };
    const u = verifyReceipt(unknown, keys);
    assert.equal(u.valid, false);
    assert.equal(u.checks.key_known, false);
  });

  it("key rotation: receipts signed by an old key id still verify once a new key is current", () => {
    const oldSeed = generateSeed();
    const newSeed = generateSeed();
    const oldR = signReceipt(buildReceiptPayload(facts())!, signerFromSeed(oldSeed, "2026-09"));
    const newR = signReceipt(buildReceiptPayload(facts())!, signerFromSeed(newSeed, "2026-10"));
    const published = { "2026-09": publicKeyFromSeed(oldSeed), "2026-10": publicKeyFromSeed(newSeed) };
    assert.equal(verifyReceipt(oldR, published).valid, true);
    assert.equal(verifyReceipt(newR, published).valid, true);
    // Cross-check: the old receipt does NOT verify under the new key's id.
    assert.equal(verifyReceipt({ ...oldR, key_id: "2026-10" }, published).valid, false);
  });

  it("rejects a malformed seed instead of signing with a weak key", () => {
    assert.throws(() => signerFromSeed(Buffer.alloc(16).toString("base64"), "k"), /32 bytes/);
    assert.throws(() => signerFromSeed("", "k"), /32 bytes/);
    assert.throws(() => signerFromSeed(generateSeed(), ""), /key id/);
  });

  it("returns invalid (not a throw) on structurally broken input", () => {
    const v = verifyReceipt({ nope: true } as unknown as Parameters<typeof verifyReceipt>[0], keys);
    assert.equal(v.valid, false);
    assert.ok(v.errors.length > 0);
  });
});

describe("Merkle (RFC 6962)", () => {
  const leaf = (i: number) => sha(`leaf-${i}`);

  it("root of one leaf is H(0x00 || leaf)", () => {
    const l = leaf(0);
    assert.equal(merkleRoot([l]), sha(Buffer.concat([Buffer.from([0]), Buffer.from(l, "hex")])));
  });

  it("root of two leaves is H(0x01 || H0 || H1)", () => {
    const lh = (h: string) => createHash("sha256").update(Buffer.concat([Buffer.from([0]), Buffer.from(h, "hex")])).digest();
    const want = createHash("sha256").update(Buffer.concat([Buffer.from([1]), lh(leaf(0)), lh(leaf(1))])).digest("hex");
    assert.equal(merkleRoot([leaf(0), leaf(1)]), want);
  });

  it("every leaf of every tree size 1..33 has a proof that verifies, and only against its own leaf/index/root", () => {
    for (let n = 1; n <= 33; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leaf(i + n * 100));
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(leaves, i);
        assert.equal(proof.leaf_count, n);
        assert.equal(verifyMerkleProof(leaves[i], proof, root), true, `n=${n} i=${i}`);
        if (n > 1) {
          assert.equal(verifyMerkleProof(leaves[(i + 1) % n], proof, root), false, `wrong leaf accepted n=${n} i=${i}`);
          assert.equal(verifyMerkleProof(leaves[i], { ...proof, index: (i + 1) % n }, root), false, `wrong index accepted n=${n} i=${i}`);
        }
        assert.equal(verifyMerkleProof(leaves[i], proof, sha("other-root")), false);
      }
    }
  });

  it("rejects empty trees, out-of-range indexes and malformed hashes", () => {
    assert.throws(() => merkleRoot([]), /empty/);
    assert.throws(() => merkleProof([leaf(0)], 1), /range/);
    assert.throws(() => merkleRoot(["zz"]), /hex/);
    assert.equal(verifyMerkleProof(leaf(0), { index: 0, leaf_count: 2, siblings: [] }, merkleRoot([leaf(0), leaf(1)])), false);
  });
});
