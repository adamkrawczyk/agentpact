import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyJWT from "@fastify/jwt";
import fastifyRateLimit from "@fastify/rate-limit";
import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev_secret_change_in_production";
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 100);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000);

const registerSchema = z.object({
  agentId: z.string().uuid(),
  walletAddress: z.string().min(4)
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

function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export async function initAuth(
  app: FastifyInstance,
  options?: { sql?: AuthSqlClient; rateLimitMax?: number; rateLimitWindowMs?: number }
) {
  const db: AuthSqlClient = options?.sql ?? (postgres(DATABASE_URL) as unknown as AuthSqlClient);
  const ownsDbConnection = !options?.sql;
  const memoryCredentials = new Map<string, CredentialRecord>();
  const rateLimitMax = options?.rateLimitMax ?? RATE_LIMIT_MAX;
  const rateLimitWindowMs = options?.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;

  await app.register(fastifyJWT, {
    secret: JWT_SECRET
  });

  await app.register(fastifyRateLimit, {
    max: rateLimitMax,
    timeWindow: rateLimitWindowMs,
    keyGenerator: (request: FastifyRequest) => {
      const apiKey = request.headers["x-api-key"];
      if (typeof apiKey === "string" && apiKey.length > 0) {
        return hashApiKey(apiKey);
      }
      return request.ip;
    }
  });

  app.decorate("authenticate", async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const rawApiKey = request.headers["x-api-key"];
    if (typeof rawApiKey !== "string" || rawApiKey.length === 0) {
      reply.code(401).send({ error: "Missing API key" });
      return;
    }

    const apiKeyHash = hashApiKey(rawApiKey);
    const cached = memoryCredentials.get(apiKeyHash);
    if (cached && !cached.revokedAt) {
      cached.lastUsedAt = new Date();
      request.agentId = cached.agentId;
      request.apiKeyHash = apiKeyHash;
      return;
    }

    try {
      const rows = await db`
        SELECT agent_id, wallet_address
        FROM agent_credentials
        WHERE api_key_hash = ${apiKeyHash}
          AND revoked_at IS NULL
      `;
      const credential = rows[0] as { agent_id: string; wallet_address: string } | undefined;

      if (!credential) {
        reply.code(401).send({ error: "Invalid API key" });
        return;
      }

      request.agentId = credential.agent_id;
      request.apiKeyHash = apiKeyHash;
      memoryCredentials.set(apiKeyHash, {
        agentId: credential.agent_id,
        walletAddress: credential.wallet_address,
        apiKeyHash,
        revokedAt: null,
        lastUsedAt: new Date()
      });
    } catch {
      reply.code(401).send({ error: "Invalid API key" });
    }
  });

  app.post("/api/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const apiKey = randomBytes(32).toString("hex");
    const apiKeyHash = hashApiKey(apiKey);

    memoryCredentials.set(apiKeyHash, {
      agentId: body.agentId,
      walletAddress: body.walletAddress,
      apiKeyHash,
      revokedAt: null,
      lastUsedAt: null
    });

    try {
      await db`
        INSERT INTO agent_credentials (agent_id, wallet_address, api_key_hash)
        VALUES (${body.agentId}, ${body.walletAddress}, ${apiKeyHash})
        ON CONFLICT (agent_id) DO UPDATE
          SET api_key_hash = EXCLUDED.api_key_hash,
              wallet_address = EXCLUDED.wallet_address,
              created_at = NOW(),
              revoked_at = NULL
      `;
    } catch {
      app.log.warn("agent_credentials table unavailable or agent missing; using in-memory auth record");
    }

    reply.code(200).send({ apiKey, agentId: body.agentId });
  });

  app.get(
    "/api/auth/verify",
    {
      preHandler: app.authenticate
    },
    async (request) => {
      return {
        agentId: request.agentId,
        authenticated: true
      };
    }
  );

  app.post(
    "/api/auth/revoke",
    {
      preHandler: app.authenticate
    },
    async (request) => {
      const apiKeyHash = request.apiKeyHash;
      if (!apiKeyHash) {
        return { revoked: false };
      }

      const cached = memoryCredentials.get(apiKeyHash);
      if (cached) {
        cached.revokedAt = new Date();
      }

      try {
        await db`
          UPDATE agent_credentials
          SET revoked_at = NOW()
          WHERE api_key_hash = ${apiKeyHash}
        `;
      } catch {
        app.log.warn("Unable to persist credential revocation");
      }

      return { revoked: true };
    }
  );

  if (ownsDbConnection && typeof db.end === "function") {
    app.addHook("onClose", async () => {
      await db.end?.({ timeout: 5 });
    });
  }
}
