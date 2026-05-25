/**
 * audit-routes.test.ts
 *
 * Smoke/integration tests for the /audit and /audit-thank-you routes.
 * Spins up the web server in a child process (tsx), hits it via fetch,
 * then kills it. Uses node:test + node:assert.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_SRC = resolve(__dirname, "index.ts");
const TEST_PORT = 29847;
const BASE = `http://localhost:${TEST_PORT}`;
async function waitForServer(url, retries = 40, delayMs = 150) {
    for (let i = 0; i < retries; i++) {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(800) });
            if (r.status < 600)
                return; // any response means the server is up
        }
        catch {
            // not ready yet
        }
        await new Promise((res) => setTimeout(res, delayMs));
    }
    throw new Error(`Server at ${url} did not start after ${(retries * delayMs) / 1000}s`);
}
// ---------------------------------------------------------------------------
// Primary server (no STRIPE link — tests the placeholder path)
// ---------------------------------------------------------------------------
let primaryServer = null;
before(async () => {
    primaryServer = spawn("npx", ["tsx", WEB_SRC], {
        env: {
            ...process.env,
            PORT: String(TEST_PORT),
            API_BASE_URL: "http://localhost:1",
        },
        stdio: "ignore", // don't inherit pipes — prevents parent event-loop from hanging
        detached: false,
    });
    primaryServer.unref(); // allow parent to exit even if child still runs
    await waitForServer(`${BASE}/robots.txt`);
});
after(async () => {
    primaryServer?.kill("SIGTERM");
});
// ---------------------------------------------------------------------------
// Tests: GET /audit
// ---------------------------------------------------------------------------
describe("GET /audit", () => {
    test("responds with HTTP 200", async () => {
        const res = await fetch(`${BASE}/audit`);
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    });
    test("H1 contains 'Smart-Contract Audit. $5. 60 minutes.'", async () => {
        const res = await fetch(`${BASE}/audit`);
        const html = await res.text();
        assert.ok(html.includes("Smart-Contract Audit. $5. 60 minutes."), `H1 text not found in page. First 500 chars: ${html.slice(0, 500)}`);
    });
    test("page contains all three content sections", async () => {
        const res = await fetch(`${BASE}/audit`);
        const html = await res.text();
        assert.ok(html.includes("What you get"), "missing 'What you get' section");
        assert.ok(html.includes("Why us"), "missing 'Why us' section");
        assert.ok(html.includes("The deal"), "missing 'The deal' section");
    });
    test("without STRIPE env var, CTA renders Coming soon placeholder", async () => {
        const res = await fetch(`${BASE}/audit`);
        const html = await res.text();
        assert.ok(html.includes("Coming soon") || html.includes("data-stripe-link"), `Expected placeholder CTA; got: ${html.slice(0, 400)}`);
    });
    test("footer contains BaseScan escrow address", async () => {
        const res = await fetch(`${BASE}/audit`);
        const html = await res.text();
        assert.ok(html.includes("0x588168712bF758aFD747bF46471afa53f9599A64"), "BaseScan escrow address not found");
    });
    test("footer contains refund guarantee copy", async () => {
        const res = await fetch(`${BASE}/audit`);
        const html = await res.text();
        assert.ok(html.includes("full refund, no questions"), "refund guarantee copy not found");
    });
});
// ---------------------------------------------------------------------------
// Tests: GET /audit-thank-you
// ---------------------------------------------------------------------------
describe("GET /audit-thank-you", () => {
    test("responds with HTTP 200", async () => {
        const res = await fetch(`${BASE}/audit-thank-you`);
        assert.equal(res.status, 200);
    });
    test("contains order-received message and 60-minutes copy", async () => {
        const res = await fetch(`${BASE}/audit-thank-you`);
        const html = await res.text();
        assert.ok(html.includes("Order received"), "missing 'Order received' copy");
        assert.ok(html.includes("60 minutes"), "missing '60 minutes' copy");
    });
    test("contains BaseScan escrow footer link", async () => {
        const res = await fetch(`${BASE}/audit-thank-you`);
        const html = await res.text();
        assert.ok(html.includes("0x588168712bF758aFD747bF46471afa53f9599A64"), "BaseScan escrow address missing from thank-you page");
    });
});
// ---------------------------------------------------------------------------
// Stripe link env var test — separate server instance
// ---------------------------------------------------------------------------
describe("GET /audit with STRIPE env set", () => {
    const STRIPE_PORT = TEST_PORT + 1;
    const STRIPE_LINK = "https://buy.stripe.com/test_abc123";
    let stripeServer = null;
    before(async () => {
        stripeServer = spawn("npx", ["tsx", WEB_SRC], {
            env: {
                ...process.env,
                PORT: String(STRIPE_PORT),
                API_BASE_URL: "http://localhost:1",
                VITE_STRIPE_AUDIT_PAYMENT_LINK: STRIPE_LINK,
            },
            stdio: "ignore",
            detached: false,
        });
        stripeServer.unref();
        await waitForServer(`http://localhost:${STRIPE_PORT}/robots.txt`);
    });
    after(async () => {
        stripeServer?.kill("SIGTERM");
    });
    test("CTA href contains VITE_STRIPE_AUDIT_PAYMENT_LINK value", async () => {
        const res = await fetch(`http://localhost:${STRIPE_PORT}/audit`);
        const html = await res.text();
        assert.ok(html.includes(STRIPE_LINK), `CTA should contain stripe link. Got HTML snippet: ${html.slice(0, 500)}`);
    });
});
