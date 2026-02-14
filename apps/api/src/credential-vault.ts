import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";

const ALGO = "aes-256-gcm";

const SENSITIVE_FIELDS: Record<string, string[]> = {
  "api-access": ["auth_value"],
  "code-task": ["access_token"],
  "compute-access": ["credentials"],
  "data-delivery": [],
  consulting: [],
  "physical-service": ["secret_address", "secret_access_notes", "secret_contact_value"],
  generic: [],
};

let warnedFallback = false;

export function getSensitiveFields(fulfillmentType: string): string[] {
  return SENSITIVE_FIELDS[fulfillmentType] ?? [];
}

export function getCredentialEncryptionKey(): Buffer {
  const configuredKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (configuredKey) {
    if (!/^[a-fA-F0-9]{64}$/.test(configuredKey)) {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)");
    }
    return Buffer.from(configuredKey, "hex");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required in production");
  }

  const databaseUrl = process.env.DATABASE_URL ?? "agentpact-dev-fallback";
  if (!warnedFallback) {
    console.warn("[credential-vault] CREDENTIAL_ENCRYPTION_KEY not set; using dev fallback derived from DATABASE_URL");
    warnedFallback = true;
  }
  return createHash("sha256").update(databaseUrl).digest();
}

export function encrypt(plaintext: string, key: Buffer): { encrypted: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

export function decrypt(encrypted: string, iv: string, authTag: string, key: Buffer): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(authTag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

type VaultSql = Sql<Record<string, unknown>>;
let schemaReady: Promise<void> | null = null;

export async function ensureCredentialVaultSchema(db: VaultSql): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db`
        CREATE TABLE IF NOT EXISTS credential_vault (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          fulfillment_id UUID NOT NULL REFERENCES deal_fulfillment(id) ON DELETE CASCADE,
          field_name TEXT NOT NULL,
          encrypted_value TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          last_rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          rotation_count INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (fulfillment_id, field_name)
        )
      `;
      await db`CREATE INDEX IF NOT EXISTS idx_credential_vault_fulfillment ON credential_vault(fulfillment_id)`;
      await db`
        CREATE TABLE IF NOT EXISTS credential_access_log (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          fulfillment_id UUID NOT NULL REFERENCES deal_fulfillment(id) ON DELETE CASCADE,
          agent_id UUID NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('decrypt', 'rotate', 'request_rotation', 'revoke')),
          ip_address TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await db`CREATE INDEX IF NOT EXISTS idx_credential_access_log_fulfillment ON credential_access_log(fulfillment_id)`;
      await db`ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS last_expiry_warning_at TIMESTAMPTZ`;
      await db`ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS rotation_requested_at TIMESTAMPTZ`;
      await db`ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS buyer_data JSONB DEFAULT NULL`;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function vaultStore(
  db: VaultSql,
  fulfillmentId: string,
  fulfillmentType: string,
  data: Record<string, unknown>,
  key: Buffer,
): Promise<Record<string, unknown>> {
  await ensureCredentialVaultSchema(db);

  const redacted: Record<string, unknown> = { ...data };
  const configured = new Set(getSensitiveFields(fulfillmentType));
  const prefixed = Object.keys(data).filter((field) => field.startsWith("secret_"));
  const sensitiveFields = new Set([...configured, ...prefixed]);

  for (const fieldName of sensitiveFields) {
    if (!(fieldName in data)) continue;
    const value = data[fieldName];
    if (value === undefined || value === null) continue;

    const plaintext = typeof value === "string" ? value : JSON.stringify(value);
    const { encrypted, iv, authTag } = encrypt(plaintext, key);

    await db`
      INSERT INTO credential_vault (fulfillment_id, field_name, encrypted_value, iv, auth_tag)
      VALUES (${fulfillmentId}, ${fieldName}, ${encrypted}, ${iv}, ${authTag})
      ON CONFLICT (fulfillment_id, field_name) DO UPDATE SET
        encrypted_value = EXCLUDED.encrypted_value,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        last_rotated_at = NOW()
    `;

    redacted[fieldName] = "[encrypted]";
  }

  return redacted;
}

export async function vaultRetrieve(
  db: VaultSql,
  fulfillmentId: string,
  data: Record<string, unknown>,
  key: Buffer,
): Promise<Record<string, unknown>> {
  await ensureCredentialVaultSchema(db);

  const merged: Record<string, unknown> = { ...data };
  const rows = await db`
    SELECT field_name, encrypted_value, iv, auth_tag
    FROM credential_vault
    WHERE fulfillment_id = ${fulfillmentId}
  `;

  for (const row of rows) {
    const fieldName = String(row.field_name);
    merged[fieldName] = decrypt(
      String(row.encrypted_value),
      String(row.iv),
      String(row.auth_tag),
      key,
    );
  }

  return merged;
}

export async function vaultRotate(
  db: VaultSql,
  fulfillmentId: string,
  fieldName: string,
  newValue: string,
  key: Buffer,
): Promise<void> {
  await ensureCredentialVaultSchema(db);

  const { encrypted, iv, authTag } = encrypt(newValue, key);
  await db`
    INSERT INTO credential_vault (fulfillment_id, field_name, encrypted_value, iv, auth_tag, last_rotated_at, rotation_count)
    VALUES (${fulfillmentId}, ${fieldName}, ${encrypted}, ${iv}, ${authTag}, NOW(), 1)
    ON CONFLICT (fulfillment_id, field_name) DO UPDATE SET
      encrypted_value = EXCLUDED.encrypted_value,
      iv = EXCLUDED.iv,
      auth_tag = EXCLUDED.auth_tag,
      last_rotated_at = NOW(),
      rotation_count = credential_vault.rotation_count + 1
  `;
}
