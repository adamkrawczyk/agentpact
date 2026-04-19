import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyJWT from "@fastify/jwt";
import postgres from "postgres";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:***@localhost:5432/agentpact";
const JWT_SECRET=process.env.JWT_SECRET ?? "dev_secret_change_in_production";

// Default events for auto-created webhooks at registration
const DEFAULT_WEBHOOK_EVENTS = [
  "deal.proposed",
  "deal.accepted",
  "deal.cancelled",
  "deal.fulfillment_provided",
  "deal.fulfillment_verified",
  "payment.released",
  "milestone.completed",
  "concierge.message",
] as const;

const registerSchema = z.object({
  agentId: z.string().uuid(),
  walletAddress: z.string().min(4).optional(),
  webhookUrl: z.string().url().optional(),
  webhookEvents: z.array(z.string().min(1)).optional(),
});

type CredentialRecord = {
  agentId: string;
  walletAddress: string;
  apiKeyHash: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

type AuthSqlClient = {
  (template: TemplateStringsArray, ...parameters: readonly unknown[]): Promise<unknown[]>;
  end?: (options?: { timeout?: number }) => Promise<void>;
};

declare module "fastify" {
  interface FastifyRequest {
    agentId?: string;
    apiKeyHash?: string;
  }

  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

/**
 * SHA-256 hash for API keys. API keys are 32 random bytes (256 bits of entropy),
 * so SHA-256 is perfectly safe — this isn't a password, it's a random token.
 * Using SHA-256 allows O(1) DB lookups instead of scanning all credentials with bcrypt.
 */
function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

const memoryCredentials = new Map<string, CredentialRecord>();

export async function initAuth(
  app: FastifyInstance,
  injectedDb?: AuthSqlClient
): Promise<void> {
  const db = injectedDb ?? (postgres(DATABASE_URL, { max: 3 }) as unknown as AuthSqlClient);

  await app.register(fastifyJWT, { secret: JWT_SECRET });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawApiKey = request.headers["x-api-key"];
    if (typeof rawApiKey !== "string" || rawApiKey.length < 16) {
      return reply.code(401).send({ error: "Missing API key" });
    }

    const apiKeyHash = hashApiKey(rawApiKey);

    // Check in-memory cache first
    const cached = memoryCredentials.get(apiKeyHash);
    if (cached && !cached.revokedAt) {
      cached.lastUsedAt = new Date();
      request.agentId = cached.agentId;
      request.apiKeyHash = apiKeyHash;
      return;
    }

    try {
      const rows = await db`
        SELECT agent_id, wallet_address, api_key_hash
        FROM agent_credentials
        WHERE api_key_hash = ${apiKeyHash} AND revoked_at IS NULL
      `;

      if (rows.length === 0) {
        return reply.code(401).send({ error: "Invalid API key" });
      }

      const credential = rows[0] as { agent_id: string; wallet_address: string; api_key_hash: string };
      request.agentId = credential.agent_id;
      request.apiKeyHash = apiKeyHash;
      memoryCredentials.set(apiKeyHash, {
        agentId: credential.agent_id,
        walletAddress: credential.wallet_address,
        apiKeyHash: apiKeyHash,
        revokedAt: null,
        lastUsedAt: new Date()
      });
    } catch {
      return reply.code(401).send({ error: "Invalid API key" });
    }
  });

  // Register endpoint — public, creates API key for an agent
  app.post(
    "/api/auth/register",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => request.ip
        }
      }
    },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      const walletAddress = body.walletAddress ?? "";
      const apiKey = randomBytes(32).toString("hex");
      const apiKeyHash = hashApiKey(apiKey);

      try {
        // Auto-create agent if it doesn't exist (agents table FK required)
        await db`
          INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider)
          VALUES (${body.agentId}, ${'agent-' + body.agentId}, ${'Agent ' + body.agentId.slice(0, 8)}, ${walletAddress}, 'metamask')
          ON CONFLICT (id) DO NOTHING
        `;

        const insertedCredentials = await db`
          INSERT INTO agent_credentials (agent_id, wallet_address, api_key_hash)
          VALUES (${body.agentId}, ${walletAddress}, ${apiKeyHash})
          ON CONFLICT (agent_id) DO NOTHING
          RETURNING agent_id
        `;

        if (insertedCredentials.length === 0) {
          return reply.code(409).send({
            error: "Agent already registered. Use /api/auth/rotate-key to update credentials."
          });
        }
      } catch {
        return reply.code(500).send({ error: "Registration failed" });
      }

      memoryCredentials.set(apiKeyHash, {
        agentId: body.agentId,
        walletAddress,
        apiKeyHash,
        revokedAt: null,
        lastUsedAt: new Date()
      });

      // Auto-create webhook subscription if webhookUrl provided
      let webhook = null;
      if (body.webhookUrl) {
        const events = body.webhookEvents && body.webhookEvents.length > 0
          ? body.webhookEvents
          : [...DEFAULT_WEBHOOK_EVENTS];
        const webhookSecret = randomBytes(32).toString("hex");

        try {
          const [wh] = await db`
            INSERT INTO agent_webhooks (agent_id, url, secret, events)
            VALUES (${body.agentId}, ${body.webhookUrl}, ${webhookSecret}, ${events})
            RETURNING id, url, events, active, created_at
          `;
          webhook = { ...(wh as Record<string, unknown>), secret: webhookSecret };
        } catch (whErr) {
          // Log but don't fail registration — webhook creation is best-effort
          app.log.warn({ err: whErr }, "Failed to auto-create webhook during registration");
        }
      }

      return reply.code(201).send({
        agentId: body.agentId,
        apiKey,
        ...(webhook ? { webhook } : {}),
      });
    }
  );

  // Verify — check if API key is valid
  app.get(
    "/api/auth/verify",
    { preHandler: app.authenticate },
    async (request) => {
      return { valid: true, agentId: request.agentId };
    }
  );

  // Revoke — invalidate current key
  app.post(
    "/api/auth/revoke",
    { preHandler: app.authenticate },
    async (request) => {
      const apiKeyHash = request.apiKeyHash;
      if (!apiKeyHash) return { revoked: false };

      const cached = memoryCredentials.get(apiKeyHash);
      if (cached) cached.revokedAt = new Date();

      try {
        await db`UPDATE agent_credentials SET revoked_at = NOW() WHERE api_key_hash = ${apiKeyHash}`;
      } catch {
        // best effort
      }

      return { revoked: true };
    }
  );

  // Rotate — revoke old key, issue new one
  app.post(
    "/api/auth/rotate-key",
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => request.headers['x-api-key'] as string || request.ip
        }
      }
    },
    async (request, reply) => {
      const oldHash = request.apiKeyHash;
      const agentId = request.agentId;
      if (!oldHash || !agentId) return reply.code(401).send({ error: "Missing credentials" });

      // Revoke old
      const cached = memoryCredentials.get(oldHash);
      if (cached) cached.revokedAt = new Date();
      memoryCredentials.delete(oldHash);

      // Generate new
      const newApiKey = randomBytes(32).toString("hex");
      const newHash = hashApiKey(newApiKey);

      try {
        await db`
          UPDATE agent_credentials
          SET api_key_hash = ${newHash}, revoked_at = NULL, created_at = NOW()
          WHERE agent_id = ${agentId}
        `;
      } catch {
        return reply.code(500).send({ error: "Key rotation failed" });
      }

      memoryCredentials.set(newHash, {
        agentId,
        walletAddress: cached?.walletAddress ?? "",
        apiKeyHash: newHash,
        revokedAt: null,
        lastUsedAt: new Date()
      });

      return reply.code(200).send({ apiKey: newApiKey, agentId });
    }
  );
}
