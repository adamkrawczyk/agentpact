# Production Debug Report — AgentPact API

**Date:** 2026-02-25  
**Issues investigated:**
1. `POST /api/offers` sometimes hangs / times out (no response within 8s)
2. `POST /api/deals/:id/accept` returns `{"ok":true}` but deal status stays `proposed`

---

## 1. Deployment State: Which Code is Running?

### Finding: Production is on `main` branch; local has 3 unreleased commits

```
Local branch:  feat/autopilot-sprint  (3 commits AHEAD of main)
Origin/main:   03adb09  (what Railway deploys)
```

The 3 extra commits on `feat/autopilot-sprint` are **not deployed**. They include:
- `d4fd801` fix: default skipOnChainRelease to false — all deals now release on-chain
- `28abe3a` feat: merge semantic matching + autopilot (sprint day 1)  
- `1b42a23` feat: auto-deal matchmaker (autopilot/run endpoint)

**What this means:** The accept endpoint and offers endpoint in production are the versions on `origin/main` (commit `03adb09`). The local `feat/autopilot-sprint` branch adds semantic matching (`semantic-match.ts`, embedding generation, autopilot), which are NOT yet in production.

---

## 2. Bug #1: `POST /api/offers` Hangs — `recomputeMatches()` is Synchronous and Unbounded

### Root Cause

In `apps/api/src/index.ts`, the `/api/offers` handler calls `recomputeMatches()` inline, before sending the response:

```ts
app.post("/api/offers", async (request, reply) => {
  // ... insert offer ...
  await audit(...);
  await recomputeMatches();   // <-- BLOCKS the response
  return reply.code(201).send(offer);
});
```

`recomputeMatches()` does:
1. `SELECT *` from all active offers (N rows, with full rows including JSONB)
2. `SELECT *` from all open needs (M rows)
3. For **every offer × need pair** with tag overlap: runs an individual `INSERT ... ON CONFLICT DO UPDATE` query

This is **O(N×M) sequential DB queries** on the hot path. With even 50 offers and 50 needs, that's potentially 2,500 queries before the user gets their 201 response.

The same `recomputeMatches()` call is also triggered from:
- `POST /api/needs` (create/update)
- `POST /api/matches/recompute`
- `PATCH /api/offers/:id`

So concurrent `POST /api/offers` and `POST /api/needs` requests will each kick off N×M DB writes — rapidly exhausting the 10-connection pool.

### On `feat/autopilot-sprint`: Additionally Calls OpenAI

The semantic matching branch calls `generateEmbeddings(allTexts)` (an OpenAI API call for ALL texts in the DB) inside `recomputeMatches()` before each write pass. This adds external network latency on top of the DB exhaustion.

### Connection Pool Analysis

```ts
export const sql = postgres(DATABASE_URL, { max: 10 });
```

Pool max = **10 connections** against a Supabase free tier which caps at ~15-20 connections.

During a concurrent burst:
- Each `recomputeMatches()` call holds connection(s) for the duration of all N×M writes
- Multiple concurrent offer/need POSTs will fully consume the pool
- Subsequent queries (including health checks, accept, etc.) will queue or timeout waiting for a free connection

This explains the **"sometimes hangs"** pattern — it's load-dependent. Under normal light load it's fine; under any moderate burst it deadlocks.

---

## 3. Bug #2: `POST /api/deals/:id/accept` Returns `{ok:true}` but Status Stays `proposed`

### Root Cause A: INNER JOIN on `offer_id` silently fails

The accept endpoint fetches the deal with:
```ts
const [deal] = await sql`
  SELECT d.buyer_agent_id, d.seller_agent_id, o.fulfillment_type
  FROM deals d
  JOIN offers o ON o.id = d.offer_id   // <-- INNER JOIN
  WHERE d.id = ${id}
`;
```

If the linked offer has been **archived** (`status = 'archived'`) OR **deleted** since the deal was proposed, this `JOIN offers` still works (the row exists). However, if `offer_id` is NULL (deals created without an offer), the INNER JOIN returns no rows. In that case:

```ts
if (!deal) return reply.code(404).send({ error: "Deal not found" });
```

This returns a 404, not `{ok:true}` — so this isn't the primary bug, but it's a footgun for deals created without offers.

### Root Cause B: Transaction silently swallowed when pool is exhausted

When the connection pool is exhausted (see Bug #1), `sql.begin()` will wait indefinitely for a connection, or throw a connection timeout error. If Fastify times out the request before the DB connection is acquired, the client sees the connection close — but in some configurations the underlying promise resolves anyway and the Fastify handler sends `{ok:true}` because it runs to completion after the client already disconnected.

More specifically: the transaction block has **no error handling**:
```ts
await sql.begin(async (txn) => {
  await txn.unsafe("UPDATE deals SET status = 'active' ...", [id]);
  // ...
});
// No try/catch! If sql.begin throws due to pool exhaustion:
// - postgres.js will auto-ROLLBACK the transaction
// - The error propagates to Fastify's error handler
// - BUT: if this is a connection acquire timeout, the error may be swallowed
//   depending on how postgres.js handles the pool queue timeout

return { ok: true };  // <-- This still runs if the handler doesn't throw
```

### Root Cause C: `negotiation_events` table insert may fail silently

If the `negotiation_events` table doesn't exist or has schema issues from failed migrations, the `INSERT INTO negotiation_events` inside the transaction will throw, causing the whole transaction to ROLLBACK. The deal stays `proposed`. The error propagates up but — critically — Fastify's global error handler converts it to a 500, not `{ok:true}`. However, if there's a race condition where the error happens asynchronously (e.g., in `notifyAgents`), it can be swallowed.

### Root Cause D (Most Likely): Transaction completes but `notifyAgents` error is mistaken for accept failure

`notifyAgents` is fire-and-forget (unawaited in the webhook delivery path), but the function itself awaits webhook delivery. If there's an error in `notifyAgents` that is caught internally, the deal IS updated but the client might be retrying because they think it failed.

**To verify:** Query the DB directly:
```sql
SELECT id, status, updated_at FROM deals WHERE id = '<deal-id>';
SELECT * FROM negotiation_events WHERE deal_id = '<deal-id>';
```

If `status = 'active'` in the DB but the client sees `proposed`, the bug is in the client re-reading stale data (caching/eventual consistency). If `status = 'proposed'` after accept, it's the transaction rollback.

---

## 4. Proposed Fixes

### Fix 1: Make `recomputeMatches()` Asynchronous (Fire-and-Forget with Error Isolation)

**Impact:** Eliminates the POST /api/offers hang completely.

Change from:
```ts
await recomputeMatches();
return reply.code(201).send(offer);
```

To:
```ts
// Don't await — fire and forget. Matches will update in background.
recomputeMatches().catch((err) => {
  app.log.error({ err }, "recomputeMatches failed");
});
return reply.code(201).send(offer);
```

This is already safe because `recomputeMatches()` uses `ON CONFLICT DO UPDATE` — concurrent runs are idempotent.

### Fix 2: Add Request Timeout Middleware

```ts
app.addHook('onRequest', async (request, reply) => {
  const timeoutMs = 15_000; // 15s max per request
  const timer = setTimeout(() => {
    if (!reply.sent) {
      app.log.warn({ url: request.url }, 'Request timeout — forcing 503');
      reply.code(503).send({ error: 'Request timeout' });
    }
  }, timeoutMs);
  reply.raw.on('finish', () => clearTimeout(timer));
});
```

### Fix 3: Increase Connection Pool + Add Idle Timeout

```ts
export const sql = postgres(DATABASE_URL, {
  max: 20,              // Up from 10 (Supabase free supports ~20; paid plans: 60+)
  idle_timeout: 30,     // Release idle connections after 30s
  connect_timeout: 10,  // Fail fast if can't connect in 10s
  max_lifetime: 1800,   // Recycle connections every 30 min
});
```

### Fix 4: Add `try/catch` and Status Check to Accept Endpoint

```ts
app.post("/api/deals/:id/accept", async (request, reply) => {
  // ... existing auth checks ...

  // Verify deal is in 'proposed' status before accepting
  const [deal] = await sql`
    SELECT d.buyer_agent_id, d.seller_agent_id, d.status,
           COALESCE(o.fulfillment_type, 'generic') AS fulfillment_type
    FROM deals d
    LEFT JOIN offers o ON o.id = d.offer_id  -- LEFT JOIN: handle deals without offers
    WHERE d.id = ${id}
  `;
  if (!deal) return reply.code(404).send({ error: "Deal not found" });
  if (deal.status !== 'proposed') {
    return reply.code(409).send({ error: `Deal is already ${deal.status}` });
  }
  if (body.actorAgentId !== deal.seller_agent_id) {
    return reply.code(403).send({ error: "Not authorized" });
  }

  try {
    await sql.begin(async (txn) => {
      const [updated] = await txn.unsafe(
        "UPDATE deals SET status = 'active', updated_at = NOW() WHERE id = $1 AND status = 'proposed' RETURNING id",
        [id]
      );
      if (!updated) throw new Error("Deal status changed concurrently — not in proposed state");
      await txn.unsafe("UPDATE milestones SET status = 'in_progress' WHERE deal_id = $1 AND status = 'pending'", [id]);
      await txn.unsafe(
        `INSERT INTO deal_fulfillment (deal_id, fulfillment_type, status)
         VALUES ($1, $2, 'pending') ON CONFLICT (deal_id) DO NOTHING`,
        [id, deal.fulfillment_type]
      );
      await txn.unsafe(
        `INSERT INTO negotiation_events (deal_id, actor_agent_id, event_type, payload_json)
         VALUES ($1, $2, 'accept', $3::jsonb)`,
        [id, body.actorAgentId, JSON.stringify(body)]
      );
    });
  } catch (err) {
    app.log.error({ err, dealId: id }, "deal.accept transaction failed");
    return reply.code(500).send({ error: "Failed to accept deal — transaction rolled back" });
  }

  // Fire-and-forget notification
  notifyAgents(sql, [deal.buyer_agent_id, deal.seller_agent_id], "deal.accepted", {
    dealId: id,
    acceptedBy: body.actorAgentId,
    fulfillmentType: deal.fulfillment_type,
    sellerActionRequired: "Provide fulfillment details via /api/deals/:id/fulfillment",
  });

  return { ok: true };
});
```

Key changes:
- **LEFT JOIN** instead of INNER JOIN so deals without offers don't 404
- **Status check** (`WHERE status = 'proposed'`) with `RETURNING id` to detect concurrent state changes
- **`try/catch`** around `sql.begin()` to return a proper 500 instead of `{ok:true}` on DB failure
- **Idempotency guard**: returns 409 if deal is already accepted

### Fix 5: Add `/api/health/pool` Monitoring Endpoint

```ts
app.get("/health/pool", async () => {
  const pool = sql as any;
  return {
    totalConnections: pool.totalCount ?? 'n/a',
    idleConnections: pool.idleCount ?? 'n/a',
    waitingRequests: pool.waitingCount ?? 'n/a',
    maxConnections: 20,
  };
});
```

### Fix 6: Batch `recomputeMatches()` with UPSERT

Replace N×M individual queries with a single bulk upsert:
```ts
// Build all (offer, need, score) tuples in JS, then do one INSERT ... ON CONFLICT
const rows = [];
for (const offer of offers) {
  for (const need of needs) {
    // compute score
    rows.push({ offerId: offer.id, needId: need.id, score, reasonJson });
  }
}
// Single multi-row upsert
if (rows.length > 0) {
  await sql`
    INSERT INTO matches (offer_id, need_id, score, reason_json)
    SELECT * FROM ${sql(rows.map(r => [r.offerId, r.needId, r.score, r.reasonJson]))}
    ON CONFLICT (offer_id, need_id) DO UPDATE SET score = EXCLUDED.score, reason_json = EXCLUDED.reason_json
  `;
}
```

---

## 5. Summary Table

| Issue | Root Cause | Fix | Priority |
|-------|-----------|-----|----------|
| `POST /api/offers` hangs | `recomputeMatches()` runs N×M sequential DB queries synchronously in request handler | Fire-and-forget + batch upsert | 🔴 Critical |
| Connection pool exhaustion | `max: 10` too low; recomputeMatches() holds connections long | Raise pool to 20, add idle_timeout | 🔴 Critical |
| `accept` returns ok but status unchanged | No try/catch on `sql.begin()`; INNER JOIN misses deals without offers; no status pre-check | LEFT JOIN + status check + try/catch | 🟠 High |
| Silent error swallowing | No request-level timeout; errors in background tasks go unreported | Request timeout hook + error logging | 🟠 High |
| Railway deployment unclear | No `railway.json` or `railway.toml`; Railway likely auto-deploys from `main` branch | Merge `feat/autopilot-sprint` to main if ready, or verify Railway config | 🟡 Medium |

---

## 6. Immediate Actions

1. **Merge or cherry-pick fixes** to `main` branch so Railway deploys them
2. **Monitor** `/health/detailed` — DB shows healthy so pool isn't permanently exhausted
3. **Check Railway dashboard** for recent deployment SHA — confirm it matches `git rev-parse origin/main`
4. **Query production DB directly** for any deals stuck in `proposed` after an accept call:
   ```sql
   SELECT d.id, d.status, ne.event_type, ne.created_at
   FROM deals d
   LEFT JOIN negotiation_events ne ON ne.deal_id = d.id AND ne.event_type = 'accept'
   WHERE ne.id IS NOT NULL AND d.status = 'proposed';
   ```
5. **Check Supabase connection limits** — free tier: 15 connections max. With `max: 10` in the pool, any second API instance would exceed this.
