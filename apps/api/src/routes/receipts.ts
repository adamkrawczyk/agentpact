// Receipts (ap_v31 M2) — public, read-only.
//
//   GET  /api/receipts/keys            published ed25519 verification keys (all ids, incl. retired)
//   GET  /api/receipts/:id             signed receipt + Merkle proof and tx once anchored
//   POST /api/receipts/verify          check a receipt: hash, signature, anchor proof, issuer record
//   GET  /api/agents/:id/receipts      an agent's receipts timeline (:id = handle or agent id)
//
// Receipts are ISSUED by the relayer's receipt sweeper; this file never writes.
// Canonicalisation, hashing, signature and proof checks all come from
// packages/receipts — the same code the issuer signs with.
//
// EVIDENCE, NOT WEIGHTS. The timeline returns counts computed here and a
// sentence built from them; it never returns a score. Only capital_at_risk
// receipts (the single definition in migration 052) count as evidence;
// everything else is returned but labelled not counted.

import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import {
  merkleProof,
  verifyMerkleProof,
  verifyReceipt,
  type ReceiptKeySet,
  type ReceiptPayload,
  type SignedReceipt,
} from "@agentpact/receipts";

/** Fewer capital-at-risk receipts than this = "insufficient evidence". */
export const RECEIPT_EVIDENCE_THRESHOLD = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const signedReceiptSchema = z.object({
  version: z.string(),
  key_id: z.string(),
  payload: z.record(z.unknown()),
  payload_hash: z.string(),
  signature: z.string(),
});

const anchorSchema = z.object({
  root: z.string(),
  tx_hash: z.string().nullish(),
  chain: z.string().nullish(),
  proof: z.object({
    index: z.number().int(),
    leaf_count: z.number().int(),
    siblings: z.array(z.string()).max(64),
  }),
}).passthrough();

// Accepts the exact body GET /api/receipts/:id returns, so "fetch, then POST
// it back" works with no reshaping.
const verifyBodySchema = z.object({
  receipt: signedReceiptSchema,
  anchor: anchorSchema.nullish(),
}).passthrough();

/** Exact base units -> decimal USDC string (at least 2 decimals). No float. */
export function formatBaseUnits(units: string | null | undefined): string | null {
  if (units === null || units === undefined || !/^\d+$/.test(units)) return null;
  const s = units.padStart(7, "0");
  const whole = s.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-6).replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}

type Counts = {
  settled: number; refunded: number; disputed: number;
  disputed_buyer_won: number; disputed_seller_won: number;
  timed_out: number; cancelled_after_funding: number; total: number;
};

export function evidenceSummary(c: Counts): string {
  const parts = [
    `${c.settled} paid external ${c.settled === 1 ? "deal" : "deals"} settled`,
    `${c.refunded} refunded`,
    `${c.disputed} disputed`,
  ];
  if (c.timed_out > 0) parts.push(`${c.timed_out} timed out`);
  if (c.cancelled_after_funding > 0) parts.push(`${c.cancelled_after_funding} cancelled after funding`);
  return parts.join(", ");
}

async function loadKeys(sql: Sql<Record<string, unknown>>): Promise<ReceiptKeySet> {
  const rows = await sql<{ key_id: string; public_key: string }[]>`SELECT key_id, public_key FROM receipt_signing_keys`;
  return Object.fromEntries(rows.map((r) => [r.key_id, r.public_key]));
}

export async function registerReceiptRoutes(app: FastifyInstance, sql: Sql<Record<string, unknown>>): Promise<void> {
  app.get("/api/receipts/keys", async () => {
    const rows = await sql`
      SELECT key_id, alg, public_key, created_at, retired_at
      FROM receipt_signing_keys ORDER BY created_at ASC, key_id ASC
    `;
    return {
      version: "apr-1",
      signature: "ed25519 over RFC 8785 canonical JSON of receipt.payload",
      hash: "sha256(JCS(payload)), lowercase hex",
      keys: rows.map((r) => ({
        key_id: r.key_id,
        alg: r.alg,
        public_key: r.public_key,
        public_key_encoding: "base64 raw 32 bytes",
        created_at: r.created_at,
        retired_at: r.retired_at,
      })),
    };
  });

  app.get("/api/receipts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "Receipt not found" });
    const [r] = await sql`
      SELECT r.id, r.deal_id, r.version, r.issued_at, r.payload, r.payload_hash, r.signature, r.key_id,
             r.superseded_by, r.anchor_batch_id, r.anchor_leaf_index,
             b.root, b.chain, b.tx_hash, b.anchored_at, b.leaf_count
      FROM receipts r
      LEFT JOIN receipt_anchor_batches b ON b.id = r.anchor_batch_id
      WHERE r.id = ${id}
    `;
    if (!r) return reply.code(404).send({ error: "Receipt not found" });

    let anchor: Record<string, unknown> | null = null;
    // A batch is only an anchor once its tx is recorded; before that the
    // root exists nowhere public, so no proof is offered.
    if (r.anchor_batch_id && r.tx_hash) {
      const leaves = await sql<{ payload_hash: string }[]>`
        SELECT payload_hash FROM receipts WHERE anchor_batch_id = ${r.anchor_batch_id} ORDER BY anchor_leaf_index ASC
      `;
      anchor = {
        batch_id: r.anchor_batch_id,
        root: r.root,
        chain: r.chain,
        tx_hash: r.tx_hash,
        anchored_at: r.anchored_at,
        leaf_count: r.leaf_count,
        proof: merkleProof(leaves.map((l) => l.payload_hash), Number(r.anchor_leaf_index)),
        calldata_format: "ASCII 'agentpact-receipts:apr-1:' followed by the 32-byte root",
      };
    }

    return {
      id: r.id,
      deal_id: r.deal_id,
      issued_at: r.issued_at,
      superseded_by: r.superseded_by,
      receipt: {
        version: r.version,
        key_id: r.key_id,
        payload: r.payload,
        payload_hash: r.payload_hash,
        signature: r.signature,
      },
      anchor,
      verify: { endpoint: "/api/receipts/verify", keys: "/api/receipts/keys", well_known: "/.well-known/agentpact-receipts.json" },
    };
  });

  app.post("/api/receipts/verify", async (request, reply) => {
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Body must be { receipt: { version, key_id, payload, payload_hash, signature }, anchor? } — the shape GET /api/receipts/:id returns",
        issues: parsed.error.issues.slice(0, 5),
      });
    }
    const { receipt, anchor } = parsed.data;
    const keys = await loadKeys(sql);
    const v = verifyReceipt(receipt as unknown as SignedReceipt, keys);
    const errors = [...v.errors];

    // Anchor: the proof must lead from THIS payload hash to a root we actually
    // anchored in a recorded tx. A self-consistent proof to an unknown root
    // proves nothing.
    let anchorOk: boolean | null = null;
    if (anchor) {
      const proofOk = v.checks.hash && verifyMerkleProof(receipt.payload_hash.toLowerCase(), anchor.proof, anchor.root.toLowerCase());
      const [batch] = await sql`
        SELECT tx_hash, chain FROM receipt_anchor_batches
        WHERE root = ${anchor.root.toLowerCase()} AND tx_hash IS NOT NULL
        LIMIT 1
      `;
      const txOk = Boolean(batch) && (!anchor.tx_hash || String(anchor.tx_hash).toLowerCase() === String(batch.tx_hash).toLowerCase());
      anchorOk = proofOk && txOk;
      if (!proofOk) errors.push("Merkle proof does not lead from payload_hash to anchor.root");
      if (!batch) errors.push("anchor.root is not a root AgentPact anchored");
      else if (!txOk) errors.push("anchor.tx_hash does not match the recorded anchor tx for that root");
    }

    const [record] = await sql`
      SELECT id, superseded_by FROM receipts
      WHERE payload_hash = ${receipt.payload_hash.toLowerCase()} AND signature = ${receipt.signature}
      LIMIT 1
    `;

    return {
      valid: v.valid && anchorOk !== false,
      checks: { ...v.checks, anchor: anchorOk, issuer_record: Boolean(record) },
      receipt_id: record?.id ?? null,
      superseded_by: record?.superseded_by ?? null,
      // Honest scope: the server checks the proof against its own anchor
      // records. Confirming the root is in that tx's calldata on-chain is a
      // public-RPC read anyone can do independently.
      anchor_onchain_checked: false,
      errors,
    };
  });

  app.get("/api/agents/:id/receipts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? "20", 10) || 20, 1), 100);
    const offset = Math.max(Number.parseInt(q.offset ?? "0", 10) || 0, 0);

    const [agent] = UUID.test(id)
      ? await sql`SELECT id, handle, display_name FROM agents WHERE id = ${id} OR handle = ${id} LIMIT 1`
      : await sql`SELECT id, handle, display_name FROM agents WHERE handle = ${id} LIMIT 1`;
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    const agentId = String(agent.id);

    const countRows = await sql<{ outcome: string; capital_at_risk: boolean; n: number }[]>`
      SELECT outcome, capital_at_risk, count(*)::int AS n
      FROM receipts
      WHERE superseded_by IS NULL AND (payer_agent_id = ${agentId} OR payee_agent_id = ${agentId})
      GROUP BY outcome, capital_at_risk
    `;
    const evidence: Counts = {
      settled: 0, refunded: 0, disputed: 0, disputed_buyer_won: 0, disputed_seller_won: 0,
      timed_out: 0, cancelled_after_funding: 0, total: 0,
    };
    let notCounted = 0;
    for (const row of countRows) {
      if (!row.capital_at_risk) { notCounted += row.n; continue; }
      if (row.outcome in evidence) evidence[row.outcome as keyof Counts] += row.n;
      evidence.total += row.n;
    }
    evidence.disputed = evidence.disputed_buyer_won + evidence.disputed_seller_won;

    const rows = await sql`
      SELECT id, deal_id, issued_at, payload, capital_at_risk, qualifying, payer_agent_id,
             (anchor_batch_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM receipt_anchor_batches b WHERE b.id = anchor_batch_id AND b.tx_hash IS NOT NULL
             )) AS anchored
      FROM receipts
      WHERE superseded_by IS NULL AND (payer_agent_id = ${agentId} OR payee_agent_id = ${agentId})
      ORDER BY payload->'timestamps'->>'closed_at' DESC, issued_at DESC, id DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    `;
    const page = rows.slice(0, limit);
    const insufficient = evidence.total < RECEIPT_EVIDENCE_THRESHOLD;

    return {
      agent: { id: agentId, handle: agent.handle, display_name: agent.display_name },
      counts: { evidence, not_counted: notCounted },
      summary: evidenceSummary(evidence),
      evidence_state: insufficient ? "insufficient" : "sufficient",
      evidence_threshold: RECEIPT_EVIDENCE_THRESHOLD,
      evidence_note: insufficient
        ? `Insufficient evidence: ${evidence.total} paid deal${evidence.total === 1 ? "" : "s"} with an independent counterparty ${evidence.total === 1 ? "has" : "have"} closed through escrow. At least ${RECEIPT_EVIDENCE_THRESHOLD} are needed before this record says anything. Each funded deal with a different owner wallet that settles, refunds or is disputed adds one receipt; practice and self-dealt deals never count.`
        : null,
      receipts: page.map((r) => {
        // Read defensively: rows are issuer-written, but a superseded format
        // must not crash the timeline.
        const p = r.payload as Partial<ReceiptPayload>;
        const isPayer = String(r.payer_agent_id) === agentId;
        const other = isPayer ? p.payee : p.payer;
        return {
          id: r.id,
          deal_id: r.deal_id,
          issued_at: r.issued_at,
          closed_at: p.timestamps?.closed_at ?? null,
          outcome: p.outcome,
          role: isPayer ? "payer" : "payee",
          counterparty: { agent_id: other?.agent_id ?? null, handle: other?.handle ?? null },
          notional_base_units: p.amount?.notional_base_units ?? null,
          notional_usdc: formatBaseUnits(p.amount?.notional_base_units),
          fee_base_units: p.amount?.fee_base_units ?? null,
          fee_source: p.amount?.fee_source ?? null,
          acceptance_test: p.acceptance_test ?? null,
          artifact: p.artifact ?? null,
          judge: p.judge ? { judge: p.judge.judge, verdict: p.judge.verdict, p: p.judge.p } : null,
          counts_as_evidence: r.capital_at_risk === true,
          qualifying: r.qualifying === true,
          anchored: r.anchored === true,
          receipt_url: `/api/receipts/${r.id}`,
        };
      }),
      limit,
      offset,
      next_offset: rows.length > limit ? offset + limit : null,
    };
  });
}
