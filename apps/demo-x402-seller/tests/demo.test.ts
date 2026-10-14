import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";
import { validateCsv, type CsvSchema } from "../src/csv.js";

const SELLER = "11111111-1111-4111-8111-111111111111";
const OFFER = "22222222-2222-4222-8222-222222222222";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

const decode = (h: unknown) => JSON.parse(Buffer.from(String(h), "base64").toString("utf8"));

/** Facilitator + AgentPact API double. */
function upstream() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/verify")) return json(200, { isValid: true, payer: "0xpayer" });
    if (url.endsWith("/settle")) return json(200, { success: true, transaction: "0xt", network: "eip155:84532" });
    if (url.includes("/consume")) return json(404, { error: "Deal not found", code: "DEAL_NOT_FOUND" });
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function server() {
  const up = upstream();
  const app = await buildServer({
    sellerAgentId: SELLER, apiKey: "k", offerId: OFFER, payTo: PAY_TO, network: "base-sepolia",
    pricePerCallUsd: "0.02", thresholdUsd: "1", facilitatorUrl: "https://facilitator.test", apiBase: "https://api.test",
    fetch: up.fetchImpl,
  });
  return { app, up };
}

const CSV_JOB: { csv: string; schema: CsvSchema } = {
  csv: "id,email\n1,a@x.io\n2,b@x.io\n",
  schema: { columns: [{ name: "id", type: "integer", required: true }, { name: "email", required: true }], minRows: 1 },
};

test("csv validator: pass + row-level failures", () => {
  assert.deepEqual(validateCsv(CSV_JOB.csv, CSV_JOB.schema), { valid: true, rows: 2, errors: [] });
  const bad = validateCsv("id,email\nx,\n", CSV_JOB.schema);
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join("\n"), /row 1: "id" is not integer/);
  assert.match(bad.errors.join("\n"), /row 1: "email" is empty/);
  assert.match(validateCsv("id\n1\n", CSV_JOB.schema).errors.join(), /missing column\(s\): email/);
  assert.match(validateCsv('id,email\n1,"open\n', CSV_JOB.schema).errors.join(), /unterminated/);
});

test("GET /health is free and reports config", async () => {
  const { app } = await server();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, service: "demo-x402-seller", network: "eip155:84532", pricePerCallUsd: "0.02", thresholdUsd: "1" });
  await app.close();
});

test("POST /validate-csv without payment → 402, plain x402 only ($0.02 = 20000 base units)", async () => {
  const { app } = await server();
  const res = await app.inject({ method: "POST", url: "/validate-csv", payload: CSV_JOB });
  assert.equal(res.statusCode, 402);
  const pr = decode(res.headers["payment-required"]);
  assert.deepEqual(pr.accepts.map((a: { scheme: string }) => a.scheme), ["exact"]);
  assert.equal(pr.accepts[0].amount, "20000");
  assert.equal(pr.accepts[0].network, "eip155:84532");
  await app.close();
});

test("POST /validate-csv paid → result + PAYMENT-RESPONSE", async () => {
  const { app } = await server();
  const first = await app.inject({ method: "POST", url: "/validate-csv", payload: CSV_JOB });
  const accepted = decode(first.headers["payment-required"]).accepts[0];
  const sig = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signature: "0x", authorization: {} } })).toString("base64");
  const res = await app.inject({ method: "POST", url: "/validate-csv", payload: CSV_JOB, headers: { "payment-signature": sig } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { valid: true, rows: 2, errors: [] });
  assert.equal(decode(res.headers["payment-response"]).success, true);
  await app.close();
});

test("POST /validate-csv/batch → priced per job, escrow offered (batch); unknown deal → 402 again", async () => {
  const { app, up } = await server();
  const jobs = Array.from({ length: 100 }, () => CSV_JOB);
  const res = await app.inject({ method: "POST", url: "/validate-csv/batch", payload: { jobs } });
  assert.equal(res.statusCode, 402);
  const pr = decode(res.headers["payment-required"]);
  const escrow = pr.accepts.find((a: { scheme: string }) => a.scheme === "agentpact-escrow");
  assert.ok(escrow, "escrow option offered for batch");
  assert.equal(escrow.amount, "2000000"); // 100 × $0.02
  assert.equal(escrow.extra.agentpact.offerId, OFFER);

  const retry = await app.inject({ method: "POST", url: "/validate-csv/batch", payload: { jobs }, headers: { "x-agentpact-deal": "33333333-3333-4333-8333-333333333333" } });
  assert.equal(retry.statusCode, 402);
  assert.match(decode(retry.headers["payment-required"]).error, /deal_not_found/);
  assert.ok(up.calls.some((c) => c === "POST https://api.test/api/deals/33333333-3333-4333-8333-333333333333/consume"));
  await app.close();
});

test("batch input bounds: empty or > 1000 jobs → 400 before any payment talk", async () => {
  const { app } = await server();
  assert.equal((await app.inject({ method: "POST", url: "/validate-csv/batch", payload: { jobs: [] } })).statusCode, 400);
  const many = Array.from({ length: 1001 }, () => CSV_JOB);
  assert.equal((await app.inject({ method: "POST", url: "/validate-csv/batch", payload: { jobs: many } })).statusCode, 400);
  await app.close();
});
