import { beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./helpers/testApp.js";
import { isSuggestible, routeCost, suggestRoutes, type KnownRoute } from "../lib/route-suggest.js";
import { NOT_FOUND_PER_MINUTE } from "../index.js";

// ah_1016 — unknown routes are 404 ROUTE_NOT_FOUND + didYouMean, not 401.
//
// Live 2026-10-16: POST https://api.agentpact.xyz/api/deals and
// GET /api/zzz/nonexistent both answered 401 {error:"Missing API key"}, even
// with a fake key. The auth preHandler ran for the not-found handler, so a
// caller who guessed the path was told to fix auth. RED on the pre-fix tree:
// the unmatched-path cases return 401 and ../lib/route-suggest does not exist.

describe("ROUTE_NOT_FOUND envelope (real app)", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await app.ready();
  });

  it("POST /api/deals with no key is a 404 that points at /api/deals/propose", async () => {
    const res = await app.inject({ method: "POST", url: "/api/deals", payload: {} });
    expect(res.statusCode, res.body).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("ROUTE_NOT_FOUND");
    expect(body.error).toBe("Route POST /api/deals not found");
    expect(body.requestId).toBe(res.headers["x-request-id"]);
    expect(body.didYouMean).toContain("POST /api/deals/propose");
    // only POST siblings: a POST caller is never pointed at a GET-only route first
    expect(body.didYouMean[0]).toMatch(/^POST \/api\/deals\//);
  });

  it("a fake key does not change the answer to 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/zzz/nonexistent?x=1",
      headers: { "x-api-key": "ap_fake_key" },
    });
    expect(res.statusCode, res.body).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("ROUTE_NOT_FOUND");
    expect(Array.isArray(body.didYouMean)).toBe(true);
  });

  it("an oversized miss is answered fast with no suggestions (review r1: CPU amplifier)", async () => {
    const t0 = performance.now();
    const res = await app.inject({ method: "GET", url: `/api/${"x".repeat(7000)}` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).didYouMean).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("never advertises admin/operator routes to an anonymous caller (review r1)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/force-releas", payload: {} });
    expect(res.statusCode).toBe(404);
    const s: string[] = JSON.parse(res.body).didYouMean;
    expect(s.some((r) => r.includes("/api/admin/"))).toBe(false);
  });

  it("misses are rate-limited per IP even with rotating fake keys (review r1)", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < NOT_FOUND_PER_MINUTE; i++) {
      const r = await app.inject({ method: "GET", url: "/api/nope", remoteAddress: ip, headers: { "x-api-key": `fake-${i}` } });
      expect(r.statusCode).toBe(404);
    }
    const over = await app.inject({ method: "GET", url: "/api/nope", remoteAddress: ip, headers: { "x-api-key": "fake-x" } });
    expect(over.statusCode, over.body).toBe(429);
    // a different client is unaffected
    const other = await app.inject({ method: "GET", url: "/api/nope", remoteAddress: "203.0.113.78" });
    expect(other.statusCode).toBe(404);
  });

  it("behind the proxy, clients are told apart by cf-connecting-ip, not the proxy address", async () => {
    const proxy = "198.51.100.1";
    for (let i = 0; i < NOT_FOUND_PER_MINUTE; i++) {
      await app.inject({ method: "GET", url: "/api/nope2", remoteAddress: proxy, headers: { "cf-connecting-ip": "192.0.2.10" } });
    }
    const limited = await app.inject({ method: "GET", url: "/api/nope2", remoteAddress: proxy, headers: { "cf-connecting-ip": "192.0.2.10" } });
    expect(limited.statusCode).toBe(429);
    const neighbour = await app.inject({ method: "GET", url: "/api/nope2", remoteAddress: proxy, headers: { "cf-connecting-ip": "192.0.2.11" } });
    expect(neighbour.statusCode).toBe(404);
  });

  it("a REAL route still requires auth (the guard skips only unmatched paths)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/deals/propose", payload: {} });
    expect(res.statusCode, res.body).toBe(401);
  });
});

describe("suggestRoutes (pure)", () => {
  const routes: KnownRoute[] = [
    { method: "POST", url: "/api/deals/propose" },
    { method: "GET", url: "/api/deals/:id" },
    { method: "GET", url: "/api/deals" },
    { method: "POST", url: "/api/needs/:id/respond" },
    { method: "HEAD", url: "/api/deals" },
    { method: "GET", url: "/api/leaderboard" },
  ];

  it("ranks the same-method sibling first", () => {
    expect(suggestRoutes("POST", "/api/deals", routes)[0]).toBe("POST /api/deals/propose");
  });

  it("treats :param as a wildcard and tolerates typos", () => {
    expect(routeCost("POST", "/api/needs/abc/respond", routes[3])).toBe(0);
    expect(suggestRoutes("POST", "/api/needs/abc/respnd", routes)).toContain("POST /api/needs/:id/respond");
    expect(suggestRoutes("GET", "/api/leaderbord", routes)[0]).toBe("GET /api/leaderboard");
  });

  it("filters internal surfaces and enforces the work budget", () => {
    expect(isSuggestible("/api/admin/force-release")).toBe(false);
    expect(isSuggestible("/api/audit/orders/:id/claim")).toBe(false);
    expect(isSuggestible("/api/deals/:id/fulfillment/auto-complete")).toBe(false);
    expect(isSuggestible("/api/disputes/resolve-timeouts")).toBe(false);
    expect(isSuggestible("/api/deals/propose")).toBe(true);
    expect(suggestRoutes("POST", "/api/" + "d".repeat(49), routes)).toEqual([]);
    expect(suggestRoutes("POST", "/api" + "/a".repeat(11), routes)).toEqual([]);
  });

  it("never suggests HEAD, the exact path itself, or unrelated routes", () => {
    const s = suggestRoutes("GET", "/api/zzz/nonexistent/deeper/still", routes);
    expect(s).toEqual([]);
    expect(suggestRoutes("GET", "/api/deals", routes)).not.toContain("HEAD /api/deals");
    expect(suggestRoutes("GET", "/api/deals", routes)).not.toContain("GET /api/deals");
  });
});
