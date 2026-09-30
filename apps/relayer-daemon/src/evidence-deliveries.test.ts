// apps/relayer-daemon/src/evidence-deliveries.test.ts
//
// 2026-09-30 prod: 13 of 19 real delivered deals carried their artifact in
// deliveries.artifact_manifest (submit_delivery), not in deal_fulfillment.
// buildEvidence only read deal_fulfillment, so the judge saw
// "delivery: (no structured payload)" and scored real work p ~ 0.01.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEvidence, describeManifest } from "./jev.js";

// Exact shapes observed on prod (double-encoded jsonb string).
const URL_MANIFEST = JSON.stringify(JSON.stringify([
  { type: "url", url: "https://gitee.com/x/llm-red-team-starter-kit/tree/main/json-extract" },
]));
const INLINE_MD = "data:text/markdown;base64," + Buffer.from("# Delivery\n\n- Public overview is live (HTTP 200)").toString("base64");
const INLINE_PCT = "data:text/markdown;charset=utf-8,%23%20Briefing%0APicked%20source";

describe("describeManifest", () => {
  it("unwraps a double-encoded manifest and lists URLs", () => {
    assert.deepEqual(describeManifest(URL_MANIFEST), [
      "url: https://gitee.com/x/llm-red-team-starter-kit/tree/main/json-extract",
    ]);
  });

  it("decodes base64 and percent-encoded data: URIs into judgeable text", () => {
    const out = describeManifest([{ type: "markdown", url: INLINE_MD }, { type: "url", url: INLINE_PCT }]);
    assert.match(out[0], /^markdown \(inline\): # Delivery - Public overview is live/);
    assert.match(out[1], /^url \(inline\): # Briefing Picked source/);
  });

  it("flags an empty location instead of inventing one", () => {
    assert.deepEqual(describeManifest([{ type: "markdown", url: "about:blank" }]), ["markdown: (no location given)"]);
  });

  it("keeps a content hash when present", () => {
    const out = describeManifest([{ type: "python-source", url: "https://h/x.py", hash: "sha256:de17cf9a" }]);
    assert.equal(out[0], "python-source: https://h/x.py sha256:de17cf9a");
  });

  it("returns nothing for junk", () => {
    assert.deepEqual(describeManifest(null), []);
    assert.deepEqual(describeManifest("not json"), []);
    assert.deepEqual(describeManifest({ a: 1 }), []);
  });

  it("caps the number of artifacts", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ type: "url", url: `https://h/${i}` }));
    const out = describeManifest(many);
    assert.equal(out.length, 7);
    assert.equal(out[6], "(+3 more artifact(s))");
  });
});

describe("buildEvidence with deliveries", () => {
  it("an empty fulfillment payload plus a real delivery is NOT judged as empty", () => {
    const ev = buildEvidence({
      dealTitle: "Ext free buy #9: JSON extract + validation",
      fulfillmentType: "generic",
      fulfillmentData: {},
      deliveryManifest: URL_MANIFEST,
      deliveryNotes: "stdlib only, tests included",
      sellerCompletedCount: 0,
    });
    assert.match(ev, /SUBMITTED ARTIFACTS \(1\):/);
    assert.match(ev, /gitee\.com/);
    assert.match(ev, /DELIVERY NOTES: stdlib only/);
  });

  it("without a delivery the evidence is unchanged (no artifacts section)", () => {
    const ev = buildEvidence({ dealTitle: "t", fulfillmentType: "generic", fulfillmentData: {} });
    assert.doesNotMatch(ev, /SUBMITTED ARTIFACTS/);
  });
});
