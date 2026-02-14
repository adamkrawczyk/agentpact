import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoVerify } from "../auto-verify.js";

describe("autoVerify", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("verifies http-ping via GET with auth headers", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token-123");
      return new Response("ok", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await autoVerify("http-ping", {
      endpoint_url: "https://example.test/ping",
      auth_type: "bearer",
      auth_value: "token-123",
    });

    expect(result.success).toBe(true);
    expect(result.details).toContain("404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a failure when http-ping fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const result = await autoVerify("http-ping", {
      endpoint_url: "https://example.test/ping",
    });

    expect(result.success).toBe(false);
    expect(result.details).toContain("HTTP ping failed");
    expect(result.details).toContain("network down");
  });

  it("checks downloads with HEAD and validates format and content length", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("HEAD");
      return new Response("", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "32",
        },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await autoVerify("download-check", {
      download_url: "https://example.test/file",
      format: "json",
    });

    expect(result.success).toBe(true);
    expect(result.details).toContain("Download endpoint reachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails download-check when HEAD status is not ok", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as typeof fetch;

    const result = await autoVerify("download-check", {
      download_url: "https://example.test/file",
      format: "json",
    });

    expect(result.success).toBe(false);
    expect(result.details).toContain("HEAD request failed with status 503");
  });
});
