import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CredentialVaultModule = typeof import("../credential-vault.js");

async function loadModule(): Promise<CredentialVaultModule> {
  vi.resetModules();
  return import("../credential-vault.js");
}

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  process.env = snapshot;
}

describe("Credential Vault key and schema edge cases", () => {
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    envSnapshot = { ...process.env };
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.restoreAllMocks();
  });

  it("uses configured 32-byte hex key when provided", async () => {
    const configuredKey = "ab".repeat(32);
    process.env.CREDENTIAL_ENCRYPTION_KEY = configuredKey;
    process.env.NODE_ENV = "test";

    const { getCredentialEncryptionKey } = await loadModule();
    const key = getCredentialEncryptionKey();

    expect(key.toString("hex")).toBe(configuredKey);
  });

  it("throws for invalid configured key format", async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "not-a-hex-key";
    process.env.NODE_ENV = "test";

    const { getCredentialEncryptionKey } = await loadModule();

    expect(() => getCredentialEncryptionKey()).toThrow(
      "CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)",
    );
  });

  it("throws in production when key is missing", async () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.NODE_ENV = "production";

    const { getCredentialEncryptionKey } = await loadModule();

    expect(() => getCredentialEncryptionKey()).toThrow("CREDENTIAL_ENCRYPTION_KEY is required in production");
  });

  it("uses DATABASE_URL-derived dev fallback and warns only once", async () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgres://example/fallback-db";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { getCredentialEncryptionKey } = await loadModule();

    const first = getCredentialEncryptionKey().toString("hex");
    const second = getCredentialEncryptionKey().toString("hex");
    expect(first).toBe(second);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("resets schema initialization cache after failure and retries cleanly", async () => {
    const { ensureCredentialVaultSchema } = await loadModule();

    let shouldFail = true;
    let calls = 0;
    const db = (async () => {
      calls += 1;
      if (shouldFail) {
        shouldFail = false;
        throw new Error("schema init failed");
      }
      return [];
    }) as unknown as Parameters<typeof ensureCredentialVaultSchema>[0];

    await expect(ensureCredentialVaultSchema(db)).rejects.toThrow("schema init failed");
    const callsAfterFailure = calls;

    await expect(ensureCredentialVaultSchema(db)).resolves.toBeUndefined();
    expect(calls).toBeGreaterThan(callsAfterFailure);
  });
});
