import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// Meta-test for the whole junk-:id class (not individual routes).
//
// Every registered GET route that takes an id-like path param (`:id`,
// `:agentId`, `:dealId`, ...) must answer a non-uuid value with a 4xx in the
// documented error envelope -- never a 500. Historically a non-uuid id reached
// Postgres, raised 22P02 and surfaced as a 500 leaking the raw driver message,
// because routes registered before `app.setErrorHandler` kept Fastify's default
// handler (see error-handler-real-app.test.ts for the ordering regression).
//
// The route list is NOT hardcoded: it is enumerated from the live Fastify
// instance (`app.printRoutes`), so a /:id GET route added in the future is
// exercised automatically and fails here if the global handler does not cover
// it (or if it does not validate its id).

const JUNK = "not-a-uuid";
const ADMIN_KEY = "test-admin-key-junk-id-meta";
// A fresh agent per run: the shared fixture agent may already be registered
// by an earlier test file (register then answers 409 and yields no key). Its
// id is also sent as `?agentId=` so routes that require it in the query
// (e.g. consultation-responses, fulfillment/audit) get past query validation
// and actually use the junk :id.
const AGENT_ID = randomUUID();

// Explicit allowlist for routes that cannot be exercised with a junk id
// (auth / contract constraints). Each entry MUST carry a reason. Allowlisted
// routes are still required to answer < 500; only the strict 400 + envelope
// expectation is relaxed. Stale entries (route no longer registered) fail the
// suite, so this list cannot silently rot. Empty today: every route complies.
const ALLOWLIST: Record<string, string> = {
  // "/api/example/:id": "reason the route cannot be exercised with a junk id",
};

const ENVELOPE_CODES = ["DB_DATA_EXCEPTION", "VALIDATION_FAILED"];

process.env.ADMIN_API_KEY = ADMIN_KEY;
const { app } = await createTestApp();
await app.ready();
const auth = await getAuthHeadersForAgent(AGENT_ID);
if (typeof auth["x-api-key"] !== "string" || auth["x-api-key"].length === 0) {
  throw new Error("junk-id meta-test: could not register a test agent (no api key)");
}

/**
 * Full GET route paths, parsed from Fastify's route tree. printRoutes nests
 * children under a shared prefix:
 *   ├── /api/deals (GET)
 *   │   └── /:id (GET)
 *   │       └── /fulfillment (GET)
 * so each node's full path is the concatenation of its ancestors' segments.
 */
function enumerateGetRoutes(): string[] {
  const tree = app.printRoutes({ commonPrefix: false, method: "GET" });
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split("\n")) {
    if (line.trim() === "") continue;
    const m = line.match(/^((?:│ {3}| {4})*)(?:├── |└── )(.*?)(?: \(([^)]*)\))?$/u);
    if (!m) throw new Error(`unparseable printRoutes line: ${JSON.stringify(line)}`);
    const depth = m[1].length / 4;
    stack.length = depth;
    stack.push(m[2]);
    const methods = (m[3] ?? "").split(",").map((s) => s.trim());
    if (methods.includes("GET")) out.push(stack.join(""));
  }
  return out;
}

const ID_PARAM = /:[A-Za-z_]*(?:id|Id|ID)(?=\/|$)/;
const allGet = enumerateGetRoutes();
const idRoutes = allGet.filter((p) => ID_PARAM.test(p));

describe("route enumeration is real (guards the meta-test itself)", () => {
  it("every parsed path is a registered GET route", () => {
    expect(allGet.length).toBeGreaterThan(0);
    for (const p of allGet) expect(app.hasRoute({ method: "GET", url: p }), p).toBe(true);
  });

  it("finds top-level, nested and param-under-param id routes", () => {
    // Anchors only prove the tree parser handles each nesting shape; the set
    // under test is whatever the instance reports, not this list.
    expect(idRoutes).toContain("/api/deals/:id");
    expect(idRoutes).toContain("/api/deals/:id/fulfillment/audit");
    expect(idRoutes).toContain("/api/reputation/:agentId");
  });

  it("allowlist has no stale entries", () => {
    for (const p of Object.keys(ALLOWLIST)) {
      expect(idRoutes, `allowlisted route no longer registered: ${p}`).toContain(p);
      expect(ALLOWLIST[p].trim().length, `allowlist entry needs a reason: ${p}`).toBeGreaterThan(0);
    }
  });
});

describe("junk :id on every registered GET /:id route -> 400 envelope, never 500", () => {
  for (const route of idRoutes) {
    it(`GET ${route}`, async () => {
      const url = route.replace(/:[A-Za-z0-9_]+/g, JUNK);
      const res = await app.inject({
        method: "GET",
        url,
        query: { agentId: AGENT_ID },
        headers: { ...auth, "x-admin-api-key": ADMIN_KEY },
      });
      expect(res.statusCode, `${url} -> ${res.statusCode} ${res.body}`).toBeLessThan(500);
      if (Object.hasOwn(ALLOWLIST, route)) return;

      expect(res.statusCode, res.body).toBe(400);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(ENVELOPE_CODES, res.body).toContain(body.code);
      expect(typeof body.error).toBe("string");
      expect(typeof body.requestId).toBe("string");
      expect(body.requestId).toBe(res.headers["x-request-id"]);
      // Fastify's default error body must not leak through.
      expect(body).not.toHaveProperty("statusCode");
    });
  }
});
