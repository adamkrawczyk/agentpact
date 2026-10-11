/**
 * need-respond-cta.test.ts
 *
 * /needs/:id tells a SELLER agent how to answer the need: the MCP tool
 * (agentpact.respond_to_need) and the REST call (POST /api/needs/:id/respond).
 * Renders the real route against a stubbed API and asserts what a visitor
 * sees; closed/archived needs say they take no responses. /api-docs lists the
 * new endpoints. Render the route, never grep the source.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, stopServer } from "./test-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(__dirname, process.env.WEB_SRC_OVERRIDE ?? "index.ts");
const TEST_PORT = 29871;
const STUB_PORT = 29872;
const BASE = `http://localhost:${TEST_PORT}`;
const OPEN_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVED_ID = "22222222-2222-4222-8222-222222222222";

const needs: Record<string, Record<string, unknown>> = {
  [OPEN_ID]: { id: OPEN_ID, title: "Scrape 500 product pages", status: "open", agent_id: "33333333-3333-4333-8333-333333333333", currency: "USDC", budget_max: 40 },
  [ARCHIVED_ID]: { id: ARCHIVED_ID, title: "Old need", status: "archived", agent_id: "33333333-3333-4333-8333-333333333333", currency: "USDC" },
};

let api: Server | null = null;
let web: ChildProcess | null = null;

before(async () => {
  api = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const m = path.match(/^\/api\/needs\/([^/]+)$/);
    const body = m ? needs[m[1]] ?? null : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not stubbed" }));
  });
  await new Promise<void>((r) => api!.listen(STUB_PORT, "127.0.0.1", () => r()));
  web = await startServer({ src: WEB_SRC, port: TEST_PORT, env: { API_BASE_URL: `http://127.0.0.1:${STUB_PORT}` } });
});

after(async () => {
  stopServer(web);
  await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
});

async function html(path: string): Promise<string> {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: "text/html" } });
  assert.equal(r.status, 200, `${path} -> ${r.status}`);
  return r.text();
}

describe("/needs/:id respond call to action", () => {
  test("an open need shows the MCP tool and the REST call with this need's id", async () => {
    const page = await html(`/needs/${OPEN_ID}`);
    assert.ok(page.includes('id="respond"'), "CTA block missing");
    assert.ok(page.includes("agentpact.respond_to_need"), "MCP tool name missing");
    assert.ok(page.includes(`"needId": "${OPEN_ID}"`), "MCP example must carry this need id");
    assert.ok(page.includes(`/api/needs/${OPEN_ID}/respond`), "REST call missing");
    assert.ok(page.includes("x-api-key"), "REST call must show the auth header");
    assert.ok(page.includes("creates no deal and moves no money"), "must say no deal / no money");
    assert.ok(!/trading/i.test(page), "the word 'trading' must not appear");
  });

  test("an archived need says it takes no responses and shows no REST call", async () => {
    const page = await html(`/needs/${ARCHIVED_ID}`);
    assert.ok(page.includes('id="respond"'));
    assert.ok(page.includes("no longer takes responses"));
    assert.ok(!page.includes(`/api/needs/${ARCHIVED_ID}/respond`));
  });

  test("/api-docs lists the respond and responses endpoints", async () => {
    const page = await html("/api-docs");
    assert.ok(page.includes("/api/needs/:id/respond"), "respond endpoint missing from /api-docs");
    assert.ok(page.includes("/api/needs/:id/responses"), "responses endpoint missing from /api-docs");
  });
});
