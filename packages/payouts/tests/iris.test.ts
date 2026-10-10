// Iris client: fake fetch, fake sleep. No network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IrisClient, IrisError, IrisRateLimitedError } from "../src/cctp/iris.js";

const TX = `0x${"ab".repeat(32)}` as const;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function harness(responses: Array<Response | Error | "hang">, opts: Partial<ConstructorParameters<typeof IrisClient>[0]> = {}) {
  const urls: string[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (r instanceof Error) throw r;
    return r.clone();
  }) as typeof fetch;
  const client = new IrisClient({
    baseUrl: "https://iris.test",
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    timeoutMs: 30,
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    ...opts,
  });
  return { client, urls, sleeps };
}

const COMPLETE = {
  messages: [{
    message: "0x0000000100",
    attestation: "0xaabb",
    eventNonce: `0x${"01".repeat(32)}`,
    cctpVersion: 2,
    status: "complete",
    delayReason: null,
  }],
};

describe("IrisClient.getMessages", () => {
  it("calls /v2/messages/{sourceDomain}?transactionHash= and returns typed messages", async () => {
    const { client, urls } = harness([json(COMPLETE)]);
    const r = await client.getMessages(5, TX);
    assert.equal(r.kind === "found" && r.messages[0].forwardTxHash, null);
    assert.equal(urls[0], `https://iris.test/v2/messages/5?transactionHash=${TX}`);
    assert.equal(r.kind, "found");
    assert.equal(r.kind === "found" && r.messages[0].status, "complete");
    assert.equal(r.kind === "found" && r.messages[0].attestation, "0xaabb");
  });

  it("maps a 404 (not indexed yet) to not_found, not to an error", async () => {
    const { client, sleeps } = harness([json({ error: "Message hash not found" }, 404)]);
    assert.deepEqual(await client.getMessages(0, TX), { kind: "not_found" });
    assert.equal(sleeps.length, 0, "404 is an answer, not a transient failure");
  });

  it("normalises a PENDING attestation to null so callers cannot relay it", async () => {
    const body = { messages: [{ ...COMPLETE.messages[0], attestation: "PENDING", status: "pending_confirmations" }] };
    const { client } = harness([json(body)]);
    const r = await client.getMessages(0, TX);
    assert.equal(r.kind === "found" && r.messages[0].attestation, null);
    assert.equal(r.kind === "found" && r.messages[0].status, "pending_confirmations");
  });

  it("retries 5xx with exponential backoff + jitter, then succeeds", async () => {
    const { client, sleeps } = harness([json({}, 502), json({}, 503), json(COMPLETE)]);
    const r = await client.getMessages(6, TX);
    assert.equal(r.kind, "found");
    // random()=0.5 → equal-jitter factor 0.75: 100*0.75, 200*0.75
    assert.deepEqual(sleeps, [75, 150]);
  });

  it("honours Retry-After on 429 when it fits inside the retry budget", async () => {
    const { client, sleeps } = harness([json({}, 429, { "retry-after": "2" }), json(COMPLETE)]);
    await client.getMessages(6, TX);
    assert.deepEqual(sleeps, [2_000]);
  });

  it("does NOT sleep through a long rate-limit lockout — surfaces it so the caller reschedules", async () => {
    const { client, sleeps } = harness([json({}, 429, { "retry-after": "300" })]);
    await assert.rejects(client.getMessages(6, TX), (e: unknown) => {
      assert.ok(e instanceof IrisRateLimitedError);
      assert.equal(e.retryAfterMs, 300_000);
      return true;
    });
    assert.equal(sleeps.length, 0);
  });

  it("times out a hung request and retries it", async () => {
    const { client, urls } = harness(["hang", json(COMPLETE)]);
    const r = await client.getMessages(6, TX);
    assert.equal(r.kind, "found");
    assert.equal(urls.length, 2);
  });

  it("gives up after maxRetries with an IrisError carrying the last status", async () => {
    const { client, urls } = harness([json({}, 500)]);
    await assert.rejects(client.getMessages(6, TX), (e: unknown) => {
      assert.ok(e instanceof IrisError);
      assert.equal(e.status, 500);
      return true;
    });
    assert.equal(urls.length, 4, "1 try + 3 retries");
  });

  it("does not retry a 400 (our bug, not theirs)", async () => {
    const { client, urls } = harness([json({ error: "bad domain" }, 400)]);
    await assert.rejects(client.getMessages(6, TX), IrisError);
    assert.equal(urls.length, 1);
  });

  it("rejects a malformed tx hash before touching the network", async () => {
    const { client, urls } = harness([json(COMPLETE)]);
    await assert.rejects(client.getMessages(6, "0x12" as `0x${string}`), /transaction hash/);
    assert.equal(urls.length, 0);
  });

  it("rejects a malformed response body instead of returning a half-typed object", async () => {
    const { client } = harness([json({ messages: [{ status: 7 }] })]);
    await assert.rejects(client.getMessages(6, TX), /unexpected Iris response/);
  });
});

describe("IrisClient.getBurnFees", () => {
  it("calls /v2/burn/USDC/fees/{src}/{dst} and returns fee tiers", async () => {
    const { client, urls } = harness([json([
      { finalityThreshold: 1000, minimumFee: 1 },
      { finalityThreshold: 2000, minimumFee: 0 },
    ])]);
    const fees = await client.getBurnFees(0, 6);
    assert.equal(urls[0], "https://iris.test/v2/burn/USDC/fees/0/6");
    assert.deepEqual(fees.tiers.map((f) => [f.finalityThreshold, f.minimumFeeBps]), [[1000, "1"], [2000, "0"]]);
    assert.equal(fees.forwardFee, null);
  });

  it("asks for the forwarding fee (+ Solana ATA setup) and returns it in base units", async () => {
    // Shape observed live on 2026-10-07 for 6→5 with forward=true&includeRecipientSetup=true.
    const { client, urls } = harness([json([
      { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 300000, med: 308810, high: 340000 } },
      { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 300000, med: 308810, high: 340000 } },
    ])]);
    const fees = await client.getBurnFees(6, 5, { forward: true, includeRecipientSetup: true });
    assert.equal(urls[0], "https://iris.test/v2/burn/USDC/fees/6/5?forward=true&includeRecipientSetup=true");
    assert.deepEqual(fees.forwardFee, { low: 300000n, med: 308810n, high: 340000n });
  });

  it("refuses forward=true without a forwardFee in the answer (would under-fund the burn)", async () => {
    const { client } = harness([json([{ finalityThreshold: 2000, minimumFee: 0 }])]);
    await assert.rejects(client.getBurnFees(6, 0, { forward: true }), /no forwardFee/);
  });

  it("keeps a fractional bps fee exact as a decimal string (never a float in money math)", async () => {
    const { client } = harness([json([{ finalityThreshold: 1000, minimumFee: 1.3 }])]);
    const { tiers: [f] } = await client.getBurnFees(5, 6);
    assert.equal(f.minimumFeeBps, "1.3");
  });
});
