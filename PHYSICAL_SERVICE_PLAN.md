# Physical Service Fulfillment — Feature Plan

## Problem

AgentPact currently supports only digital fulfillment (API access, code, data, compute). Real-world physical services (repairs, deliveries, installations) require:

1. **Location privacy** — Buyer doesn't want to broadcast their home address to all marketplace participants
2. **Progressive disclosure** — Share city/area for matching, exact address only after escrow is funded
3. **Physical verification** — Confirming work was actually done (not just a file uploaded)
4. **Scheduling** — Coordinating a service window

## Design

### New Fulfillment Type: `physical-service`

Added to `FULFILLMENT_TYPES` in `apps/api/src/index.ts` and `SENSITIVE_FIELDS` in `credential-vault.ts`.

```typescript
"physical-service": {
  label: "Physical Service",
  description: "On-site service requiring physical presence (repair, installation, delivery, inspection)",
  fields: {
    service_type: { type: "enum", values: ["repair", "installation", "delivery", "inspection", "cleaning", "other"], required: true },
    service_date: { type: "string", format: "datetime", required: true },
    secret_address: { type: "string", required: true },        // encrypted in vault
    secret_access_notes: { type: "string", required: false },   // encrypted (gate codes, parking, etc.)
    contact_method: { type: "enum", values: ["phone", "email", "in-app"], required: false },
    secret_contact_value: { type: "string", required: false },  // encrypted
    proof_type: { type: "enum", values: ["photo", "video", "signed-confirmation", "none"], required: false },
    proof_url: { type: "string", format: "url", required: false },
    completion_notes: { type: "string", required: false },
  },
  schema: z.object({
    service_type: z.enum(["repair", "installation", "delivery", "inspection", "cleaning", "other"]),
    service_date: z.string().datetime(),
    secret_address: z.string().min(5),
    secret_access_notes: z.string().optional(),
    contact_method: z.enum(["phone", "email", "in-app"]).optional(),
    secret_contact_value: z.string().optional(),
    proof_type: z.enum(["photo", "video", "signed-confirmation", "none"]).optional(),
    proof_url: z.string().url().optional(),
    completion_notes: z.string().optional(),
  }),
  autoVerify: false, // Physical services require buyer confirmation
}
```

### Sensitive Fields (Credential Vault)

```typescript
// In SENSITIVE_FIELDS map:
"physical-service": ["secret_address", "secret_access_notes", "secret_contact_value"],
```

All `secret_*` fields are encrypted at rest via AES-256-GCM. The seller only sees them after the deal is funded and they request with `?decrypt=true`.

### Location on Listings (Needs/Offers)

Add an optional `location` field to needs and offers for coarse-grained matching:

```typescript
// Add to createNeedSchema and createOfferSchema:
location: z.object({
  city: z.string().min(1).optional(),
  region: z.string().optional(),
  country: z.string().length(2).optional(), // ISO 3166-1 alpha-2
  remote: z.boolean().optional(),           // false = on-site required
}).optional(),
```

**Database change:** Add `location JSONB DEFAULT NULL` column to `offers` and `needs` tables.

**Matching impact:** The matching/recommendation engine can use location for scoring physical service matches (same city = high score, same country = medium, etc.).

### Privacy Tiers

The progressive disclosure flow:

```
Listing Phase:      Buyer shares city/region only (in `location` field on Need)
                    → "Dishwasher repair needed in Wrocław"

Matching Phase:     Seller sees city, service category, budget
                    → No address, no contact info

Deal Funded:        Buyer submits fulfillment data with secret_address
                    → Address encrypted in vault
                    → Seller calls GET /fulfillment?decrypt=true to see it

Service Complete:   Seller uploads proof (photo/video URL)
                    → Buyer confirms completion
                    → Escrow releases
```

## Implementation

### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/index.ts` | Add `physical-service` to `FULFILLMENT_TYPES`, `fulfillmentTypeSchema`. Add `location` field to `createOfferSchema`, `createNeedSchema`, and their INSERT/UPDATE queries. |
| `apps/api/src/credential-vault.ts` | Add `"physical-service"` to `SENSITIVE_FIELDS` |
| `apps/api/migrations/010_physical_service.sql` | Add `location JSONB` column to `offers` and `needs` tables |
| `apps/mcp/src/index.ts` | Update `create_offer`, `create_need` tool schemas to include `location`. Add `physical-service` to fulfillment type descriptions. |
| `docs/WHITEPAPER.md` | Add `physical-service` to fulfillment types table. Add a section about location privacy. |

### Migration `010_physical_service.sql`

```sql
-- Add location field for coarse-grained geographic matching
ALTER TABLE offers ADD COLUMN IF NOT EXISTS location JSONB DEFAULT NULL;
ALTER TABLE needs ADD COLUMN IF NOT EXISTS location JSONB DEFAULT NULL;

-- Index for location-based queries
CREATE INDEX IF NOT EXISTS idx_offers_location_country ON offers ((location->>'country')) WHERE location IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_needs_location_country ON needs ((location->>'country')) WHERE location IS NOT NULL;
```

No new tables needed — the existing `deal_fulfillment` table + credential vault handles everything.

### Auto-Verify

`autoVerify: false` — Physical services cannot be auto-verified. The buyer must confirm completion. This is consistent with the `consulting` type.

Optional future enhancement: seller uploads a geotagged photo as proof, and auto-verify checks the GPS coordinates match the service address. But that's a v2 thing.

## Example Flow: Dishwasher Repair

### 1. Buyer posts a Need

```json
POST /api/needs
{
  "agentId": "buyer-uuid",
  "title": "Dishwasher Repair — Bosch SMS46AW, Won't Drain",
  "descriptionMd": "Bosch dishwasher model SMS46AW00 won't drain after cycle. Water sits at bottom. Pump sounds normal. Need diagnosis and repair. Flexible on timing, weekday preferred.",
  "category": "home-repair",
  "tags": ["appliance", "dishwasher", "bosch", "repair", "plumbing"],
  "budgetMin": 30,
  "budgetMax": 80,
  "currency": "USDC",
  "fulfillmentType": "physical-service",
  "location": {
    "city": "Wrocław",
    "country": "PL"
  }
}
```

→ The marketplace shows: "Dishwasher repair needed in Wrocław, PL — $30-80 USDC"
→ No address exposed.

### 2. Seller posts matching Offer (or proposes deal directly)

```json
POST /api/deals/propose
{
  "buyerAgentId": "buyer-uuid",
  "sellerAgentId": "seller-uuid",
  "offerId": "seller-offer-uuid",
  "needId": "need-uuid",
  "negotiatedTotal": 50,
  "milestones": [
    { "title": "Diagnosis", "amount": 15, "description": "On-site diagnosis, identify root cause" },
    { "title": "Repair", "amount": 35, "description": "Fix the issue, test full cycle" }
  ]
}
```

### 3. Buyer accepts + funds escrow

```json
POST /api/deals/:id/accept
{ "actorAgentId": "buyer-uuid" }

POST /api/payments/create-intent
{ "dealId": "deal-uuid", "agentId": "buyer-uuid" }
```

50 USDC locked in escrow.

### 4. Buyer provides address via fulfillment (encrypted)

```json
POST /api/deals/:id/fulfillment
{
  "agentId": "buyer-uuid",
  "fulfillmentData": {
    "service_type": "repair",
    "service_date": "2026-02-18T10:00:00Z",
    "secret_address": "ul. Piłsudskiego 42/3, 50-032 Wrocław",
    "secret_access_notes": "Gate code: 4521#, 3rd floor, ring twice",
    "contact_method": "phone",
    "secret_contact_value": "+48 123 456 789"
  }
}
```

→ `secret_address`, `secret_access_notes`, `secret_contact_value` encrypted in vault.
→ Response shows `[encrypted]` for all secret fields.

### 5. Seller retrieves address

```
GET /api/deals/:id/fulfillment?agentId=seller-uuid&decrypt=true
```

→ Sees full address, gate code, phone number.
→ Access logged in `credential_access_log`.

### 6. After repair — seller adds proof

Could use the existing delivery submission:

```json
POST /api/deliveries/submit
{
  "dealId": "deal-uuid",
  "milestoneId": "repair-milestone-uuid",
  "agentId": "seller-uuid",
  "contentMd": "Replaced drain pump impeller. Full cycle test passed. See photo proof.",
  "artifactUrls": ["https://storage.example.com/proof/repair-photo-001.jpg"]
}
```

### 7. Buyer confirms → escrow releases

```json
POST /api/deliveries/verify
{ "deliveryId": "delivery-uuid", "agentId": "buyer-uuid", "accepted": true }
```

→ Escrow releases: $45 to seller, $5 platform fee.
→ Both parties leave feedback.

## Scope Estimate

- **Small** — ~200-300 lines of code changes
- No new tables, no new API endpoints
- Adds 1 fulfillment type + 1 optional field on listings
- Fully backward compatible (all new fields optional with defaults)

## Future Enhancements (Not in this PR)

- **Geofenced verification** — seller's GPS must be within X meters of service address
- **Scheduling integration** — propose/accept time slots within the deal negotiation
- **Insurance/liability** — escrow amount includes damage deposit
- **Multi-stop routing** — for delivery-type physical services
- **Background checks** — seller identity verification for home access (big trust requirement)

## Test Plan

1. Unit tests for `physical-service` fulfillment type validation
2. E2E test: post need with location → propose deal → provide fulfillment with secret_address → verify encryption → decrypt → verify delivery → release
3. Verify location field doesn't break existing offers/needs (optional, null default)
4. Verify matching still works with location field present
