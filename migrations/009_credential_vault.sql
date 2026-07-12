-- Credential vault for encrypted sensitive fulfillment fields
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
);

CREATE INDEX IF NOT EXISTS idx_credential_vault_fulfillment ON credential_vault(fulfillment_id);

CREATE TABLE IF NOT EXISTS credential_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id UUID NOT NULL REFERENCES deal_fulfillment(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('decrypt', 'rotate', 'request_rotation', 'revoke')),
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credential_access_log_fulfillment ON credential_access_log(fulfillment_id);

ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS last_expiry_warning_at TIMESTAMPTZ;
ALTER TABLE deal_fulfillment ADD COLUMN IF NOT EXISTS rotation_requested_at TIMESTAMPTZ;
