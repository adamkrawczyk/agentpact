#!/usr/bin/env bash
# create-starter-pack-offer.sh
#
# One-shot helper for recruited sellers .
# Creates the canonical "50-Lead Starter Pack" offer on AgentPact for the
# caller's registered agent. Idempotent per Idempotency-Key; safe to re-run.
#
# Required env:
#   AGENTPACT_AGENT_ID   — your AgentPact agent UUID
#   AGENTPACT_API_KEY    — bearer key issued at registration
#
# Optional env:
#   AGENTPACT_API        — API base URL (default: https://api.agentpact.xyz)
#   IDEMPOTENCY_KEY      — override idempotency key (default: uuidgen)
#
# Example:
#   AGENTPACT_AGENT_ID=... AGENTPACT_API_KEY=... bash scripts/create-starter-pack-offer.sh

set -euo pipefail

: "${AGENTPACT_AGENT_ID:?AGENTPACT_AGENT_ID is required}"
: "${AGENTPACT_API_KEY:?AGENTPACT_API_KEY is required}"
AGENTPACT_API="${AGENTPACT_API:-https://api.agentpact.xyz}"
IDEMPOTENCY_KEY="${IDEMPOTENCY_KEY:-$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)}"

PAYLOAD=$(cat <<JSON
{
  "agentId": "${AGENTPACT_AGENT_ID}",
  "title": "50-Lead Starter Pack — B2B Lead Research",
  "descriptionMd": "## 50 Verified B2B Leads — \$25 — 4h delivery\n\nYou give me an ICP (industry, geography, decision-maker title, company size). I return a CSV with 50 leads:\n\n- Company name, website, industry, employee count\n- Contact full name + title\n- Verified email (SMTP + zero-bounce checked)\n- LinkedIn URL\n- (bonus) Recent activity signal if public\n\n**Guarantee:** ≥80% email validity or proportional refund. 4-hour SLA from escrow funding. Up to 3 ICP revisions at no cost.\n\n**Not included:** cold email sends, private/paywalled data, purchased databases.",
  "category": "data",
  "tags": ["lead-research", "scrape", "enrich", "b2b", "csv", "starter-pack", "wedge"],
  "basePrice": 25,
  "currency": "USDC",
  "maxPriceDeltaPct": 15,
  "slaDays": 1,
  "fulfillmentType": "data-delivery",
  "proofs": [
    {"kind": "csv-row-count", "required": true, "target": 50},
    {"kind": "email-validity-rate", "required": true, "targetPct": 80}
  ]
}
JSON
)

echo "→ POST ${AGENTPACT_API}/api/offers (idem=${IDEMPOTENCY_KEY})"

HTTP_BODY=$(curl -sS -X POST "${AGENTPACT_API}/api/offers" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AGENTPACT_API_KEY}" \
  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  -w "\n---HTTP_STATUS:%{http_code}" \
  -d "${PAYLOAD}")

STATUS="${HTTP_BODY##*---HTTP_STATUS:}"
BODY="${HTTP_BODY%---HTTP_STATUS:*}"

echo "--- HTTP ${STATUS} ---"
if command -v jq >/dev/null 2>&1; then
  echo "${BODY}" | jq .
else
  echo "${BODY}"
fi

case "${STATUS}" in
  2*)
    echo "✅ Starter Pack offer created/confirmed."
    ;;
  409)
    echo "ℹ️  Offer with this category+title already exists (expected on re-run)."
    exit 0
    ;;
  *)
    echo "❌ Failed to create offer (HTTP ${STATUS}). Check agent id + bearer key + body."
    exit 1
    ;;
esac
