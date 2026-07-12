/**
 * audit-runner-cli.test.ts
 *
 * Tests for the Slither + Claude audit runner CLI.
 * Uses node:test + node:assert (same pattern as apps/daemon/src/*.test.ts).
 *
 * Tests mock slither by writing fixture JSON to the expected path,
 * so NO real slither binary is required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AuditResult } from "./audit-runner-cli.js";

// ---------------------------------------------------------------------------
// Dynamic import for the module (ESM)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function importRunner() {
  return (await import("./audit-runner-cli.js")) as typeof import("./audit-runner-cli.js");
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeFixtureJson(
  orderId: string,
  detectors: Array<{ impact: string; check: string; description: string }>
): string {
  const jsonPath = join(tmpdir(), `audit-${orderId}.json`);
  const payload = {
    success: true,
    results: {
      detectors,
    },
  };
  writeFileSync(jsonPath, JSON.stringify(payload), "utf-8");
  return jsonPath;
}

function makeDetector(impact: string, check = "reentrancy-eth"): {
  impact: string;
  check: string;
  description: string;
} {
  return { impact, check, description: `Mock ${impact} finding` };
}

// ---------------------------------------------------------------------------
// Test 1: verdict mapping — 0 high, 0 medium → PASS
// ---------------------------------------------------------------------------

describe("verdict mapping", () => {
  test("0 high, 0 medium → PASS", async () => {
    const orderId = "test-pass-01";
    const jsonPath = writeFixtureJson(orderId, [
      makeDetector("Low"),
      makeDetector("Informational"),
    ]);

    const { runAudit } = await importRunner();
    const result = await runAudit({
      contractAddress: "0x1234",
      buyerEmail: "test@example.com",
      orderId,
      dryRun: true,
      _baseScanOverride: { verified: true, sourceCode: "pragma solidity ^0.8.0;" },
      _slitherJsonOverride: jsonPath,
    });

    assert.equal(result.verdict, "PASS");
    assert.equal(result.severity_counts.high, 0);
    assert.equal(result.severity_counts.medium, 0);
  });

  test("0 high, 2 medium → CONDITIONAL", async () => {
    const orderId = "test-cond-01";
    const jsonPath = writeFixtureJson(orderId, [
      makeDetector("Medium"),
      makeDetector("Medium"),
    ]);

    const { runAudit } = await importRunner();
    const result = await runAudit({
      contractAddress: "0x1234",
      buyerEmail: "test@example.com",
      orderId,
      dryRun: true,
      _baseScanOverride: { verified: true, sourceCode: "pragma solidity ^0.8.0;" },
      _slitherJsonOverride: jsonPath,
    });

    assert.equal(result.verdict, "CONDITIONAL");
    assert.equal(result.severity_counts.high, 0);
    assert.equal(result.severity_counts.medium, 2);
  });

  test("2 high, 0 medium → FAIL", async () => {
    const orderId = "test-fail-01";
    const jsonPath = writeFixtureJson(orderId, [
      makeDetector("High"),
      makeDetector("High"),
    ]);

    const { runAudit } = await importRunner();
    const result = await runAudit({
      contractAddress: "0x1234",
      buyerEmail: "test@example.com",
      orderId,
      dryRun: true,
      _baseScanOverride: { verified: true, sourceCode: "pragma solidity ^0.8.0;" },
      _slitherJsonOverride: jsonPath,
    });

    assert.equal(result.verdict, "FAIL");
    assert.equal(result.severity_counts.high, 2);
    assert.equal(result.severity_counts.medium, 0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: severity bucketing against a mixed-impact fixture
// ---------------------------------------------------------------------------

test("severity bucketing: High, Medium, Low, Informational, Optimization all bucket correctly", async () => {
  const orderId = "test-bucket-01";
  const detectors = [
    makeDetector("High"),
    makeDetector("High"),
    makeDetector("Medium"),
    makeDetector("Low"),
    makeDetector("Low"),
    makeDetector("Low"),
    makeDetector("Informational"),
    makeDetector("Optimization"),
  ];
  const jsonPath = writeFixtureJson(orderId, detectors);

  const { runAudit } = await importRunner();
  const result = await runAudit({
    contractAddress: "0xabc",
    buyerEmail: "test@example.com",
    orderId,
    dryRun: true,
    _baseScanOverride: { verified: true, sourceCode: "pragma solidity ^0.8.0;" },
    _slitherJsonOverride: jsonPath,
  });

  assert.equal(result.severity_counts.high, 2);
  assert.equal(result.severity_counts.medium, 1);
  assert.equal(result.severity_counts.low, 3);
  assert.equal(result.severity_counts.info, 2); // Informational + Optimization
  assert.equal(result.verdict, "FAIL"); // high > 0
});

// ---------------------------------------------------------------------------
// Test 3: unverified contract → FAIL with reason
// ---------------------------------------------------------------------------

test("unverified contract returns FAIL with failure_reason", async () => {
  const { runAudit } = await importRunner();
  const result = await runAudit({
    contractAddress: "0xdeadbeef",
    buyerEmail: "buyer@example.com",
    orderId: "test-unverified-01",
    dryRun: true,
    _baseScanOverride: { verified: false },
  });

  assert.equal(result.verdict, "FAIL");
  assert.equal(result.failure_reason, "contract not verified on BaseScan");
  assert.equal(result.severity_counts.high, 0);
  assert.ok(result.report_md.length > 0, "report_md should have explanatory message");
});

// ---------------------------------------------------------------------------
// Test 4: --dry-run does NOT call Anthropic (no ANTHROPIC_API_KEY needed)
// ---------------------------------------------------------------------------

test("dry-run mode: Anthropic SDK is never invoked (no ANTHROPIC_API_KEY required)", async () => {
  const orderId = "test-dryrun-01";
  const jsonPath = writeFixtureJson(orderId, [makeDetector("Low")]);

  // Ensure ANTHROPIC_API_KEY is unset
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const { runAudit } = await importRunner();
    const result = await runAudit({
      contractAddress: "0xcafe",
      buyerEmail: "dry@example.com",
      orderId,
      dryRun: true,
      _baseScanOverride: { verified: true, sourceCode: "pragma solidity ^0.8.0;" },
      _slitherJsonOverride: jsonPath,
    });

    // Should succeed without Anthropic key in dry-run
    assert.ok(result.report_md.includes("dry-run"), "report_md should mention dry-run");
    assert.ok(["PASS", "CONDITIONAL", "FAIL"].includes(result.verdict));
  } finally {
    if (savedKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  }
});

// ---------------------------------------------------------------------------
// Test 5: missing args → non-zero exit via CLI invocation
// ---------------------------------------------------------------------------

test("missing args → non-zero exit code from CLI", () => {
  const cliPath = resolve(__dirname, "audit-runner-cli.ts");
  const result = spawnSync("npx", ["tsx", cliPath], {
    env: { ...process.env, BASESCAN_API_KEY: "fake", ANTHROPIC_API_KEY: "fake" },
    timeout: 15_000,
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0, "should exit non-zero with missing args");
  assert.ok(
    (result.stderr ?? "").includes("Usage:"),
    `stderr should contain usage hint; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// Test 6: output JSON shape is correct on success
// ---------------------------------------------------------------------------

test("output JSON shape: has report_md, severity_counts, verdict, raw_slither_path", async () => {
  const orderId = "test-shape-01";
  const jsonPath = writeFixtureJson(orderId, [
    makeDetector("Medium"),
    makeDetector("Low"),
  ]);

  const { runAudit } = await importRunner();
  const result: AuditResult = await runAudit({
    contractAddress: "0xbeef",
    buyerEmail: "shape@example.com",
    orderId,
    dryRun: true,
    _baseScanOverride: { verified: true, sourceCode: "// test" },
    _slitherJsonOverride: jsonPath,
  });

  assert.ok(typeof result.report_md === "string", "report_md should be string");
  assert.ok(typeof result.severity_counts === "object", "severity_counts should be object");
  assert.ok(typeof result.severity_counts.high === "number");
  assert.ok(typeof result.severity_counts.medium === "number");
  assert.ok(typeof result.severity_counts.low === "number");
  assert.ok(typeof result.severity_counts.info === "number");
  assert.ok(["PASS", "CONDITIONAL", "FAIL"].includes(result.verdict));
  assert.ok(typeof result.raw_slither_path === "string");
});

// ---------------------------------------------------------------------------
// Test 7: slither JSON path missing → FAIL with reason
// ---------------------------------------------------------------------------

test("missing slither JSON path → FAIL with failure_reason", async () => {
  const { runAudit } = await importRunner();
  const result = await runAudit({
    contractAddress: "0xfeed",
    buyerEmail: "err@example.com",
    orderId: "test-missing-json-01",
    dryRun: true,
    _baseScanOverride: { verified: true, sourceCode: "pragma solidity ^0.8.0;" },
    _slitherJsonOverride: "/tmp/this-file-does-not-exist-abc123.json",
  });

  assert.equal(result.verdict, "FAIL");
  assert.ok(result.failure_reason != null && result.failure_reason.length > 0);
});

// ---------------------------------------------------------------------------
// Test 8: BASESCAN_API_KEY missing in non-mock, non-dry-run mode → process.exit(1)
// ---------------------------------------------------------------------------

test("missing BASESCAN_API_KEY (no mock) → CLI exits with code 1", () => {
  const cliPath = resolve(__dirname, "audit-runner-cli.ts");
  // Strip BASESCAN_API_KEY so it's missing
  const env = { ...process.env };
  delete env.BASESCAN_API_KEY;

  const result = spawnSync("npx", ["tsx", cliPath, "0xabcd", "e@e.com", "test-id"], {
    env,
    timeout: 15_000,
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0, "should exit non-zero without BASESCAN_API_KEY");
});
