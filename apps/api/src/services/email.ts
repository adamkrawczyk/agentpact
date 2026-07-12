/**
 * apps/api/src/services/email.ts
 * audit-order rollout: Email helper for audit report delivery.
 *
 * Primary:  gws CLI  (~/.npm-global/bin/gws)
 * Fallback: Resend HTTP API (if RESEND_API_KEY is set and gws fails)
 */

import { spawn } from "node:child_process";

export interface EmailResult {
  ok: boolean;
  provider: "gws" | "resend";
  message_id?: string;
  error?: string;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  /** Override from address; defaults to audits@agentpact.xyz */
  from?: string;
}

const DEFAULT_FROM = "audits@agentpact.xyz";
const GWS_BIN =
  process.env.GWS_BIN ?? "gws";

/** Send via gws CLI */
async function sendViaGws(opts: SendEmailOptions): Promise<EmailResult> {
  return new Promise((resolve) => {
    const from = opts.from ?? DEFAULT_FROM;
    const args = [
      "send",
      "--to", opts.to,
      "--from", from,
      "--subject", opts.subject,
      "--body", opts.body,
    ];

    const child = spawn(GWS_BIN, args, { timeout: 30_000 });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code === 0) {
        // gws may emit JSON with message_id; try to parse
        const message_id = tryParseMessageId(stdout);
        resolve({ ok: true, provider: "gws", ...(message_id ? { message_id } : {}) });
      } else {
        resolve({ ok: false, provider: "gws", error: stderr.trim() || `gws exited ${code}` });
      }
    });

    child.on("error", (err) => {
      resolve({ ok: false, provider: "gws", error: err.message });
    });
  });
}

function tryParseMessageId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof parsed.message_id === "string") return parsed.message_id;
    if (typeof parsed.id === "string") return parsed.id;
  } catch {
    // not JSON — extract id: <xxx> from text output
    const m = stdout.match(/(?:message[_-]?id|id):\s*(\S+)/i);
    if (m) return m[1];
  }
  return undefined;
}

/** Send via Resend HTTP API */
async function sendViaResend(opts: SendEmailOptions): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, provider: "resend", error: "RESEND_API_KEY not set" };
  }

  const from = opts.from ?? DEFAULT_FROM;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        text: opts.body,
      }),
    });

    const data = await res.json() as Record<string, unknown>;

    if (res.ok) {
      const message_id = typeof data.id === "string" ? data.id : undefined;
      return { ok: true, provider: "resend", ...(message_id ? { message_id } : {}) };
    }
    return {
      ok: false,
      provider: "resend",
      error: (data.message as string | undefined) ?? `Resend HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      provider: "resend",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Send an audit report email.
 * Tries gws first; falls back to Resend if gws fails and RESEND_API_KEY is set.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<EmailResult> {
  // If EMAIL_PROVIDER=resend is forced, skip gws
  if (process.env.EMAIL_PROVIDER === "resend") {
    return sendViaResend(opts);
  }

  const gwsResult = await sendViaGws(opts);
  if (gwsResult.ok) return gwsResult;

  // gws failed — try Resend fallback
  if (process.env.RESEND_API_KEY) {
    const resendResult = await sendViaResend(opts);
    if (resendResult.ok) return resendResult;
    return {
      ok: false,
      provider: "resend",
      error: `gws: ${gwsResult.error}; resend: ${resendResult.error}`,
    };
  }

  return gwsResult;
}

/**
 * Build the standard audit email body from report_md.
 */
export function buildAuditEmailBody(
  contractAddress: string,
  reportMd: string,
): string {
  const header = `Hello,\n\nYour smart-contract audit for ${contractAddress} is complete.\n\n---\n\n`;
  const footer =
    "\n\n---\nThank you for using AgentPact. Questions? Reply to this email or reach adam@agentpact.xyz.";
  return header + reportMd + footer;
}
