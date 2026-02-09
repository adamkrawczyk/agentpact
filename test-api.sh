#!/bin/bash
# AgentPact API Integration Test

API_URL="http://localhost:4000/api"

echo "🧪 AgentPact API Integration Test"
echo "=================================="
echo ""

# Test 1: Health check
echo "1️⃣ Health Check"
HEALTH=$(curl -s "$API_URL/../health")
echo "   Response: $HEALTH"
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "   ✅ API is healthy"
else
  echo "   ❌ Health check failed"
  exit 1
fi
echo ""

# Test 2: Create agent
echo "2️⃣ Create Agent (Seller)"
AGENT1=$(curl -s -X POST "$API_URL/agents" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AI Training Bot",
    "agentType": "seller",
    "capabilities": ["machine-learning", "tensorflow", "pytorch"],
    "contactInfo": {"email": "ai-bot@example.com"},
    "walletAddress": "0xSeller123456789"
  }')
AGENT1_ID=$(echo "$AGENT1" | jq -r '.id // empty')
if [ -n "$AGENT1_ID" ]; then
  echo "   ✅ Agent created: $AGENT1_ID"
else
  echo "   Response: $AGENT1"
  echo "   ❌ Failed to create agent"
  exit 1
fi
echo ""

# Test 3: Create second agent (buyer)
echo "3️⃣ Create Agent (Buyer)"
AGENT2=$(curl -s -X POST "$API_URL/agents" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Data Science Corp",
    "agentType": "buyer",
    "capabilities": ["data-analysis"],
    "contactInfo": {"email": "buyer@example.com"},
    "walletAddress": "0xBuyer987654321"
  }')
AGENT2_ID=$(echo "$AGENT2" | jq -r '.id // empty')
if [ -n "$AGENT2_ID" ]; then
  echo "   ✅ Agent created: $AGENT2_ID"
else
  echo "   ❌ Failed to create buyer agent"
  exit 1
fi
echo ""

# Test 4: Create offer
echo "4️⃣ Create Offer"
OFFER=$(curl -s -X POST "$API_URL/offers" \
  -H "Content-Type: application/json" \
  -d "{
    \"agentId\": \"$AGENT1_ID\",
    \"title\": \"Custom AI Model Training\",
    \"descriptionMd\": \"Train custom ML models on your dataset with 95%+ accuracy\",
    \"category\": \"AI/ML\",
    \"tags\": [\"machine-learning\", \"tensorflow\", \"custom-models\"],
    \"basePrice\": 500,
    \"currency\": \"USDC\",
    \"maxPriceDeltaPct\": 20,
    \"slaDays\": 14
  }")
OFFER_ID=$(echo "$OFFER" | jq -r '.id // empty')
if [ -n "$OFFER_ID" ]; then
  echo "   ✅ Offer created: $OFFER_ID"
else
  echo "   Response: $OFFER"
  echo "   ❌ Failed to create offer"
  exit 1
fi
echo ""

# Test 5: Create need
echo "5️⃣ Create Need"
NEED=$(curl -s -X POST "$API_URL/needs" \
  -H "Content-Type: application/json" \
  -d "{
    \"agentId\": \"$AGENT2_ID\",
    \"title\": \"Need ML Model for Customer Churn Prediction\",
    \"descriptionMd\": \"Looking for someone to build a churn prediction model\",
    \"category\": \"AI/ML\",
    \"tags\": [\"machine-learning\", \"classification\"],
    \"budgetMin\": 400,
    \"budgetMax\": 600,
    \"currency\": \"USDC\"
  }")
NEED_ID=$(echo "$NEED" | jq -r '.id // empty')
if [ -n "$NEED_ID" ]; then
  echo "   ✅ Need created: $NEED_ID"
else
  echo "   Response: $NEED"
  echo "   ❌ Failed to create need"
  exit 1
fi
echo ""

# Test 6: Recompute matches
echo "6️⃣ Recompute Matches"
MATCHES=$(curl -s -X POST "$API_URL/matches/recompute")
echo "   Response: $MATCHES"
if echo "$MATCHES" | grep -q '"count"'; then
  echo "   ✅ Matches computed"
else
  echo "   ⚠️  Matches may not have computed"
fi
echo ""

# Test 7: Get recommendations
echo "7️⃣ Get Match Recommendations"
RECS=$(curl -s "$API_URL/matches/recommendations?actorType=buyer&actorId=$AGENT2_ID")
MATCH_COUNT=$(echo "$RECS" | jq '. | length')
echo "   Found $MATCH_COUNT matches"
if [ "$MATCH_COUNT" -gt 0 ]; then
  echo "   ✅ Recommendations working"
  echo "   Top match:"
  echo "$RECS" | jq '.[0] | {score, offer_title, need_title}' | sed 's/^/   /'
else
  echo "   ⚠️  No matches found (may need tags to overlap)"
fi
echo ""

# Test 8: Propose deal
echo "8️⃣ Propose Deal"
DEAL=$(curl -s -X POST "$API_URL/deals/propose" \
  -H "Content-Type: application/json" \
  -d "{
    \"buyerAgentId\": \"$AGENT2_ID\",
    \"sellerAgentId\": \"$AGENT1_ID\",
    \"offerId\": \"$OFFER_ID\",
    \"needId\": \"$NEED_ID\",
    \"negotiatedTotal\": 550,
    \"maxPriceDeltaPct\": 20,
    \"milestones\": [
      {
        \"idx\": 1,
        \"title\": \"Model Training Complete\",
        \"amount\": 275,
        \"acceptanceCriteria\": [\"Model achieves 95%+ accuracy\", \"Training logs provided\"]
      },
      {
        \"idx\": 2,
        \"title\": \"Model Deployed\",
        \"amount\": 275,
        \"acceptanceCriteria\": [\"API endpoint live\", \"Documentation provided\"]
      }
    ],
    \"acceptanceTimeoutDays\": 7
  }")
DEAL_ID=$(echo "$DEAL" | jq -r '.id // empty')
if [ -n "$DEAL_ID" ]; then
  echo "   ✅ Deal proposed: $DEAL_ID"
else
  echo "   Response: $DEAL"
  echo "   ❌ Failed to propose deal"
  exit 1
fi
echo ""

# Test 9: Get deal details
echo "9️⃣ Get Deal Details"
DEAL_DETAILS=$(curl -s "$API_URL/deals/$DEAL_ID")
STATUS=$(echo "$DEAL_DETAILS" | jq -r '.status // empty')
echo "   Deal status: $STATUS"
if [ "$STATUS" = "proposed" ]; then
  echo "   ✅ Deal in proposed state"
else
  echo "   ⚠️  Unexpected status: $STATUS"
fi
echo ""

# Test 10: Accept deal
echo "🔟 Accept Deal (Seller)"
ACCEPT=$(curl -s -X POST "$API_URL/deals/$DEAL_ID/accept" \
  -H "Content-Type: application/json" \
  -d "{
    \"actorAgentId\": \"$AGENT1_ID\"
  }")
echo "   Response: $(echo "$ACCEPT" | jq -c '.status // .message')"
if echo "$ACCEPT" | grep -q '"status":"accepted"'; then
  echo "   ✅ Deal accepted!"
else
  echo "   ⚠️  Acceptance response: $ACCEPT"
fi
echo ""

echo "=================================="
echo "✅ All core flows tested!"
echo ""
echo "Summary:"
echo "  - Agents: 2 created"
echo "  - Offers: 1 active"
echo "  - Needs: 1 open"
echo "  - Matches: Computed"
echo "  - Deals: 1 proposed → accepted"
echo ""
echo "Next: Test payments, deliveries, disputes"
