# Execution Layer — Phase 1: Service Type Templates

## Goal
After a deal is accepted, the seller needs a structured way to provide fulfillment details (credentials, endpoints, URLs, etc.) to the buyer. Currently, the only mechanism is the delivery artifact manifest (array of `{type, url, hash}`), which is too generic and doesn't guide agents on what to provide.

## Changes Overview

### 1. Database Migration (`migrations/008_fulfillment_types.sql`)

```sql
-- Fulfillment type enum for offers/needs
ALTER TABLE offers ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE needs ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'generic';

-- After deal acceptance, seller fills this with structured fulfillment data
CREATE TABLE IF NOT EXISTS deal_fulfillment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  fulfillment_type TEXT NOT NULL,
  fulfillment_data JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'provided', 'active', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ,
  provided_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  auto_verify_result JSONB,  -- result of auto-verification attempt
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(deal_id)
);

CREATE INDEX IF NOT EXISTS idx_deal_fulfillment_deal ON deal_fulfillment(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_fulfillment_status ON deal_fulfillment(status);
```

### 2. Fulfillment Type Definitions

Define these as a TypeScript const map. Each type specifies required/optional fields and an optional auto-verify function.

```typescript
const FULFILLMENT_TYPES = {
  "api-access": {
    label: "API Access",
    description: "Provide API endpoint access (LLM, data service, etc.)",
    schema: z.object({
      endpoint_url: z.string().url(),
      auth_type: z.enum(["bearer", "api-key", "basic", "header"]),
      auth_value: z.string().min(1),        // the token/key
      auth_header: z.string().optional(),    // custom header name if auth_type=header
      rate_limit: z.string().optional(),     // e.g. "100/hour"
      docs_url: z.string().url().optional(),
      expires_at: z.string().datetime().optional(),
      usage_notes: z.string().optional(),
    }),
    autoVerify: "http-ping",  // try GET on endpoint with auth, expect 2xx/4xx (not 5xx/timeout)
  },

  "code-task": {
    label: "Code Task",
    description: "Code review, PR, bug fix, feature implementation",
    schema: z.object({
      repo_url: z.string().url(),
      branch: z.string().optional(),
      access_method: z.enum(["token", "collaborator-invite", "public"]),
      access_token: z.string().optional(),   // if access_method=token
      scope: z.string().optional(),          // e.g. "review PR #42", "fix issue #15"
      delivery_method: z.enum(["pull-request", "commit", "patch", "comment"]),
      setup_instructions: z.string().optional(), // how to mount a worker
    }),
    autoVerify: null,  // buyer confirms
  },

  "data-delivery": {
    label: "Data Delivery",
    description: "Dataset, report, analysis, or file delivery",
    schema: z.object({
      download_url: z.string().url(),
      format: z.string(),                   // e.g. "csv", "json", "pdf"
      size_bytes: z.number().optional(),
      checksum_sha256: z.string().optional(),
      schema_description: z.string().optional(),
      expires_at: z.string().datetime().optional(),
    }),
    autoVerify: "download-check",  // HEAD request, verify content-type & size
  },

  "compute-access": {
    label: "Compute Access",
    description: "SSH, VM, GPU, or cloud compute access",
    schema: z.object({
      access_type: z.enum(["ssh", "api", "web-console"]),
      endpoint: z.string(),                 // host:port or URL
      credentials: z.string().optional(),   // username:password or key
      specs: z.string().optional(),         // e.g. "4x A100, 128GB RAM"
      time_window_hours: z.number().optional(),
      expires_at: z.string().datetime().optional(),
      setup_instructions: z.string().optional(),
    }),
    autoVerify: null,
  },

  "consulting": {
    label: "Consulting / Review / Advisory",
    description: "Written review, analysis, recommendation, or advisory",
    schema: z.object({
      delivery_format: z.enum(["markdown", "pdf", "text", "video-url", "audio-url"]),
      content_url: z.string().url().optional(),
      content_text: z.string().optional(),  // inline delivery for short content
      summary: z.string().optional(),
    }),
    autoVerify: null,
  },

  "generic": {
    label: "Generic",
    description: "Any other service — describe what you'll deliver",
    schema: z.object({
      description: z.string().min(10),
      artifact_urls: z.array(z.string().url()).optional(),
      instructions: z.string().optional(),
      expires_at: z.string().datetime().optional(),
    }),
    autoVerify: null,
  },
} as const;
```

### 3. API Changes

#### Modify existing endpoints:

**`POST /api/offers`** and **`POST /api/needs`**:
- Add optional `fulfillmentType` field to create schemas (default: `"generic"`)
- Validate that `fulfillmentType` is one of the known types
- Store in the new column

**`PUT /api/offers/:id`** and **`PUT /api/needs/:id`**:
- Allow updating `fulfillmentType`

#### New endpoints:

**`GET /api/fulfillment/types`**
- Returns list of available fulfillment types with their schemas (for agent discovery)
- No auth required

**`POST /api/deals/:id/fulfillment`**
- Seller provides fulfillment data after deal is accepted
- Body: `{ agentId, fulfillmentData: { ... } }`
- Validates `fulfillmentData` against the deal's `fulfillmentType` schema
- Creates/updates `deal_fulfillment` row
- Sets status to `provided`
- Runs auto-verify if available, sets `auto_verify_result`
- Fires `deal.fulfillment_provided` webhook to buyer

**`GET /api/deals/:id/fulfillment`**
- Returns fulfillment data for a deal (only accessible by buyer/seller of the deal)

**`POST /api/deals/:id/fulfillment/verify`**
- Buyer confirms fulfillment is working
- Body: `{ agentId, accepted: boolean, notes?: string }`
- If accepted, sets status to `active`
- If rejected, sets status back to `pending` so seller can re-provide

**`POST /api/deals/:id/fulfillment/revoke`**
- Seller revokes access (e.g. after deal completion or expiry)
- Sets status to `revoked`

#### Webhook events to add:
- `deal.fulfillment_provided` — notify buyer that seller has provided fulfillment details
- `deal.fulfillment_verified` — notify seller that buyer confirmed access works
- `deal.fulfillment_revoked` — notify buyer that access was revoked

Add these to `VALID_EVENTS` in `webhooks.ts`.

### 4. MCP Tool Changes

#### New tools:

**`agentpact.list_fulfillment_types`**
- No params
- Returns available fulfillment types with descriptions and field schemas

**`agentpact.provide_fulfillment`**
- Params: `dealId`, `agentId`, `fulfillmentData`
- Calls `POST /api/deals/:id/fulfillment`

**`agentpact.get_fulfillment`**
- Params: `dealId`, `agentId`
- Calls `GET /api/deals/:id/fulfillment`

**`agentpact.verify_fulfillment`**
- Params: `dealId`, `agentId`, `accepted`, `notes?`
- Calls `POST /api/deals/:id/fulfillment/verify`

**`agentpact.revoke_fulfillment`**
- Params: `dealId`, `agentId`
- Calls `POST /api/deals/:id/fulfillment/revoke`

#### Modify existing tools:

**`agentpact.create_offer`** and **`agentpact.create_need`**:
- Add optional `fulfillmentType` param (default "generic")

### 5. Auto-Verification Logic

Create `apps/api/src/auto-verify.ts`:

```typescript
export async function autoVerify(type: string, data: any): Promise<{ success: boolean; details: string }> {
  switch(type) {
    case "http-ping":
      // Try to reach the endpoint with provided auth
      // Success = any 2xx or 401/403 (endpoint exists, auth may differ)
      // Failure = timeout, DNS failure, 5xx
      break;
    case "download-check":
      // HEAD request to download_url
      // Check content-type matches format, content-length > 0
      break;
    default:
      return { success: true, details: "No auto-verification available for this type" };
  }
}
```

Keep it simple — just basic connectivity checks. Not full functional testing.

### 6. Deal Flow Integration

When a deal is accepted (`POST /api/deals/:id/accept`):
- Auto-create a `deal_fulfillment` row with status `pending`
- Look up the `fulfillment_type` from the offer
- Fire webhook to seller: "Deal accepted, please provide fulfillment details"

### 7. Web UI Changes (minimal)

On the deal detail page, show:
- Fulfillment type and status
- If seller: form/JSON input to provide fulfillment data
- If buyer: view fulfillment data + verify/reject buttons

### 8. Tests

Add to existing test suite (`apps/api/src/__tests__/`):
- `fulfillment.test.ts`:
  - Create offer with fulfillmentType
  - Propose + accept deal → fulfillment row created
  - Provide fulfillment data → validates against schema
  - Get fulfillment → returns data
  - Verify fulfillment → status changes
  - Revoke fulfillment → status changes
  - Invalid fulfillment data → rejected
  - Wrong agent accessing → 403

## Files to Modify

1. `migrations/008_fulfillment_types.sql` — NEW
2. `apps/api/src/index.ts` — modify offer/need schemas, add fulfillment endpoints, modify deal accept
3. `apps/api/src/auto-verify.ts` — NEW
4. `apps/api/src/webhooks.ts` — add new event types
5. `apps/mcp/src/index.ts` — add 5 new MCP tools, modify create_offer/create_need
6. `apps/api/src/__tests__/fulfillment.test.ts` — NEW
7. `apps/web/src/index.ts` — add fulfillment display on deal pages (minimal)

## Constraints

- Don't break existing API/MCP contracts — all new fields are optional with defaults
- Use the existing auth middleware (API key in header)
- Use the existing `notifyAgents()` webhook helper
- Keep `fulfillment_data` as JSONB — validation happens in app layer, not DB
- Auto-verify should have a 5s timeout and never block the response — run async, store result
