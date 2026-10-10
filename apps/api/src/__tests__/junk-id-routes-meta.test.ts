import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestApp, getAuthHeadersForAgent } from "./helpers/testApp.js";

// Meta-test for the whole junk-:id class (not individual routes).
//
// Every registered route that takes an id-like path param (`:id`, `:agentId`,
// `:dealId`, ...) must reject a non-uuid value as a 400 VALIDATION_FAILED. That
// applies to GET and to the mutating methods (POST/PATCH/PUT/DELETE). The id has
// to be rejected by the route's own param schema, before any SQL runs.
//
// Historically a non-uuid id reached Postgres and raised 22P02. It first surfaced
// as a 500 (the error handler was registered after the routes, see
// error-handler-real-app.test.ts), and later as a 400 DB_DATA_EXCEPTION whose
// `error` echoed the raw driver message ("invalid input syntax for type uuid").
// Both cost a DB round-trip and leaked driver text. The test pins three things:
//   * status 400 with code VALIDATION_FAILED, never DB_DATA_EXCEPTION or a 500;
//   * a zod issue whose path names the id param, so the rejection came from the
//     param schema and not from body validation that happened to fail first;
//   * no Postgres driver text anywhere in the response body.
//
// The route list is NOT hardcoded. It is enumerated from the live Fastify
// instance (`app.printRoutes`), so any /:id route added later is exercised
// automatically and fails here if it does not validate its id.

const JUNK = "not-a-uuid";
const ADMIN_KEY = "test-admin-key-junk-id-meta";
// A fresh agent per run: the shared fixture agent may already be registered
// by an earlier test file (register then answers 409 and yields no key). Its
// id is also sent as `?agentId=` so routes that require it in the query
// (e.g. consultation-responses, fulfillment/audit) get past query validation
// and actually use the junk :id.
const AGENT_ID = randomUUID();

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
type Method = (typeof METHODS)[number];

// Explicit allowlist for routes that cannot be exercised with a junk id
// (auth / contract constraints, or an id param that is not a uuid). Keyed by
// "METHOD /path". Each entry MUST carry a reason. Allowlisted routes are still
// required to answer < 500 without driver text; only the strict 400 +
// VALIDATION_FAILED expectation is relaxed. Stale entries (route no longer
// registered) fail the suite, so this list cannot silently rot.
const ALLOWLIST: Record<string, string> = {
  // "POST /api/example/:id": "reason the route cannot be exercised with a junk id",
};

// Postgres / postgres.js wording that must never reach a client.
const DRIVER_TEXT = /invalid input syntax|for type uuid|22P02|syntax error at or near|postgres/i;

process.env.ADMIN_API_KEY = ADMIN_KEY;
const { app } = await createTestApp();
await app.ready();
const auth = await getAuthHeadersForAgent(AGENT_ID);
if (typeof auth["x-api-key"] !== "string" || auth["x-api-key"].length === 0) {
  throw new Error("junk-id meta-test: could not register a test agent (no api key)");
}

/**
 * Full route paths for one method, parsed from Fastify's route tree.
 * printRoutes nests children under a shared prefix:
 *   ├── /api/deals (GET)
 *   │   └── /:id (GET)
 *   │       └── /fulfillment (GET)
 * so each node's full path is the concatenation of its ancestors' segments.
 */
function enumerateRoutes(method: Method): string[] {
  const tree = app.printRoutes({ commonPrefix: false, method });
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split("\n")) {
    if (line.trim() === "") continue;
    if (line.trim() === "(empty tree)") return []; // no routes for this method
    const m = line.match(/^((?:│ {3}| {4})*)(?:├── |└── )(.*?)(?: \(([^)]*)\))?$/u);
    if (!m) throw new Error(`unparseable printRoutes line: ${JSON.stringify(line)}`);
    const depth = m[1].length / 4;
    stack.length = depth;
    stack.push(m[2]);
    const methods = (m[3] ?? "").split(",").map((s) => s.trim());
    if (methods.includes(method)) out.push(stack.join(""));
  }
  return out;
}

const ID_PARAM = /:[A-Za-z_]*(?:id|Id|ID)(?=\/|$)/;
const ID_PARAM_G = /:([A-Za-z_]*(?:id|Id|ID))(?=\/|$)/g;
const allRoutes = METHODS.flatMap((method) => enumerateRoutes(method).map((path) => ({ method, path })));
const idRoutes = allRoutes.filter((r) => ID_PARAM.test(r.path));
const keyOf = (r: { method: Method; path: string }) => `${r.method} ${r.path}`;
const idRouteKeys = idRoutes.map(keyOf);

function junkUrl(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, JUNK);
}

function idParamNames(path: string): string[] {
  return [...path.matchAll(ID_PARAM_G)].map((m) => m[1]);
}

function inject(method: Method, path: string, headers: Record<string, string>) {
  return app.inject({
    method,
    url: junkUrl(path),
    query: { agentId: AGENT_ID },
    headers,
    // Mutating routes get an empty JSON object: if a handler validated its body
    // before its :id, the issue path would name a body field, not the id, and
    // the path assertion below fails.
    ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }),
  });
}

describe("route enumeration is real (guards the meta-test itself)", () => {
  it("every parsed path is a registered route for its method", () => {
    for (const method of METHODS) {
      if (method === "PUT") continue; // no PUT routes are required to exist
      expect(allRoutes.filter((r) => r.method === method).length, method).toBeGreaterThan(0);
    }
    for (const r of allRoutes) expect(app.hasRoute({ method: r.method, url: r.path }), keyOf(r)).toBe(true);
  });

  it("finds top-level, nested and param-under-param id routes for GET and mutating methods", () => {
    // Anchors only prove the tree parser handles each nesting shape and method;
    // the set under test is whatever the instance reports, not this list.
    expect(idRouteKeys).toContain("GET /api/deals/:id");
    expect(idRouteKeys).toContain("GET /api/deals/:id/fulfillment/audit");
    expect(idRouteKeys).toContain("GET /api/reputation/:agentId");
    expect(idRouteKeys).toContain("POST /api/deals/:id/accept");
    expect(idRouteKeys).toContain("PATCH /api/offers/:id");
    expect(idRouteKeys).toContain("DELETE /api/webhooks/:id");
    expect(idRouteKeys).toContain("POST /api/reputation/:agentId/endorse");
  });

  it("allowlist has no stale entries", () => {
    for (const k of Object.keys(ALLOWLIST)) {
      expect(idRouteKeys, `allowlisted route no longer registered: ${k}`).toContain(k);
      expect(ALLOWLIST[k].trim().length, `allowlist entry needs a reason: ${k}`).toBeGreaterThan(0);
    }
  });
});

describe("junk :id on every registered /:id route -> 400 VALIDATION_FAILED from the param schema", () => {
  for (const route of idRoutes) {
    const key = keyOf(route);
    it(key, async () => {
      const res = await inject(route.method, route.path, { ...auth, "x-admin-api-key": ADMIN_KEY, "x-admin-key": ADMIN_KEY });
      const url = junkUrl(route.path);
      expect(res.statusCode, `${route.method} ${url} -> ${res.statusCode} ${res.body}`).toBeLessThan(500);
      expect(res.body, `${key} leaked driver text`).not.toMatch(DRIVER_TEXT);
      if (Object.hasOwn(ALLOWLIST, key)) return;

      expect(res.statusCode, res.body).toBe(400);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.code, res.body).toBe("VALIDATION_FAILED");
      expect(body.error).toBe("Validation error");
      expect(typeof body.requestId).toBe("string");
      expect(body.requestId).toBe(res.headers["x-request-id"]);
      // Fastify's default error body must not leak through.
      expect(body).not.toHaveProperty("statusCode");
      // The rejection names the id param itself.
      const names = idParamNames(route.path);
      const paths = (Array.isArray(body.details) ? body.details : []).map(
        (d) => (d as { path?: unknown[] }).path?.[0],
      );
      expect(paths.some((p) => names.includes(String(p))), `${key}: no issue on ${names.join("/")} in ${res.body}`).toBe(true);
    });
  }
});

describe("junk :id without credentials -> never 500, never driver text", () => {
  // 401/403 are acceptable here; a 400 must not be the DB_DATA_EXCEPTION path.
  for (const route of idRoutes) {
    const key = keyOf(route);
    it(key, async () => {
      const res = await inject(route.method, route.path, {});
      expect(res.statusCode, `${key} -> ${res.statusCode} ${res.body}`).toBeLessThan(500);
      expect(res.body, `${key} leaked driver text`).not.toMatch(DRIVER_TEXT);
      if (res.statusCode === 400) {
        expect((JSON.parse(res.body) as { code?: unknown }).code, res.body).not.toBe("DB_DATA_EXCEPTION");
      }
    });
  }
});
