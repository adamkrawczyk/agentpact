import fastifyJWT from "@fastify/jwt";
import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev_secret_change_in_production";
const registerSchema = z.object({
    agentId: z.string().uuid(),
    walletAddress: z.string().min(4)
});
/**
 * SHA-256 hash for API keys. API keys are 32 random bytes (256 bits of entropy),
 * so SHA-256 is perfectly safe — this isn't a password, it's a random token.
 * Using SHA-256 allows O(1) DB lookups instead of scanning all credentials with bcrypt.
 */
function hashApiKey(apiKey) {
    return createHash("sha256").update(apiKey).digest("hex");
}
const memoryCredentials = new Map();
export async function initAuth(app, injectedDb) {
    const db = injectedDb ?? postgres(DATABASE_URL, { max: 3 });
    await app.register(fastifyJWT, { secret: JWT_SECRET });
    app.decorate("authenticate", async (request, reply) => {
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
            const rows = await db `
        SELECT agent_id, wallet_address, api_key_hash
        FROM agent_credentials
        WHERE api_key_hash = ${apiKeyHash} AND revoked_at IS NULL
      `;
            if (rows.length === 0) {
                return reply.code(401).send({ error: "Invalid API key" });
            }
            const credential = rows[0];
            request.agentId = credential.agent_id;
            request.apiKeyHash = apiKeyHash;
            memoryCredentials.set(apiKeyHash, {
                agentId: credential.agent_id,
                walletAddress: credential.wallet_address,
                apiKeyHash: apiKeyHash,
                revokedAt: null,
                lastUsedAt: new Date()
            });
        }
        catch {
            return reply.code(401).send({ error: "Invalid API key" });
        }
    });
    // Register endpoint — public, creates API key for an agent
    app.post("/api/auth/register", {
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
                keyGenerator: (request) => request.ip
            }
        }
    }, async (request, reply) => {
        const body = registerSchema.parse(request.body);
        const apiKey = randomBytes(32).toString("hex");
        const apiKeyHash = hashApiKey(apiKey);
        try {
            // Auto-create agent if it doesn't exist (agents table FK required)
            await db `
          INSERT INTO agents (id, handle, display_name, owner_wallet_address, wallet_provider)
          VALUES (${body.agentId}, ${'agent-' + body.agentId}, ${'Agent ' + body.agentId.slice(0, 8)}, ${body.walletAddress}, 'metamask')
          ON CONFLICT (id) DO NOTHING
        `;
            await db `
          INSERT INTO agent_credentials (agent_id, wallet_address, api_key_hash)
          VALUES (${body.agentId}, ${body.walletAddress}, ${apiKeyHash})
          ON CONFLICT (agent_id) DO UPDATE
            SET api_key_hash = EXCLUDED.api_key_hash,
                wallet_address = EXCLUDED.wallet_address,
                revoked_at = NULL,
                created_at = NOW()
        `;
        }
        catch {
            return reply.code(500).send({ error: "Registration failed" });
        }
        memoryCredentials.set(apiKeyHash, {
            agentId: body.agentId,
            walletAddress: body.walletAddress,
            apiKeyHash,
            revokedAt: null,
            lastUsedAt: new Date()
        });
        return reply.code(201).send({ agentId: body.agentId, apiKey });
    });
    // Verify — check if API key is valid
    app.get("/api/auth/verify", { preHandler: app.authenticate }, async (request) => {
        return { valid: true, agentId: request.agentId };
    });
    // Revoke — invalidate current key
    app.post("/api/auth/revoke", { preHandler: app.authenticate }, async (request) => {
        const apiKeyHash = request.apiKeyHash;
        if (!apiKeyHash)
            return { revoked: false };
        const cached = memoryCredentials.get(apiKeyHash);
        if (cached)
            cached.revokedAt = new Date();
        try {
            await db `UPDATE agent_credentials SET revoked_at = NOW() WHERE api_key_hash = ${apiKeyHash}`;
        }
        catch {
            // best effort
        }
        return { revoked: true };
    });
    // Rotate — revoke old key, issue new one
    app.post("/api/auth/rotate-key", {
        preHandler: app.authenticate,
        config: {
            rateLimit: {
                max: 3,
                timeWindow: '1 minute',
                keyGenerator: (request) => request.headers['x-api-key'] || request.ip
            }
        }
    }, async (request, reply) => {
        const oldHash = request.apiKeyHash;
        const agentId = request.agentId;
        if (!oldHash || !agentId)
            return reply.code(401).send({ error: "Missing credentials" });
        // Revoke old
        const cached = memoryCredentials.get(oldHash);
        if (cached)
            cached.revokedAt = new Date();
        memoryCredentials.delete(oldHash);
        // Generate new
        const newApiKey = randomBytes(32).toString("hex");
        const newHash = hashApiKey(newApiKey);
        try {
            await db `
          UPDATE agent_credentials
          SET api_key_hash = ${newHash}, revoked_at = NULL, created_at = NOW()
          WHERE agent_id = ${agentId}
        `;
        }
        catch {
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
    });
}
