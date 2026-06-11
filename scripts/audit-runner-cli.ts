#!/usr/bin/env node
/**
 * audit-runner-cli.ts
 *
 * Usage:
 *   npx tsx scripts/audit-runner-cli.ts <contract_address> <buyer_email> <order_id> [--dry-run]
 *
 * Exit codes:
 *   0  – success, valid JSON to stdout
 *   1  – unrecoverable error, message to stderr
 *
 * CONTRACT: see SPRINT_DOCS/levels_2505_CONTRACT.md §'Slither + Claude runner CLI'
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface AuditResult {
  report_md: string;
  severity_counts: SeverityCounts;
  verdict: "PASS" | "CONDITIONAL" | "FAIL";
  raw_slither_path: string;
  failure_reason?: string;
}

// ---------------------------------------------------------------------------
// Hard wall-clock timeout: 600s
// ---------------------------------------------------------------------------

const WALL_CLOCK_TIMEOUT_MS = 600_000;
const hardTimeout = setTimeout(() => {
  process.stderr.write(
    "[audit-runner] Hard 600s wall-clock timeout exceeded. Aborting.\n"
  );
  process.exit(1);
}, WALL_CLOCK_TIMEOUT_MS);
hardTimeout.unref(); // don't keep event loop alive if we finish normally

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message: string): never {
  process.stderr.write(`[audit-runner] ${message}\n`);
  process.exit(1);
}

function verdictFromCounts(counts: SeverityCounts): "PASS" | "CONDITIONAL" | "FAIL" {
  if (counts.high > 0) return "FAIL";
  if (counts.medium > 0) return "CONDITIONAL";
  return "PASS";
}

function parseSeverityCounts(
  results: Array<{ impact?: string; check?: string }>
): SeverityCounts {
  const counts: SeverityCounts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const r of results) {
    const impact = (r.impact ?? "").toLowerCase();
    if (impact === "high") counts.high++;
    else if (impact === "medium") counts.medium++;
    else if (impact === "low") counts.low++;
    else if (impact === "informational" || impact === "optimization") counts.info++;
  }
  return counts;
}

function flattenSource(sourceCode: string): string {
  // If it starts with '{', it's a multi-file JSON (Standard JSON or similar)
  if (sourceCode.trimStart().startsWith("{") || sourceCode.trimStart().startsWith("{{")) {
    const stripped = sourceCode.trim().replace(/^\{/, "").replace(/\}$/, "");
    try {
      // Attempt to parse as Standard JSON Input format
      const inner = stripped.startsWith("{") ? stripped : `{${stripped}}`;
      const parsed = JSON.parse(inner) as {
        sources?: Record<string, { content?: string }>;
      };
      if (parsed.sources) {
        return Object.values(parsed.sources)
          .map((s) => s.content ?? "")
          .join("\n\n");
      }
    } catch {
      // Fall through — treat as raw source
    }
    // Double-wrapped: strip outer {{ }}
    try {
      const inner2 = sourceCode.trim().slice(1, -1);
      const parsed2 = JSON.parse(inner2) as {
        sources?: Record<string, { content?: string }>;
      };
      if (parsed2.sources) {
        return Object.values(parsed2.sources)
          .map((s) => s.content ?? "")
          .join("\n\n");
      }
    } catch {
      // Fall through
    }
  }
  return sourceCode;
}

function dryRunReport(
  counts: SeverityCounts,
  verdict: "PASS" | "CONDITIONAL" | "FAIL",
  contractAddress: string
): string {
  return [
    `# Smart-Contract Audit Report`,
    ``,
    `**Contract:** \`${contractAddress}\``,
    `**Mode:** dry-run (Anthropic SDK skipped)`,
    ``,
    `## Severity Summary`,
    ``,
    `| Severity | Count |`,
    `|----------|-------|`,
    `| 🔴 HIGH | ${counts.high} |`,
    `| 🟡 MEDIUM | ${counts.medium} |`,
    `| 🟢 LOW | ${counts.low} |`,
    `| ℹ️ INFO/OPT | ${counts.info} |`,
    ``,
    `## Verdict`,
    ``,
    `**${verdict}**`,
    verdict === "PASS"
      ? `No high or medium severity issues found.`
      : verdict === "CONDITIONAL"
      ? `Medium severity issues found. Review required before deployment.`
      : `High severity issues found. Deployment not recommended.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Core logic (exported for testability)
// ---------------------------------------------------------------------------

export async function runAudit(opts: {
  contractAddress: string;
  buyerEmail: string;
  orderId: string;
  dryRun: boolean;
  /** Override for tests — inject slither JSON path directly (skip actual slither invocation) */
  _slitherJsonOverride?: string;
  /** Override for tests — inject BaseScan API response */
  _baseScanOverride?: { verified: boolean; sourceCode?: string };
  /** Override timeout on the whole script (ms, for tests) */
  _wallClockOverrideMs?: number;
}): Promise<AuditResult> {
  const { contractAddress, orderId, dryRun } = opts;

  // -------------------------------------------------------------------------
  // 1. Validate BaseScan API key (skip in dry-run if override provided)
  // -------------------------------------------------------------------------
  const basescanKey = process.env.BASESCAN_API_KEY;
  const hasMockOverride = !!opts._baseScanOverride;

  if (!basescanKey && !hasMockOverride) {
    die("BASESCAN_API_KEY env var is required");
  }

  // -------------------------------------------------------------------------
  // 2. Fetch verified source from BaseScan
  // -------------------------------------------------------------------------
  let sourceCode: string;

  if (hasMockOverride) {
    if (!opts._baseScanOverride!.verified) {
      return {
        verdict: "FAIL",
        failure_reason: "contract not verified on BaseScan",
        severity_counts: { high: 0, medium: 0, low: 0, info: 0 },
        report_md: `Contract \`${contractAddress}\` is not verified on BaseScan. Cannot run static analysis without source code.`,
        raw_slither_path: "",
      };
    }
    sourceCode = opts._baseScanOverride!.sourceCode ?? "// empty";
  } else {
    const url = `https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getsourcecode&address=${encodeURIComponent(contractAddress)}&apikey=${basescanKey}`;
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      die(`BaseScan fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!resp.ok) {
      die(`BaseScan returned HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as {
      status: string;
      result?: Array<{ SourceCode?: string }>;
    };
    const result0 = json.result?.[0];
    if (!result0 || result0.SourceCode === "" || result0.SourceCode == null) {
      return {
        verdict: "FAIL",
        failure_reason: "contract not verified on BaseScan",
        severity_counts: { high: 0, medium: 0, low: 0, info: 0 },
        report_md: `Contract \`${contractAddress}\` is not verified on BaseScan. Cannot run static analysis without source code.`,
        raw_slither_path: "",
      };
    }
    sourceCode = flattenSource(result0.SourceCode);
  }

  // -------------------------------------------------------------------------
  // 3. Write flattened source to /tmp/audit-<order_id>.sol
  // -------------------------------------------------------------------------
  const solPath = join(tmpdir(), `audit-${orderId}.sol`);
  const jsonPath = join(tmpdir(), `audit-${orderId}.json`);

  writeFileSync(solPath, sourceCode, "utf-8");

  // -------------------------------------------------------------------------
  // 4. Run slither (or use injected JSON for tests)
  // -------------------------------------------------------------------------
  let slitherResults: Array<{ impact?: string; check?: string }> = [];

  if (opts._slitherJsonOverride) {
    // Test mode: the JSON file was written externally; just read it
    if (!existsSync(opts._slitherJsonOverride)) {
      return {
        verdict: "FAIL",
        failure_reason: "slither JSON output not found (test override path missing)",
        severity_counts: { high: 0, medium: 0, low: 0, info: 0 },
        report_md: "Slither analysis failed: output file not found.",
        raw_slither_path: opts._slitherJsonOverride,
      };
    }
    const raw = JSON.parse(readFileSync(opts._slitherJsonOverride, "utf-8")) as {
      results?: { detectors?: typeof slitherResults };
    };
    slitherResults = raw.results?.detectors ?? [];
  } else {
    // Production: actually run slither
    const slitherResult = spawnSync(
      "slither",
      [solPath, "--json", jsonPath, "--no-fail-pedantic"],
      {
        timeout: 480_000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    if (slitherResult.error) {
      // Likely ENOENT — slither not installed
      const reason = `slither not found or failed to spawn: ${slitherResult.error.message}`;
      return {
        verdict: "FAIL",
        failure_reason: reason,
        severity_counts: { high: 0, medium: 0, low: 0, info: 0 },
        report_md: `Audit could not be completed. ${reason}. Your $5 has been refunded automatically. Reply to this email if you need help.`,
        raw_slither_path: jsonPath,
      };
    }

    // slither exits non-zero when it finds issues (--no-fail-pedantic helps but not always)
    // We parse the JSON regardless, as long as the file was written
    if (!existsSync(jsonPath)) {
      const stderr = slitherResult.stderr?.toString() ?? "";
      const reason = `slither did not produce output file. Exit code: ${slitherResult.status}. Stderr: ${stderr.slice(0, 500)}`;
      return {
        verdict: "FAIL",
        failure_reason: reason,
        severity_counts: { high: 0, medium: 0, low: 0, info: 0 },
        report_md: `Audit could not be completed. ${reason}. Your $5 has been refunded automatically. Reply to this email if you need help.`,
        raw_slither_path: jsonPath,
      };
    }

    const raw = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
      results?: { detectors?: typeof slitherResults };
    };
    slitherResults = raw.results?.detectors ?? [];
  }

  // -------------------------------------------------------------------------
  // 5. Count severities + compute verdict
  // -------------------------------------------------------------------------
  const severity_counts = parseSeverityCounts(slitherResults);
  const verdict = verdictFromCounts(severity_counts);
  const finalJsonPath = opts._slitherJsonOverride ?? jsonPath;

  // -------------------------------------------------------------------------
  // 6. Call Claude (or use dry-run template)
  // -------------------------------------------------------------------------
  let report_md: string;

  if (dryRun) {
    report_md = dryRunReport(severity_counts, verdict, contractAddress);
  } else {
    // LLM routing:
    //   - If OPENROUTER_API_KEY is set, route via OpenAI-compatible
    //     /api/v1/chat/completions (so the runner works without a direct
    //     Anthropic console key — useful when only OpenRouter is provisioned).
    //   - Otherwise, fall back to the native Anthropic SDK.
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    const slitherJsonStr = JSON.stringify({ results: { detectors: slitherResults } });
    const truncated =
      slitherJsonStr.length > 50_000
        ? slitherJsonStr.slice(0, 50_000) + "\n[... truncated ...]"
        : slitherJsonStr;

    const systemPrompt =
      "Summarize this Slither JSON as a markdown audit report. " +
      "Categorize findings by 🔴 HIGH / 🟡 MEDIUM / 🟢 LOW / ℹ️ INFO. " +
      "End with one-line verdict (PASS / CONDITIONAL / FAIL). " +
      "PASS = 0 high, 0 medium. CONDITIONAL = 0 high, any medium. FAIL = ≥1 high.";

    const userMessage =
      `Contract: ${contractAddress}\n` +
      `Severity counts: high=${severity_counts.high} medium=${severity_counts.medium} low=${severity_counts.low} info=${severity_counts.info}\n\n` +
      `Slither JSON output:\n\`\`\`json\n${truncated}\n\`\`\``;

    if (openrouterKey) {
      const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5";
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${openrouterKey}`,
          "content-type": "application/json",
          "x-title": "agentpact-audit-runner",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        die(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
      report_md = data.choices?.[0]?.message?.content || "No report generated.";
    } else if (anthropicKey) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: anthropicKey });
      const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

      const message = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });

      report_md =
        message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("") || "No report generated.";
    } else {
      die("Neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set (required outside --dry-run mode)");
    }
  }

  return {
    report_md,
    severity_counts,
    verdict,
    raw_slither_path: finalJsonPath,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const dryRun = flags.includes("--dry-run");

  if (args.length < 3) {
    process.stderr.write(
      "Usage: npx tsx scripts/audit-runner-cli.ts <contract_address> <buyer_email> <order_id> [--dry-run]\n"
    );
    process.exit(1);
  }

  const [contractAddress, buyerEmail, orderId] = args as [string, string, string];

  const result = await runAudit({
    contractAddress,
    buyerEmail,
    orderId,
    dryRun,
  });

  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}

// Only run main() when this file is executed directly (not imported in tests)
const isMain =
  process.argv[1] != null &&
  (process.argv[1].endsWith("audit-runner-cli.ts") ||
    process.argv[1].endsWith("audit-runner-cli.js"));

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[audit-runner] Uncaught error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
