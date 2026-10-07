// Test doubles: a mocked x402 facilitator and a mocked AgentPact API, both
// served through one fetch function (the middleware takes a single `fetch`).

export const FACILITATOR = "https://facilitator.test";
export const API = "https://api.agentpact.test";
export const SELLER = "11111111-1111-4111-8111-111111111111";
export const OFFER = "22222222-2222-4222-8222-222222222222";
export const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

// `body: any`: parsed JSON of arbitrary request shapes, asserted field by field in tests.
export interface Call { url: string; method: string; headers: Record<string, string>; body: any }

export interface DealState {
  sellerAgentId: string;
  status: "proposed" | "active" | "delivered";
  /** USDC base units currently held in escrow for the deal. */
  escrowed: bigint;
  consumedKey?: string;
  /** Buyer token minted for the deal; consume requires it. */
  token?: string;
  milestoneIds: string[];
}

export interface MockOptions {
  verify?: (body: any) => { status?: number; json: unknown };
  settle?: (body: any) => { status?: number; json: unknown };
  deals?: Record<string, DealState>;
  apiKey?: string;
  failDelivery?: boolean;
}

/**
 * Mirrors the real `POST /api/deals/:id/consume` contract (apps/api
 * routes/sellers.ts) closely enough to drive every middleware branch.
 */
export function mockNetwork(opts: MockOptions = {}) {
  const calls: Call[] = [];
  const deals = opts.deals ?? {};
  const apiKey = opts.apiKey ?? "seller-key";

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers, body });

    if (url === `${FACILITATOR}/verify`) {
      const r = opts.verify ? opts.verify(body) : { json: { isValid: true, payer: "0xpayer" } };
      return json(r.status ?? 200, r.json);
    }
    if (url === `${FACILITATOR}/settle`) {
      const r = opts.settle ? opts.settle(body) : {
        json: { success: true, transaction: "0xabc", network: body.paymentRequirements.network, payer: "0xpayer" },
      };
      return json(r.status ?? 200, r.json);
    }

    if (url.startsWith(`${API}/api/`)) {
      if (headers["x-api-key"] !== apiKey) return json(401, { error: "Invalid API key" });
      const consume = url.match(/\/api\/deals\/([^/]+)\/consume$/);
      if (consume && method === "POST") {
        const deal = deals[consume[1]];
        if (!deal) return json(404, { error: "Deal not found", code: "DEAL_NOT_FOUND" });
        if (deal.sellerAgentId !== SELLER) return json(403, { error: "not your deal", code: "WRONG_SELLER" });
        if (!deal.token || body.buyerToken !== deal.token) return json(403, { error: "bad token", code: "BUYER_TOKEN_INVALID" });
        if (deal.consumedKey !== undefined) {
          if (deal.consumedKey === body.consumeKey) {
            return json(200, { consumed: true, replay: true, dealId: consume[1], milestoneIds: deal.milestoneIds });
          }
          return json(409, { error: "already consumed", code: "ALREADY_CONSUMED" });
        }
        if (deal.status === "proposed") return json(409, { error: "not accepted", code: "DEAL_NOT_ACCEPTED" });
        if (deal.escrowed === 0n) return json(409, { error: "not funded", code: "DEAL_NOT_FUNDED" });
        if (deal.escrowed < BigInt(body.priceBaseUnits)) {
          return json(409, { error: "underfunded", code: "DEAL_UNDERFUNDED", escrowedBaseUnits: String(deal.escrowed) });
        }
        deal.consumedKey = body.consumeKey;
        return json(200, { consumed: true, replay: false, dealId: consume[1], milestoneIds: deal.milestoneIds });
      }
      const release = url.match(/\/api\/deals\/([^/]+)\/consume\/release$/);
      if (release && method === "POST") {
        const deal = deals[release[1]];
        if (!deal || deal.consumedKey !== body.consumeKey) return json(409, { error: "not yours", code: "NOT_CONSUMED_BY_KEY" });
        deal.consumedKey = undefined;
        return json(200, { released: true });
      }
      const accept = url.match(/\/api\/deals\/([^/]+)\/accept$/);
      if (accept && method === "POST") {
        const deal = deals[accept[1]];
        if (!deal) return json(404, { error: "Deal not found" });
        if (deal.status !== "proposed") return json(409, { error: "Cannot accept" });
        deal.status = "active";
        return json(200, { id: accept[1], status: "active" });
      }
      if (url === `${API}/api/deliveries/submit` && method === "POST") {
        if (opts.failDelivery) return json(500, { error: "boom" });
        return json(201, { id: "delivery-1", status: "submitted" });
      }
    }
    return json(404, { error: `unmocked ${method} ${url}` });
  };
  return { fetch: fetchImpl as typeof fetch, calls, deals };
}

export function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeB64json(value: string | undefined): any {
  if (!value) throw new Error("missing header");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}
