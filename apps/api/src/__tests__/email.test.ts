/**
 * apps/api/src/__tests__/email.test.ts
 * levels_2505: Tests for the email service (gws + Resend fallback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock child_process BEFORE import ─────────────────────────────────────────
// vi.mock is hoisted; factory must not reference outer-scope variables.

vi.mock("node:child_process", () => {
  const spawnMock = vi.fn();
  return { spawn: spawnMock };
});

// ── Mock global fetch ─────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mock setup
import { sendEmail } from "../services/email.js";
import { spawn as spawnImport } from "node:child_process";
const mockSpawn = vi.mocked(spawnImport);

// ── Helpers ───────────────────────────────────────────────────────────────────

type EventCallback = (arg: unknown) => void;

function makeChildProcess(exitCode: number, stdout = "", stderr = "") {
  const stdoutHandlers: EventCallback[] = [];
  const stderrHandlers: EventCallback[] = [];
  const closeHandlers: EventCallback[] = [];
  const errorHandlers: EventCallback[] = [];

  const child = {
    stdout: {
      on: (event: string, cb: EventCallback) => {
        if (event === "data") stdoutHandlers.push(cb);
      },
    },
    stderr: {
      on: (event: string, cb: EventCallback) => {
        if (event === "data") stderrHandlers.push(cb);
      },
    },
    on: (event: string, cb: EventCallback) => {
      if (event === "close") closeHandlers.push(cb);
      if (event === "error") errorHandlers.push(cb);
    },
    _emit: () => {
      if (stdout) stdoutHandlers.forEach((cb) => cb(Buffer.from(stdout)));
      if (stderr) stderrHandlers.forEach((cb) => cb(Buffer.from(stderr)));
      closeHandlers.forEach((cb) => cb(exitCode));
    },
  };
  return child;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const EMAIL_OPTS = {
  to: "buyer@test.com",
  subject: "Your audit for 0xContract...",
  body: "# Audit Result\nNo issues found.",
};

describe("email service", () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_PROVIDER;
    mockSpawn.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_PROVIDER;
  });

  it("gws success path: returns ok=true, provider=gws", async () => {
    const child = makeChildProcess(0, JSON.stringify({ id: "msg_gws_ok" }));
    mockSpawn.mockReturnValue(child as ReturnType<typeof mockSpawn>);

    const resultPromise = sendEmail(EMAIL_OPTS);
    child._emit();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("gws");
    expect(result.message_id).toBe("msg_gws_ok");
  });

  it("gws fails then Resend succeeds (fallback)", async () => {
    const child = makeChildProcess(1, "", "gws command not found");
    mockSpawn.mockReturnValue(child as ReturnType<typeof mockSpawn>);

    process.env.RESEND_API_KEY = "re_test_key";
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "msg_resend_ok" }),
    });

    const resultPromise = sendEmail(EMAIL_OPTS);
    child._emit();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("resend");
    expect(result.message_id).toBe("msg_resend_ok");
  });

  it("both gws and Resend fail → returns ok=false with combined error", async () => {
    const child = makeChildProcess(1, "", "gws not found");
    mockSpawn.mockReturnValue(child as ReturnType<typeof mockSpawn>);

    process.env.RESEND_API_KEY = "re_test_key";
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ message: "Resend API error" }),
    });

    const resultPromise = sendEmail(EMAIL_OPTS);
    child._emit();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("gws");
    expect(result.error).toContain("resend");
  });
});
