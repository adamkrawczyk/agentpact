# Execution Layer — Phase 2: Encrypted Credential Vault

## Goal
Fulfillment data containing sensitive credentials (API keys, tokens, passwords, SSH keys) is currently stored as plaintext JSONB. Phase 2 adds encryption-at-rest for sensitive fields, credential rotation tracking, and expiry management.

## Changes Overview

### 1. Database Migration (`migrations/009_credential_vault.sql`)

```sql
-- Credential vault for encrypted sensitive fields
CREATE TABLE IF NOT EXISTS credential_vault (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id UUID NOT NULL REFERENCES deal_fulfillment(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,          -- e.g. "auth_value", "credentials", "access_token"
  encrypted_value TEXT NOT NULL,     -- AES-256-GCM encrypted
  iv TEXT NOT NULL,                  -- initialization vector (hex)
  auth_tag TEXT NOT NULL,            -- GCM auth tag (hex)
  last_rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotation_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(fulfillment_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_credential_vault_fulfillment ON credential_vault(fulfillment_id);

-- Add expiry tracking to deal_fulfillment
ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS last_expiry_warning_at TIMESTAMPTZ;
ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS rotation_requested_at TIMESTAMPTZ;
```

### 2. Encryption Module (`apps/api/src/credential-vault.ts`)

Use Node.js `crypto` module with AES-256-GCM:
- Encryption key from env var `CREDENTIAL_ENCRYPTION_KEY` (32-byte hex)
- If not set, fall back to derive from `DATABASE_URL` hash (dev mode only, log warning)

```typescript
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";
const SENSITIVE_FIELDS: Record<string, string[]> = {
  "api-access": ["auth_value"],
  "code-task": ["access_token"],
  "compute-access": ["credentials"],
  "data-delivery": [],   // download URLs are not secrets typically
  "consulting": [],
  "generic": [],
};

export function getSensitiveFields(fulfillmentType: string): string[] {
  return SENSITIVE_FIELDS[fulfillmentType] ?? [];
}

export function encrypt(plaintext: string, key: Buffer): { encrypted: string; iv: string; authTag: string };
export function decrypt(encrypted: string, iv: string, authTag: string, key: Buffer): string;

// Strip sensitive fields from fulfillment_data, store them in vault
export async function vaultStore(sql, fulfillmentId: string, fulfillmentType: string, data: Record<string, unknown>, key: Buffer): Promise<Record<string, unknown>>;

// Retrieve and merge sensitive fields back into fulfillment_data
export async function vaultRetrieve(sql, fulfillmentId: string, data: Record<string, unknown>, key: Buffer): Promise<Record<string, unknown>>;

// Rotate a credential (re-encrypt with new value)
export async function vaultRotate(sql, fulfillmentId: string, fieldName: string, newValue: string, key: Buffer): Promise<void>;
```

### 3. API Changes

#### Modify existing fulfillment endpoints:

**`POST /api/deals/:id/fulfillment`** (provide):
- After validation, call `vaultStore()` to extract sensitive fields → encrypt → store in vault
- Store redacted `fulfillment_data` (sensitive fields replaced with `"[encrypted]"`)
- Response includes `encrypted_fields: string[]` to indicate what was vaulted

**`GET /api/deals/:id/fulfillment`**:
- Add query param `?decrypt=true` (default false)
- If `decrypt=true` and requester is buyer or seller of the deal: merge decrypted fields back
- If `decrypt=false`: return redacted data with `"[encrypted]"` placeholders
- Log access for audit trail

#### New endpoints:

**`POST /api/deals/:id/fulfillment/rotate`**
- Seller rotates a specific credential
- Body: `{ agentId, fieldName, newValue }`
- Re-encrypts in vault, increments rotation_count
- Fires `deal.credential_rotated` webhook to buyer

**`GET /api/deals/:id/fulfillment/audit`**
- Returns access log: who decrypted what and when
- Only accessible by seller of the deal

**`POST /api/deals/:id/fulfillment/request-rotation`**
- Buyer requests credential rotation (e.g., suspects compromise)
- Body: `{ agentId, reason? }`
- Sets `rotation_requested_at`, fires `deal.rotation_requested` webhook to seller

#### Expiry management:

**Background check** (called from heartbeat/cron or on GET):
- If `expires_at` is within 24h and no warning sent → fire `deal.fulfillment_expiring` webhook
- If `expires_at` has passed → auto-set status to `expired`, fire `deal.fulfillment_expired`

### 4. Webhook events to add:
- `deal.credential_rotated` — buyer notified of new credential
- `deal.rotation_requested` — seller notified buyer wants rotation
- `deal.fulfillment_expiring` — both parties warned of upcoming expiry
- `deal.fulfillment_expired` — fulfillment has expired

Add these to `VALID_EVENTS` in `webhooks.ts`.

### 5. MCP Tool Changes

#### New tools:

**`agentpact.rotate_credential`**
- Params: `dealId`, `agentId`, `fieldName`, `newValue`
- Calls `POST /api/deals/:id/fulfillment/rotate`

**`agentpact.request_rotation`**
- Params: `dealId`, `agentId`, `reason?`
- Calls `POST /api/deals/:id/fulfillment/request-rotation`

#### Modify existing tools:

**`agentpact.get_fulfillment`**:
- Add optional `decrypt` param (default false)
- Pass as query param

**`agentpact.provide_fulfillment`**:
- Response now includes `encrypted_fields` list

### 6. Audit Log Table

```sql
CREATE TABLE IF NOT EXISTS credential_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id UUID NOT NULL REFERENCES deal_fulfillment(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('decrypt', 'rotate', 'request_rotation', 'revoke')),
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credential_access_log_fulfillment ON credential_access_log(fulfillment_id);
```

### 7. Tests (`apps/api/src/__tests__/credential-vault.test.ts`)

- Encrypt/decrypt roundtrip
- Sensitive fields extracted and vaulted on provide
- GET without decrypt returns redacted data
- GET with decrypt returns full data (authorized agent only)
- GET with decrypt by unauthorized agent → 403
- Rotate credential → new value retrievable, rotation_count incremented
- Request rotation → webhook fired
- Expiry warning fired at 24h
- Auto-expire when past expires_at

## Files to Create/Modify

1. `migrations/009_credential_vault.sql` — NEW (vault table + audit log + alter deal_fulfillment)
2. `apps/api/src/credential-vault.ts` — NEW (encrypt/decrypt/vault CRUD)
3. `apps/api/src/index.ts` — modify provide/get endpoints, add rotate/audit/request-rotation endpoints, add expiry check
4. `apps/api/src/webhooks.ts` — add 4 new event types
5. `apps/mcp/src/index.ts` — add rotate_credential, request_rotation tools; modify get_fulfillment
6. `apps/api/src/__tests__/credential-vault.test.ts` — NEW

## Constraints

- All new fields optional with defaults — no breaking changes
- `CREDENTIAL_ENCRYPTION_KEY` env var required in production; dev fallback with warning
- Encryption is AES-256-GCM (authenticated encryption)
- Audit log is append-only, no DELETE endpoint
- Expiry checks are lazy (triggered on GET or by external cron) — no background worker needed
- Sensitive field mapping is per-type; `generic` type has no auto-detected sensitive fields (user can manually mark fields by prefixing with `secret_`)
