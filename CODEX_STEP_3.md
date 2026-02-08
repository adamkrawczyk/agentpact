# Codex Step 3: API Test Suite (TDD)

## Objective
Create comprehensive test coverage for AgentPact API with Vitest.

## TDD Approach

### 1. Install Test Dependencies

```bash
cd /home/adam/repos/agentpact/apps/api
npm install --save-dev vitest @vitest/coverage-v8 @types/node
```

### 2. Configure Vitest

Create `apps/api/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "**/*.test.ts",
        "**/*.config.ts"
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70
      }
    }
  }
});
```

### 3. Update package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json"
  }
}
```

### 4. Create Test Suite Structure

```bash
mkdir -p apps/api/src/__tests__
mkdir -p apps/api/src/__tests__/helpers
```

### 5. Create Test Helpers

Create `apps/api/src/__tests__/helpers/testApp.ts`:

```typescript
import Fastify from "fastify";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

export async function createTestApp() {
  const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 
    "postgres://postgres:postgres@localhost:5432/agentpact_test";
  
  const sql = postgres(DATABASE_URL);
  const app = Fastify({ logger: false });
  
  // Import and initialize your app
  // (You'll need to refactor index.ts to export createApp function)
  
  return { app, sql };
}

export function generateTestAgent() {
  return {
    handle: `test-agent-${randomUUID().slice(0, 8)}`,
    displayName: "Test Agent",
    ownerWalletAddress: `0x${randomUUID().replace(/-/g, "")}`.slice(0, 42),
    walletProvider: "metamask" as const
  };
}

export function generateTestOffer(agentId: string) {
  return {
    agentId,
    title: "Test Offer " + randomUUID().slice(0, 8),
    descriptionMd: "This is a test offer for automated testing",
    category: "Testing",
    tags: ["test", "automation"],
    basePrice: 100,
    currency: "USDC" as const,
    maxPriceDeltaPct: 15,
    slaDays: 7
  };
}

export function generateTestNeed(agentId: string) {
  return {
    agentId,
    title: "Test Need " + randomUUID().slice(0, 8),
    descriptionMd: "This is a test need for automated testing",
    category: "Testing",
    tags: ["test", "automation"],
    budgetMax: 150,
    currency: "USDC" as const
  };
}

export async function cleanDatabase(sql: any) {
  await sql`TRUNCATE TABLE 
    disputes, feedback, deliveries, payment_intents, 
    negotiation_events, milestones, deals, matches, 
    needs, offers, alert_subscriptions, agent_credentials, agents, audit_log
    CASCADE`;
}
```

### 6. Create API Tests

Create `apps/api/src/__tests__/agents.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createTestApp, generateTestAgent, cleanDatabase } from "./helpers/testApp";

describe("Agents API", () => {
  let app: any;
  let sql: any;
  
  beforeEach(async () => {
    ({ app, sql } = await createTestApp());
    await cleanDatabase(sql);
  });
  
  afterAll(async () => {
    await sql.end();
    await app.close();
  });
  
  describe("POST /api/agents", () => {
    it("should create a new agent", async () => {
      const agent = generateTestAgent();
      
      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: agent
      });
      
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBeTruthy();
      expect(body.handle).toBe(agent.handle);
      expect(body.display_name).toBe(agent.displayName);
    });
    
    it("should reject duplicate handle", async () => {
      const agent = generateTestAgent();
      
      // Create first time
      await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: agent
      });
      
      // Try duplicate
      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: agent
      });
      
      // Should update, not error (ON CONFLICT DO UPDATE)
      expect(response.statusCode).toBe(200);
    });
    
    it("should validate required fields", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: {
          handle: "test"
          // Missing required fields
        }
      });
      
      expect(response.statusCode).toBe(400);
    });
  });
  
  describe("GET /api/agents/:id/reputation", () => {
    it("should return reputation score", async () => {
      const agent = generateTestAgent();
      const createRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: agent
      });
      const { id } = JSON.parse(createRes.body);
      
      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${id}/reputation`
      });
      
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.reputationScore).toBeDefined();
      expect(body.completedDeals).toBe(0);
    });
  });
});
```

Create `apps/api/src/__tests__/offers.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createTestApp, generateTestAgent, generateTestOffer, cleanDatabase } from "./helpers/testApp";

describe("Offers API", () => {
  let app: any;
  let sql: any;
  let agentId: string;
  
  beforeEach(async () => {
    ({ app, sql } = await createTestApp());
    await cleanDatabase(sql);
    
    // Create test agent
    const agent = generateTestAgent();
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: agent
    });
    agentId = JSON.parse(response.body).id;
  });
  
  afterAll(async () => {
    await sql.end();
    await app.close();
  });
  
  describe("POST /api/offers", () => {
    it("should create a new offer", async () => {
      const offer = generateTestOffer(agentId);
      
      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        payload: offer
      });
      
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBeTruthy();
      expect(body.title).toBe(offer.title);
      expect(body.status).toBe("active");
    });
    
    it("should enforce foreign key on agentId", async () => {
      const offer = generateTestOffer("00000000-0000-0000-0000-000000000000");
      
      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        payload: offer
      });
      
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain("foreign key");
    });
    
    it("should validate price is positive", async () => {
      const offer = { ...generateTestOffer(agentId), basePrice: -100 };
      
      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        payload: offer
      });
      
      expect(response.statusCode).toBe(400);
    });
  });
  
  describe("GET /api/offers", () => {
    it("should list all active offers", async () => {
      // Create 2 offers
      await app.inject({
        method: "POST",
        url: "/api/offers",
        payload: generateTestOffer(agentId)
      });
      await app.inject({
        method: "POST",
        url: "/api/offers",
        payload: generateTestOffer(agentId)
      });
      
      const response = await app.inject({
        method: "GET",
        url: "/api/offers"
      });
      
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.length).toBeGreaterThanOrEqual(2);
    });
    
    it("should filter by category", async () => {
      await app.inject({
        method: "POST",
        url: "/api/offers",
        payload: { ...generateTestOffer(agentId), category: "AI/ML" }
      });
      await app.inject({
        method: "POST",
        url: "/api/offers",
        payload: { ...generateTestOffer(agentId), category: "Design" }
      });
      
      const response = await app.inject({
        method: "GET",
        url: "/api/offers?category=AI/ML"
      });
      
      const body = JSON.parse(response.body);
      expect(body.every((o: any) => o.category === "AI/ML")).toBe(true);
    });
  });
  
  describe("POST /api/offers/:id/archive", () => {
    it("should archive an offer", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/offers",
        payload: generateTestOffer(agentId)
      });
      const { id } = JSON.parse(createRes.body);
      
      const response = await app.inject({
        method: "POST",
        url: `/api/offers/${id}/archive`,
        payload: { agentId }
      });
      
      expect(response.statusCode).toBe(200);
      
      // Verify archived
      const getRes = await app.inject({
        method: "GET",
        url: `/api/offers/${id}`
      });
      const offer = JSON.parse(getRes.body);
      expect(offer.status).toBe("archived");
    });
  });
});
```

Create `apps/api/src/__tests__/deals.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createTestApp, generateTestAgent, generateTestOffer, generateTestNeed, cleanDatabase } from "./helpers/testApp";

describe("Deals API", () => {
  let app: any;
  let sql: any;
  let buyerId: string;
  let sellerId: string;
  let offerId: string;
  let needId: string;
  
  beforeEach(async () => {
    ({ app, sql } = await createTestApp());
    await cleanDatabase(sql);
    
    // Create buyer agent
    const buyerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: generateTestAgent()
    });
    buyerId = JSON.parse(buyerRes.body).id;
    
    // Create seller agent
    const sellerRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: generateTestAgent()
    });
    sellerId = JSON.parse(sellerRes.body).id;
    
    // Create offer
    const offerRes = await app.inject({
      method: "POST",
      url: "/api/offers",
      payload: generateTestOffer(sellerId)
    });
    offerId = JSON.parse(offerRes.body).id;
    
    // Create need
    const needRes = await app.inject({
      method: "POST",
      url: "/api/needs",
      payload: generateTestNeed(buyerId)
    });
    needId = JSON.parse(needRes.body).id;
  });
  
  afterAll(async () => {
    await sql.end();
    await app.close();
  });
  
  describe("POST /api/deals/propose", () => {
    it("should create a new deal", async () => {
      const deal = {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 120,
        maxPriceDeltaPct: 20,
        milestones: [
          {
            idx: 1,
            title: "Delivery",
            amount: 120,
            acceptanceCriteria: ["Work completed"]
          }
        ]
      };
      
      const response = await app.inject({
        method: "POST",
        url: "/api/deals/propose",
        payload: deal
      });
      
      expect(response.statusCode).toBe(200);
      
      // Verify deal was created
      const [createdDeal] = await sql`
        SELECT * FROM deals
        WHERE buyer_agent_id = ${buyerId}
        AND seller_agent_id = ${sellerId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      expect(createdDeal).toBeTruthy();
      expect(createdDeal.status).toBe("proposed");
    });
    
    it("should create milestones", async () => {
      const deal = {
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        offerId,
        needId,
        negotiatedTotal: 200,
        maxPriceDeltaPct: 20,
        milestones: [
          {
            idx: 1,
            title: "Phase 1",
            amount: 100,
            acceptanceCriteria: ["Milestone 1 done"]
          },
          {
            idx: 2,
            title: "Phase 2",
            amount: 100,
            acceptanceCriteria: ["Milestone 2 done"]
          }
        ]
      };
      
      await app.inject({
        method: "POST",
        url: "/api/deals/propose",
        payload: deal
      });
      
      const milestones = await sql`
        SELECT * FROM milestones
        WHERE deal_id IN (
          SELECT id FROM deals WHERE buyer_agent_id = ${buyerId}
        )
      `;
      
      expect(milestones.length).toBe(2);
    });
  });
  
  describe("POST /api/deals/:id/accept", () => {
    it("should accept a proposed deal", async () => {
      // Propose deal first
      await app.inject({
        method: "POST",
        url: "/api/deals/propose",
        payload: {
          buyerAgentId: buyerId,
          sellerAgentId: sellerId,
          offerId,
          needId,
          negotiatedTotal: 120,
          maxPriceDeltaPct: 20,
          milestones: [{ idx: 1, title: "Delivery", amount: 120, acceptanceCriteria: ["Done"] }]
        }
      });
      
      const [deal] = await sql`
        SELECT id FROM deals WHERE buyer_agent_id = ${buyerId}
      `;
      
      // Accept deal
      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${deal.id}/accept`,
        payload: { actorAgentId: sellerId }
      });
      
      expect(response.statusCode).toBe(200);
      
      // Verify status changed
      const [updated] = await sql`
        SELECT status FROM deals WHERE id = ${deal.id}
      `;
      expect(updated.status).toBe("accepted");
    });
  });
});
```

### 7. Run Tests

```bash
cd apps/api
npm test
```

Expected output:
```
✓ apps/api/src/__tests__/agents.test.ts (3)
✓ apps/api/src/__tests__/offers.test.ts (5)
✓ apps/api/src/__tests__/deals.test.ts (3)

Test Files  3 passed (3)
Tests  11 passed (11)
```

### 8. Check Coverage

```bash
npm run test:coverage
```

Target: **70%+ coverage** ✅

### When Complete

Run this command:
```bash
openclaw gateway wake --text "Test suite complete! 70%+ coverage ✅" --mode now
```

## Success Criteria

- ✅ All tests pass
- ✅ Test coverage >70% (lines, functions, branches)
- ✅ Tests run in isolated database
- ✅ Helper functions for test data generation
- ✅ Tests for all major endpoints (agents, offers, needs, deals)
- ✅ Tests for validation and error cases
- ✅ Fast test execution (<5 seconds)

## Notes

- Tests use separate database (`agentpact_test`)
- Each test cleans database before running
- Use `vitest watch` during development
- Coverage report in `coverage/` directory
- Add more tests for edge cases as needed
