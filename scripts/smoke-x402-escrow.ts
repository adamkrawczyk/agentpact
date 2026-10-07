/**
 * Local smoke test for the M3 x402 → escrow upgrade, end to end against a REAL
 * AgentPact API (simulation mode: no chain, no money):
 *
 *   seller: register → profile → offer → readiness (ready=true)
 *   demo seller (apps/demo-x402-seller) started in-process on a local port
 *   buyer:  fetchWithEscrow(batch job) → need → propose → seller middleware
 *           accepts → fund (simulation) → retry → served → delivery submitted
 *   replay: the same deal again → 402 agentpact_already_consumed
 *
 * Usage (API must run in simulation mode, i.e. without a chain key):
 *   TSX_TSCONFIG_PATH=apps/demo-x402-seller/tsconfig.json \
 *     npx tsx scripts/smoke-x402-escrow.ts http://127.0.0.1:4000
 * Refuses non-local API bases.
 */
import { randomUUID } from "node:crypto";
import { fetchWithEscrow, DEAL_HEADER, decodeB64Json } from "../packages/x402-escrow/src/index.js";
import { buildServer } from "../apps/demo-x402-seller/src/server.js";

const API = (process.argv[2] ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const host = new URL(API).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`refusing to run against non-local API ${API}`);
  process.exit(2);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error(`SMOKE FAILED: ${msg}`); process.exit(1); }
}

async function call(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "x-api-key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, any>;
  return { status: res.status, json };
}

async function register(wallet: string) {
  const agentId = randomUUID();
  const r = await call("POST", "/api/auth/register", { agentId, walletAddress: wallet });
  assert(r.status === 201 || r.status === 200, `register ${r.status} ${JSON.stringify(r.json)}`);
  return { agentId, apiKey: String(r.json.apiKey) };
}

const seller = await register("0x00000000000000000000000000000000000005e1");
const buyer = await register("0x00000000000000000000000000000000000000b1");
const step = (s: string) => console.log(`✔ ${s}`);

let r = await call("GET", "/api/sellers/me/readiness", undefined, seller.apiKey);
assert(r.status === 200 && r.json.ready === false && r.json.nextStep === "profile", `fresh readiness ${JSON.stringify(r.json)}`);
step(`readiness (fresh): ready=false nextStep=${r.json.nextStep}`);

r = await call("POST", "/api/agents", { handle: `csv-demo-${seller.agentId.slice(0, 6)}`, displayName: "CSV Validation Demo" }, seller.apiKey);
assert(r.status === 200, `profile ${r.status}`);
r = await call("POST", "/api/offers", {
  agentId: seller.agentId, title: "Validate CSV batches", descriptionMd: "Batch CSV validation against a column schema.",
  category: "data", basePrice: 1, fulfillmentType: "api-access",
}, seller.apiKey);
assert(r.status === 201, `offer ${r.status} ${JSON.stringify(r.json)}`);
const offerId = String(r.json.id);
r = await call("POST", `/api/agents/${seller.agentId}/heartbeat`, undefined, seller.apiKey);
assert(r.status === 200, `heartbeat ${r.status}`);
r = await call("GET", "/api/sellers/me/readiness", undefined, seller.apiKey);
assert(r.json.ready === true, `readiness after setup ${JSON.stringify(r.json)}`);
step(`readiness (after register/profile/offer/heartbeat): ready=true ${JSON.stringify(r.json.progress)}`);

const demo = await buildServer({
  sellerAgentId: seller.agentId, apiKey: seller.apiKey, offerId,
  payTo: "0x00000000000000000000000000000000000005e1", network: "base-sepolia",
  pricePerCallUsd: "0.02", thresholdUsd: "1", apiBase: API,
});
const demoUrl = await demo.listen({ port: 0, host: "127.0.0.1" });
step(`demo seller listening on ${demoUrl}`);

const job = { csv: "id,email\n1,a@x.io\n2,b@x.io\n", schema: { columns: [{ name: "id", type: "integer", required: true }, { name: "email", required: true }] } };
const jobs = Array.from({ length: 60 }, () => job); // 60 × $0.02 = $1.20 > $1 threshold
const events: string[] = [];
const res = await fetchWithEscrow(`${demoUrl}/validate-csv/batch`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobs }),
}, { apiKey: buyer.apiKey, agentId: buyer.agentId, apiBase: API, maxPlainUsd: "0.5", onEvent: (e) => events.push(e) });
const text = await res.text();
assert(res.status === 200, `batch via escrow: HTTP ${res.status} ${text.slice(0, 300)}`);
const dealId = res.headers.get(DEAL_HEADER);
assert(dealId, "no deal id header");
assert(JSON.parse(text).results.length === 60, "60 results");
step(`fetchWithEscrow: served 60 results via deal ${dealId} (events: ${events.join(" → ")})`);

// Delivery is submitted after the response is flushed; give it a moment.
await new Promise((ok) => setTimeout(ok, 500));
r = await call("GET", `/api/deals/${dealId}`, undefined, buyer.apiKey);
assert(r.json.status === "delivered", `deal status ${r.json.status}`);
step(`deal ${dealId}: status=delivered (seller middleware submitted the artifact sha256)`);

const replay = await fetch(`${demoUrl}/validate-csv/batch`, {
  method: "POST", headers: { "content-type": "application/json", [DEAL_HEADER]: dealId }, body: JSON.stringify({ jobs }),
});
const pr = decodeB64Json<{ error: string }>(replay.headers.get("PAYMENT-REQUIRED") ?? "");
assert(replay.status === 402 && pr.error === "agentpact_already_consumed", `replay ${replay.status} ${pr.error}`);
step("replay of the consumed deal → 402 agentpact_already_consumed");

await demo.close();
console.log("SMOKE OK");
