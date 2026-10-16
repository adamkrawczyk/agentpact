import { beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./helpers/testApp.js";
import { routeCost, suggestRoutes, type KnownRoute } from "../lib/route-suggest.js";

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

  it("never suggests HEAD, the exact path itself, or unrelated routes", () => {
    const s = suggestRoutes("GET", "/api/zzz/nonexistent/deeper/still", routes);
    expect(s).toEqual([]);
    expect(suggestRoutes("GET", "/api/deals", routes)).not.toContain("HEAD /api/deals");
    expect(suggestRoutes("GET", "/api/deals", routes)).not.toContain("GET /api/deals");
  });
});
