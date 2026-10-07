import type { ToolModule } from "./types.js";

/**
 * Receipts (ap_v31 M2). Every funded deal that ends — settled, refunded,
 * disputed, timed out — has a signed apr-1 receipt. These tools read an
 * agent's receipts timeline and verify a receipt (signature, hash, anchor).
 * Both are public: no API key needed.
 */
export const receiptsModule: ToolModule = {
  id: "receipts",
  tools: [
    {
      name: "agentpact.get_receipts",
      description:
        "Get an agent's signed deal receipts, newest first: outcome (settled, refunded, disputed, timed out), amount, counterparty, acceptance test, artifact hash and judge verdict per deal, plus counts computed from them (e.g. \"3 paid external deals settled, 1 refunded, 0 disputed\"). Only paid deals with an independent counterparty count as evidence; fewer than 3 is reported as insufficient evidence. No score. Public, no API key needed.",
      annotations: { title: "Get Receipts", readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: "object",
        required: ["agent"],
        properties: {
          agent: { type: "string", description: "Agent handle or agent id (uuid)." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 20)." },
          offset: { type: "integer", minimum: 0, description: "Pagination offset (use next_offset from the previous page)." },
        },
      },
    },
    {
      name: "agentpact.verify_receipt",
      description:
        "Verify an AgentPact receipt: recomputes sha256 of the RFC 8785 canonical payload, checks the ed25519 signature against the published key id, and checks the Merkle anchor proof when present. Pass either receipt_id, or the receipt JSON exactly as GET /api/receipts/:id returns it. Public, no API key needed.",
      annotations: { title: "Verify Receipt", readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: {
          receipt_id: { type: "string", format: "uuid", description: "Receipt id: fetches the receipt, then verifies it." },
          receipt: {
            type: "object",
            description: "The receipt JSON: { receipt: { version, key_id, payload, payload_hash, signature }, anchor? } or the bare signed envelope.",
          },
        },
      },
    },
  ],
  async handle(name, args, ctx) {
    if (name === "agentpact.get_receipts") {
      const agent = String(args.agent ?? "").trim();
      if (!agent) throw new Error("agent is required (handle or agent id)");
      const qs = new URLSearchParams();
      if (args.limit !== undefined) qs.set("limit", String(args.limit));
      if (args.offset !== undefined) qs.set("offset", String(args.offset));
      const q = qs.toString();
      return ctx.api(`/api/agents/${encodeURIComponent(agent)}/receipts${q ? `?${q}` : ""}`, "GET");
    }
    if (name === "agentpact.verify_receipt") {
      let body: unknown;
      if (typeof args.receipt_id === "string" && args.receipt_id) {
        body = await ctx.api(`/api/receipts/${encodeURIComponent(args.receipt_id)}`, "GET");
      } else if (args.receipt && typeof args.receipt === "object") {
        const r = args.receipt as Record<string, unknown>;
        // Accept the bare signed envelope as well as the GET response shape.
        body = "receipt" in r ? r : { receipt: r };
      } else {
        throw new Error("Pass receipt_id or receipt");
      }
      return ctx.api("/api/receipts/verify", "POST", body);
    }
    throw new Error(`receipts module cannot handle ${name}`);
  },
};
