import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { receiptsModule } from "../src/tools/receipts.js";
import { toolModules, findToolModule } from "../src/tools/index.js";

type Call = { path: string; method: string; body?: unknown; apiKey?: string };

function recorder(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const api = async (path: string, method: string, body?: unknown, apiKey?: string) => {
    calls.push({ path, method, body, apiKey });
    return responses[`${method} ${path}`] ?? { ok: true };
  };
  return { calls, api };
}

describe("receipts MCP module", () => {
  it("exports exactly the locked tool names, registered in the module registry", () => {
    assert.deepEqual(receiptsModule.tools.map((t) => t.name), ["agentpact.get_receipts", "agentpact.verify_receipt"]);
    assert.ok(toolModules.includes(receiptsModule));
    assert.equal(findToolModule("agentpact.get_receipts")?.id, "receipts");
    assert.equal(findToolModule("agentpact.verify_receipt")?.id, "receipts");
  });

  it("has read-only annotations, descriptions and object input schemas", () => {
    for (const t of receiptsModule.tools) {
      assert.ok((t.description ?? "").length > 60, `${t.name} description too thin`);
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.annotations?.readOnlyHint, true);
      assert.doesNotMatch(t.description ?? "", /trading/i);
    }
    const get = receiptsModule.tools[0];
    assert.deepEqual(get.inputSchema.required, ["agent"]);
  });

  it("get_receipts calls the public timeline route with the handle URL-encoded and pagination passed through", async () => {
    const { calls, api } = recorder();
    await receiptsModule.handle("agentpact.get_receipts", { agent: "seller bot", limit: 5, offset: 10 }, { api });
    assert.deepEqual(calls, [{ path: "/api/agents/seller%20bot/receipts?limit=5&offset=10", method: "GET", body: undefined, apiKey: undefined }]);
    await assert.rejects(receiptsModule.handle("agentpact.get_receipts", {}, { api }), /agent is required/);
  });

  it("verify_receipt accepts a receipt_id, the GET response, or the bare envelope", async () => {
    const fetched = { receipt: { version: "apr-1" }, anchor: null };
    const { calls, api } = recorder({ "GET /api/receipts/11111111-1111-4111-8111-111111111111": fetched });
    await receiptsModule.handle("agentpact.verify_receipt", { receipt_id: "11111111-1111-4111-8111-111111111111" }, { api });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /api/receipts/11111111-1111-4111-8111-111111111111", "POST /api/receipts/verify"]);
    assert.deepEqual(calls[1].body, fetched);

    const envelope = { version: "apr-1", key_id: "k", payload: {}, payload_hash: "00", signature: "AA" };
    await receiptsModule.handle("agentpact.verify_receipt", { receipt: envelope }, { api });
    assert.deepEqual(calls[2].body, { receipt: envelope });
    await receiptsModule.handle("agentpact.verify_receipt", { receipt: fetched }, { api });
    assert.deepEqual(calls[3].body, fetched);

    await assert.rejects(receiptsModule.handle("agentpact.verify_receipt", {}, { api }), /receipt_id or receipt/);
  });
});
