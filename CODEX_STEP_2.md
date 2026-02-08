# Codex Step 2: API Authentication & Security

## Objective
Add JWT authentication and rate limiting to protect the AgentPact API.

## TDD Approach

### 1. Install Dependencies

```bash
cd /home/adam/repos/agentpact/apps/api
npm install @fastify/jwt @fastify/rate-limit bcrypt jsonwebtoken
npm install --save-dev @types/bcrypt @types/jsonwebtoken
```

### 2. Create Test File FIRST (Red Phase)

Create `apps/api/src/__tests__/auth.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert";
import Fastify from "fastify";
import { initAuth } from "../auth";

test("Auth: Register agent API key", async () => {
  const app = Fastify();
  await initAuth(app);
  
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      agentId: "550e8400-e29b-41d4-a716-446655440000",
      walletAddress: "0x1234567890123456789012345678901234567890"
    }
  });
  
  assert.strictEqual(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(body.apiKey);
  assert.strictEqual(body.apiKey.length, 64);
});

test("Auth: Verify valid API key", async () => {
  const app = Fastify();
  await initAuth(app);
  
  // Register first
  const registerRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      agentId: "550e8400-e29b-41d4-a716-446655440000",
      walletAddress: "0x1234567890123456789012345678901234567890"
    }
  });
  
  const { apiKey } = JSON.parse(registerRes.body);
  
  // Verify
  const verifyRes = await app.inject({
    method: "GET",
    url: "/api/auth/verify",
    headers: {
      "x-api-key": apiKey
    }
  });
  
  assert.strictEqual(verifyRes.statusCode, 200);
  const body = JSON.parse(verifyRes.body);
  assert.strictEqual(body.agentId, "550e8400-e29b-41d4-a716-446655440000");
});

test("Auth: Reject invalid API key", async () => {
  const app = Fastify();
  await initAuth(app);
  
  const response = await app.inject({
    method: "GET",
    url: "/api/auth/verify",
    headers: {
      "x-api-key": "invalid_key"
    }
  });
  
  assert.strictEqual(response.statusCode, 401);
});

test("Auth: Protected route requires API key", async () => {
  const app = Fastify();
  await initAuth(app);
  
  // Add a protected route
  app.get("/api/protected", {
    preHandler: app.authenticate
  }, async () => {
    return { success: true };
  });
  
  // Without API key
  const noKeyRes = await app.inject({
    method: "GET",
    url: "/api/protected"
  });
  assert.strictEqual(noKeyRes.statusCode, 401);
  
  // With valid API key
  const registerRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      agentId: "550e8400-e29b-41d4-a716-446655440000",
      walletAddress: "0x1234"
    }
  });
  const { apiKey } = JSON.parse(registerRes.body);
  
  const withKeyRes = await app.inject({
    method: "GET",
    url: "/api/protected",
    headers: {
      "x-api-key": apiKey
    }
  });
  assert.strictEqual(withKeyRes.statusCode, 200);
});

test("Rate Limiting: Blocks after limit exceeded", async () => {
  const app = Fastify();
  await initAuth(app);
  
  const apiKey = "test_key";
  
  // Make 6 requests (limit is 5/minute)
  for (let i = 0; i < 6; i++) {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/verify",
      headers: {
        "x-api-key": apiKey
      }
    });
    
    if (i < 5) {
      assert.ok(response.statusCode <= 401); // 401 for invalid key, but not rate limited
    } else {
      assert.strictEqual(response.statusCode, 429); // Rate limited
    }
  }
});
```

### 3. Create Implementation (Green Phase)

Create `apps/api/src/auth.ts`:

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fastifyJWT from "@fastify/jwt";
import fastifyRateLimit from "@fastify/rate-limit";
import { randomBytes, createHash } from "node:crypto";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev_secret_change_in_production";
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 100);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000);

const sql = postgres(DATABASE_URL);

export interface AuthenticatedRequest extends FastifyRequest {
  agentId?: string;
  apiKeyHash?: string;
}

function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export async function initAuth(app: FastifyInstance) {
  // Register JWT plugin
  await app.register(fastifyJWT, {
    secret: JWT_SECRET
  });
  
  // Register rate limiting
  await app.register(fastifyRateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request: FastifyRequest) => {
      // Rate limit by API key or IP
      const apiKey = request.headers["x-api-key"] as string;
      return apiKey ? hashApiKey(apiKey) : request.ip;
    }
  });
  
  // Authentication decorator
  app.decorate("authenticate", async function(request: AuthenticatedRequest, reply: FastifyReply) {
    const apiKey = request.headers["x-api-key"] as string;
    
    if (!apiKey) {
      return reply.code(401).send({ error: "Missing API key" });
    }
    
    const apiKeyHash = hashApiKey(apiKey);
    
    const [credential] = await sql`
      SELECT agent_id, wallet_address
      FROM agent_credentials
      WHERE api_key_hash = ${apiKeyHash}
      AND revoked_at IS NULL
    `;
    
    if (!credential) {
      return reply.code(401).send({ error: "Invalid API key" });
    }
    
    request.agentId = credential.agent_id;
    request.apiKeyHash = apiKeyHash;
  });
  
  // Auth routes
  app.post("/api/auth/register", async (request, reply) => {
    const { agentId, walletAddress } = request.body as {
      agentId: string;
      walletAddress: string;
    };
    
    // Generate API key
    const apiKey = randomBytes(32).toString("hex");
    const apiKeyHash = hashApiKey(apiKey);
    
    // Store in database
    await sql`
      INSERT INTO agent_credentials (agent_id, wallet_address, api_key_hash)
      VALUES (${agentId}, ${walletAddress}, ${apiKeyHash})
      ON CONFLICT (agent_id) DO UPDATE
        SET api_key_hash = EXCLUDED.api_key_hash,
            wallet_address = EXCLUDED.wallet_address,
            created_at = NOW(),
            revoked_at = NULL
    `;
    
    return { apiKey, agentId };
  });
  
  app.get("/api/auth/verify", {
    preHandler: app.authenticate as any
  }, async (request: AuthenticatedRequest) => {
    return {
      agentId: request.agentId,
      authenticated: true
    };
  });
  
  app.post("/api/auth/revoke", {
    preHandler: app.authenticate as any
  }, async (request: AuthenticatedRequest, reply) => {
    await sql`
      UPDATE agent_credentials
      SET revoked_at = NOW()
      WHERE api_key_hash = ${request.apiKeyHash}
    `;
    
    return { revoked: true };
  });
}
```

### 4. Update Database Schema

Create `apps/api/migrations/002_auth.sql`:

```sql
-- Agent credentials table
CREATE TABLE IF NOT EXISTS agent_credentials (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_api_key_hash ON agent_credentials(api_key_hash) WHERE revoked_at IS NULL;

-- Track API usage
CREATE TABLE IF NOT EXISTS api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_usage_agent ON api_usage(agent_id, created_at DESC);
```

### 5. Update Main API

Modify `apps/api/src/index.ts`:

```typescript
import { initAuth } from "./auth";

// After app initialization and before routes
await app.register(cors, {
  origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",")
});

// Initialize auth
await initAuth(app);

// Protect all /api routes except auth and health
app.addHook("preHandler", async (request, reply) => {
  // Skip auth for these routes
  const publicRoutes = ["/health", "/api/auth/register", "/api/auth/verify"];
  if (publicRoutes.includes(request.url)) {
    return;
  }
  
  // Require authentication for all other /api routes
  if (request.url.startsWith("/api/")) {
    await app.authenticate(request, reply);
  }
});
```

### 6. Run Migration

```bash
cd /home/adam/repos/agentpact
npm run migrate
```

### 7. Run Tests

```bash
cd apps/api
npm test -- auth.test.ts
```

Expected output: **All auth tests should PASS** ✅

### 8. Manual Testing

```bash
# Start API
npm run dev

# Register agent (get API key)
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "550e8400-e29b-41d4-a716-446655440000",
    "walletAddress": "0x1234567890123456789012345678901234567890"
  }'
# Returns: {"apiKey":"<64-char-hex>","agentId":"..."}

# Test protected endpoint (should fail without key)
curl http://localhost:4000/api/offers
# Returns: 401 Unauthorized

# Test with API key (should work)
curl http://localhost:4000/api/offers \
  -H "x-api-key: <your-api-key>"
# Returns: offer list

# Test rate limiting (make 101 requests rapidly)
for i in {1..101}; do
  curl -s http://localhost:4000/health -o /dev/null -w "%{http_code}\n"
done
# First 100: 200, 101st: 429 (rate limited)
```

### When Complete

Run this command:
```bash
openclaw gateway wake --text "Authentication & security complete! All tests passing ✅" --mode now
```

## Success Criteria

- ✅ All authentication tests pass
- ✅ API keys generated and stored securely (hashed)
- ✅ Protected routes require valid API key
- ✅ Rate limiting prevents abuse (100 req/min default)
- ✅ Invalid API keys rejected (401)
- ✅ API keys can be revoked
- ✅ CORS restricted to whitelist
- ✅ Database migration applied

## Security Notes

- API keys are 64 hex chars (256-bit entropy)
- Keys stored as SHA-256 hash (never plaintext)
- Rate limiting by API key (prevents single agent abuse)
- JWT secret must be 32+ chars in production
- CORS whitelist required for production
- Consider adding IP whitelisting for admin endpoints
