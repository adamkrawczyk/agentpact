import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import configRoutes from "../routes/config.js";
import { ESCROW_ADDRESS, USDC_ADDRESS } from "../chain.js";

/**
 * escrow-safety rollout — SDK-address-match sub-acceptance — regression contract:
 *   1. /api/config/addresses MUST return the same constants the API uses
 *      internally for on-chain calls. If the constants drift, the SDK and the
 *      contract that actually holds funds will disagree → money goes to wrong
 *      address. This test pins the symmetry.
 *   2. Endpoint is publicly readable (no auth) — chain addresses are public.
 *   3. Response shape is stable: { chainId, network, escrow, usdc }. Adding
 *      fields is OK; removing or renaming breaks SDK consumers.
 */
describe("GET /api/config/addresses", () => {
  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(configRoutes);
    await app.ready();
    return app;
  }

  it("returns 200 with chain-config payload", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/config/addresses" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      chainId: 8453,
      network: "base",
    });
    expect(typeof body.escrow).toBe("string");
    expect(typeof body.usdc).toBe("string");
    expect(body.escrow).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(body.usdc).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("returns the SAME addresses the API uses internally (symmetry contract)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/config/addresses" });
    const body = res.json();
    // The endpoint and chain.ts MUST agree. If this fails, the SDK that fetches
    // /api/config/addresses will tell agents to send funds somewhere the API
    // doesn't accept. Money-loss class bug.
    expect(body.escrow).toBe(ESCROW_ADDRESS);
    expect(body.usdc).toBe(USDC_ADDRESS);
  });

  it("does not require auth (chain addresses are public)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/config/addresses" });
    // No X-API-Key header sent; endpoint must answer anyway.
    expect(res.statusCode).toBe(200);
  });
});
