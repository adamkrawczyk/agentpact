/**
 * base-legal-routes.test.ts
 *
 * /terms, /privacy, /base, the square icons and /og-image.png (Base ecosystem
 * listing, 2026-10-07). Spawns the web server from the REPO ROOT, the prod pm2
 * layout (cwd = /opt/agentpact-app), because that is where /og-image.png used
 * to 404: the route resolved only against cwd while the file lives in apps/web/.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, stopServer } from "./test-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(__dirname, "index.ts");
const REPO_ROOT = resolve(__dirname, "../../..");
const TEST_PORT = 29851;
const BASE = `http://localhost:${TEST_PORT}`;
const ESCROW = "0x588168712bF758aFD747bF46471afa53f9599A64";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

let server: ChildProcess | null = null;

before(async () => {
  // cwd = repo root: the prod pm2 layout
  server = await startServer({ src: WEB_SRC, port: TEST_PORT, cwd: REPO_ROOT, env: { API_BASE_URL: "http://localhost:1" } });
});

after(async () => {
  stopServer(server);
});

function pngSize(buf: Buffer): [number, number] {
  assert.equal(buf.subarray(1, 4).toString("ascii"), "PNG", "not a PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe("legal pages", () => {
  test("/terms renders the operator, fee and dispute rules", async () => {
    const r = await fetch(`${BASE}/terms`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Adam Krawczyk, sole trader, Kraków, Poland/);
    assert.match(html, /Last updated: \d{4}-\d{2}-\d{2}/);
    assert.ok(html.includes(ESCROW), "escrow address missing");
    assert.match(html, /90% to the seller and 10% to the platform/);
    assert.match(html, /resolver of last resort/);
    assert.match(html, /<link rel="canonical" href="https:\/\/agentpact\.xyz\/terms"/);
  });

  test("/privacy renders controller, processors and rights", async () => {
    const r = await fetch(`${BASE}/privacy`);
    assert.equal(r.status, 200);
    const html = await r.text();
    for (const needle of ["Controller", "Hetzner", "Stripe", "Resend", "OpenAI", "uodo.gov.pl", "SHA-256"]) {
      assert.ok(html.includes(needle), `privacy page missing ${needle}`);
    }
  });
});

describe("/base landing page", () => {
  test("is Base-specific: contract, USDC, BaseScan, fee, no token", async () => {
    const r = await fetch(`${BASE}/base`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes(ESCROW));
    assert.ok(html.includes(USDC));
    assert.ok(html.includes(`https://basescan.org/address/${ESCROW}`));
    assert.match(html, /10%, fixed at deployment/);
    assert.match(html, /none, and none planned/);
    assert.match(html, /href="\/terms"/);
    assert.match(html, /href="\/privacy"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/agentpact\.xyz\/base"/);
  });

  test("every page footer links Terms, Privacy and Base", async () => {
    const html = await (await fetch(`${BASE}/mcp-setup`)).text();
    for (const href of ['href="/terms"', 'href="/privacy"', 'href="/base"']) {
      assert.ok(html.includes(href), `footer missing ${href}`);
    }
    assert.match(html, /<link rel="icon" type="image\/png" sizes="192x192" href="\/icon-192.png"/);
  });

  test("sitemap lists the new pages", async () => {
    const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
    for (const p of ["/base", "/terms", "/privacy"]) {
      assert.ok(xml.includes(`<loc>https://agentpact.xyz${p}</loc>`), `sitemap missing ${p}`);
    }
  });
});

describe("images resolve from the prod cwd (repo root)", () => {
  for (const [path, w] of [["/icon-512.png", 512], ["/icon-192.png", 192]] as const) {
    test(`${path} is a ${w}x${w} PNG`, async () => {
      const r = await fetch(`${BASE}${path}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/png");
      assert.deepEqual(pngSize(Buffer.from(await r.arrayBuffer())), [w, w]);
    });
  }

  test("/og-image.png is served (was 404 in prod)", async () => {
    const r = await fetch(`${BASE}/og-image.png`);
    assert.equal(r.status, 200);
    assert.deepEqual(pngSize(Buffer.from(await r.arrayBuffer())), [1200, 630]);
  });
});

describe("claims stay grounded in the source of truth", () => {
  test("escrow address matches docs/contract-verification.md", () => {
    const doc = readFileSync(resolve(REPO_ROOT, "docs/contract-verification.md"), "utf-8");
    assert.ok(doc.includes(ESCROW), "contract-verification.md does not name the escrow the pages advertise");
  });

  test("the fee split in TERMS.md matches the whitepaper", () => {
    const wp = readFileSync(resolve(REPO_ROOT, "docs/WHITEPAPER.md"), "utf-8");
    assert.match(wp, /90% to seller, 10% platform fee/);
    const terms = readFileSync(resolve(REPO_ROOT, "docs/legal/TERMS.md"), "utf-8");
    assert.match(terms, /90% to the seller and 10% to the platform/);
  });
});
