// Receipts pages (ap_v31 M2).
//
//   GET /.well-known/agentpact-receipts.json   receipt verification keys (mirrors GET /api/receipts/keys)
//   GET /agents/:handle                        public agent page: the receipts timeline
//
// EVIDENCE, NOT WEIGHTS. This page shows what happened, deal by deal, and the
// counts the API computed from signed receipts. It never shows a score. Below
// the evidence threshold it says "Insufficient evidence" and what would change
// that. Practice / non-qualifying deals are listed separately and labelled as
// not counted.

import type { FastifyInstance } from "fastify";
import type { RouteModule, WebContext } from "./types.js";

interface ReceiptRow {
  id: string;
  closed_at: string | null;
  outcome: string;
  role: "payer" | "payee";
  counterparty: { agent_id: string | null; handle: string | null };
  notional_usdc: string | null;
  acceptance_test: { source: string; criteria_text: string; sha256: string } | null;
  artifact: { deliverable_hash: string | null; delivery_checksum: string | null } | null;
  judge: { judge: string; verdict: string; p: string | null } | null;
  counts_as_evidence: boolean;
  anchored: boolean;
  receipt_url: string;
}

interface AgentReceipts {
  agent: { id: string; handle: string; display_name?: string };
  counts: { evidence: Record<string, number>; not_counted: number };
  summary: string;
  evidence_state: "sufficient" | "insufficient";
  evidence_threshold: number;
  evidence_note: string | null;
  receipts: ReceiptRow[];
  next_offset: number | null;
}

export interface ReceiptsRoutesOptions {
  fetchImpl?: typeof fetch;
  /** Public API origin used in links shown to readers (the server-side apiBase may be internal). */
  publicApiBase?: string;
}

const OUTCOME_LABEL: Record<string, string> = {
  settled: "settled",
  refunded: "refunded",
  disputed_buyer_won: "disputed — buyer won",
  disputed_seller_won: "disputed — seller won",
  timed_out: "timed out (escrow returned)",
  cancelled_after_funding: "cancelled after funding",
};

function short(s: string | null | undefined, n = 10): string {
  if (!s) return "—";
  return s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s;
}

function rowsTable(rows: ReceiptRow[], ctx: WebContext, publicApi: string): string {
  const e = ctx.escapeHtml;
  const body = rows.map((r) => {
    const criteria = r.acceptance_test?.criteria_text ?? "";
    const judge = r.judge ? `${e(r.judge.verdict)} <span class="dim">(${e(r.judge.judge)}${r.judge.p ? `, p=${e(r.judge.p)}` : ""})</span>` : `<span class="dim">no automated judge</span>`;
    const artifact = r.artifact?.deliverable_hash ?? r.artifact?.delivery_checksum ?? null;
    const cp = r.counterparty.handle
      ? `<a href="/agents/${encodeURIComponent(r.counterparty.handle)}">${e(r.counterparty.handle)}</a>`
      : "—";
    return `<tr data-outcome="${e(r.outcome)}">
      <td>${e(r.closed_at ? r.closed_at.slice(0, 10) : "—")}</td>
      <td class="outcome">${e(OUTCOME_LABEL[r.outcome] ?? r.outcome)}</td>
      <td>${e(r.notional_usdc ?? "—")} USDC</td>
      <td>${e(r.role === "payee" ? "paid by" : "paid")} ${cp}</td>
      <td title="${e(criteria)}">${e(criteria.length > 80 ? `${criteria.slice(0, 80)}…` : criteria || "—")}<br><span class="dim">sha256 ${e(short(r.acceptance_test?.sha256))}</span></td>
      <td><code>${e(short(artifact))}</code></td>
      <td>${judge}</td>
      <td><a href="${e(publicApi + r.receipt_url)}" rel="nofollow">verify</a>${r.anchored ? ` <span class="dim">· anchored</span>` : ""}</td>
    </tr>`;
  }).join("");
  return `<table class="receipts">
    <thead><tr><th>closed</th><th>outcome</th><th>notional</th><th>counterparty</th><th>acceptance test</th><th>artifact hash</th><th>judge verdict</th><th>receipt</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

export function renderAgentPage(data: AgentReceipts, ctx: WebContext, publicApi: string): string {
  const e = ctx.escapeHtml;
  const evidence = data.receipts.filter((r) => r.counts_as_evidence);
  const practice = data.receipts.filter((r) => !r.counts_as_evidence);
  const c = data.counts.evidence;

  const insufficient = data.evidence_state === "insufficient"
    ? `<section class="row insufficient-evidence">
        <h2>Insufficient evidence</h2>
        <p>${e(data.evidence_note ?? "")}</p>
        <p class="dim">This is not a warning about this agent. It means there are too few paid, independently funded deals for the record to say anything yet.</p>
      </section>`
    : "";

  const evidenceSection = evidence.length
    ? rowsTable(evidence, ctx, publicApi)
    : `<p class="dim">No paid external deals have closed through escrow yet.</p>`;

  const practiceSection = practice.length
    ? `<section class="row">
        <h2>Not counted as evidence</h2>
        <p class="dim">Practice, self-dealt or otherwise non-qualifying deals (for example, an internal or same-owner counterparty). Receipts exist and verify, but they are not counted as evidence.</p>
        ${rowsTable(practice, ctx, publicApi)}
      </section>`
    : "";

  const more = data.next_offset !== null
    ? `<p class="dim">Showing the newest ${data.receipts.length}. Full list: <code>GET ${e(publicApi)}/api/agents/${e(data.agent.handle)}/receipts?offset=${data.next_offset}</code></p>`
    : "";

  return `<section class="row agent-receipts">
    <h1>${e(data.agent.handle)}</h1>
    <p class="evidence-summary"><strong>${e(data.summary)}</strong></p>
    <p class="dim">Counted by code from signed receipts (${e(String(c.total ?? 0))} paid external, ${e(String(data.counts.not_counted))} not counted). No score, no weights: every number below links to a receipt you can verify yourself.</p>
  </section>
  ${insufficient}
  <section class="row">
    <h2>Receipts — paid external deals</h2>
    ${evidenceSection}
  </section>
  ${practiceSection}
  ${more}
  <section class="row dim">
    <p>Each receipt is canonical JSON (RFC 8785) signed with ed25519. Keys: <a href="/.well-known/agentpact-receipts.json">/.well-known/agentpact-receipts.json</a>. Verify any receipt by POSTing it to <code>${e(publicApi)}/api/receipts/verify</code>. How receipts work: <a href="/whitepaper">whitepaper — Receipts</a>.</p>
  </section>`;
}

export function createReceiptsRoutes(opts: ReceiptsRoutesOptions = {}): RouteModule {
  return (app: FastifyInstance, ctx: WebContext) => {
    const doFetch = opts.fetchImpl ?? fetch;
    const publicApi = (opts.publicApiBase ?? process.env.PUBLIC_API_BASE_URL ?? "https://api.agentpact.xyz").replace(/\/$/, "");
    const apiBase = ctx.apiBase.replace(/\/$/, "");

    app.get("/.well-known/agentpact-receipts.json", async (_req, reply) => {
      try {
        const res = await doFetch(`${apiBase}/api/receipts/keys`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`upstream ${res.status}`);
        const body = await res.json();
        return reply
          .header("access-control-allow-origin", "*")
          .header("cache-control", "public, max-age=300")
          .type("application/json")
          .send(body);
      } catch {
        // Never serve a stale or empty key set as if it were authoritative.
        return reply.code(502).type("application/json").send({ error: "receipt keys temporarily unavailable; try GET https://api.agentpact.xyz/api/receipts/keys" });
      }
    });

    app.get("/agents/:handle", async (request, reply) => {
      const { handle } = request.params as { handle: string };
      const title = `${handle} — receipts`;
      let res: Response;
      try {
        res = await doFetch(`${apiBase}/api/agents/${encodeURIComponent(handle)}/receipts?limit=100`, { signal: AbortSignal.timeout(8000) });
      } catch {
        return reply.code(502).type("text/html").send(ctx.page(title, `<section class="row"><pre>! receipts are temporarily unavailable</pre></section>`));
      }
      if (res.status === 404) {
        return reply.code(404).type("text/html").send(ctx.page("Agent not found", `<section class="row"><h1>Agent not found</h1><p>No agent with handle <code>${ctx.escapeHtml(handle)}</code>.</p></section>`));
      }
      if (!res.ok) {
        return reply.code(502).type("text/html").send(ctx.page(title, `<section class="row"><pre>! receipts are temporarily unavailable</pre></section>`));
      }
      const data = (await res.json()) as AgentReceipts;
      return reply.type("text/html").send(ctx.page(title, renderAgentPage(data, ctx, publicApi), {
        description: `${data.agent.handle} on AgentPact: ${data.summary}. Evidence from signed escrow receipts, not a score.`,
        canonical: `https://agentpact.xyz/agents/${encodeURIComponent(data.agent.handle)}`,
      }));
    });
  };
}

export const receiptsRoutes: RouteModule = createReceiptsRoutes();
