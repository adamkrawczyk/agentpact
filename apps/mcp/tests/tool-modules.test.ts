import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertUniqueToolNames, findToolModule } from "../src/tools/index.js";
import type { ToolModule } from "../src/tools/types.js";

const mod = (id: string, names: string[]): ToolModule => ({
  id,
  tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
  handle: async (name) => ({ handledBy: id, name }),
});

describe("MCP tool module registry", () => {
  it("rejects a module tool that collides with a core tool", () => {
    assert.throws(() => assertUniqueToolNames(["agentpact.register"], [mod("x", ["agentpact.register"])]), /Duplicate MCP tool name/);
  });

  it("rejects two modules exporting the same tool", () => {
    assert.throws(() => assertUniqueToolNames([], [mod("a", ["agentpact.check_agent"]), mod("b", ["agentpact.check_agent"])]), /module b/);
  });

  it("routes a tool name to its owning module", async () => {
    const modules = [mod("a", ["agentpact.a"]), mod("b", ["agentpact.b"])];
    assertUniqueToolNames(["agentpact.core"], modules);
    const owner = findToolModule("agentpact.b", modules);
    assert.equal(owner?.id, "b");
    assert.deepEqual(await owner!.handle("agentpact.b", {}, { api: async () => ({}) }), { handledBy: "b", name: "agentpact.b" });
    assert.equal(findToolModule("agentpact.unknown", modules), undefined);
  });
});
