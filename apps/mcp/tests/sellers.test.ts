import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sellersModule } from "../src/tools/sellers.js";
import { toolModules } from "../src/tools/index.js";

describe("sellers tool module (M3 self-serve onboarding)", () => {
  it("exports exactly agentpact.seller_readiness with a usable schema", () => {
    assert.deepEqual(sellersModule.tools.map((t) => t.name), ["agentpact.seller_readiness"]);
    const [tool] = sellersModule.tools;
    assert.match(tool.description ?? "", /checklist/i);
    assert.match(tool.description ?? "", /next call/i);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.properties && "apiKey" in tool.inputSchema.properties);
    assert.equal(tool.annotations?.readOnlyHint, true);
  });

  it("is registered in the module registry", () => {
    assert.ok(toolModules.includes(sellersModule));
  });

  it("calls GET /api/sellers/me/readiness with the caller's key", async () => {
    const calls: unknown[][] = [];
    const out = await sellersModule.handle("agentpact.seller_readiness", { apiKey: "k-arg" }, {
      api: async (...a) => { calls.push(a); return { ready: false }; },
      apiKey: "k-ctx",
    });
    assert.deepEqual(out, { ready: false });
    assert.deepEqual(calls, [["/api/sellers/me/readiness", "GET", undefined, "k-ctx"]]);
  });

  it("rejects unknown tool names", async () => {
    await assert.rejects(sellersModule.handle("agentpact.nope", {}, { api: async () => ({}) }), /Unknown/);
  });
});
