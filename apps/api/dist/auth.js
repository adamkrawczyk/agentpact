import fastifyJWT from "@fastify/jwt";
import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { z } from "zod";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agentpact";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev_secret_change_in_production";
const registerSchema = z.object({
    agentId: z.string().uuid(),
    walletAddress: z.string().min(4)
});
function hashApiKey(apiKey) {
    return bcrypt.hashSync(apiKey, 10);
}
function hashApiKeyLegacy(apiKey) {
    return createHash("sha256").update(apiKey).digest("hex");
}
async function verifyApiKey(apiKey, storedHash) {
    // Try bcrypt first (new format)
    try {
        if (storedHash.startsWith("$2")) {
            return bcrypt.compareSync(apiKey, storedHash);
        }
    }
    catch {
        // Not a bcrypt hash, fall through
    }
    // Fallback: legacy SHA-256 comparison
    const legacyHash = hashApiKeyLegacy(apiKey);
    return legacyHash === storedHash;
}
export async function initAuth(app, options) {
    const db = options?.sql ?? postgres(DATABASE_URL);
    const ownsDbConnection = !options?.sql;
    const memoryCredentials = new Map();
    await app.register(fastifyJWT, {
        secret: JWT_SECRET
    });
    app.decorate("authenticate", async function authenticate(request, reply) {
        const rawApiKey = request.headers["x-api-key"];
        if (typeof rawApiKey !== "string" || rawApiKey.length === 0) {
            reply.code(401).send({ error: "Missing API key" });
            return;
        }
        // Check in-memory cache first (keyed by legacy hash for fast lookup)
        const legacyHash = hashApiKeyLegacy(rawApiKey);
        for (const [storedHash, cached] of memoryCredentials) {
            if (cached.revokedAt)
                continue;
            const match = await verifyApiKey(rawApiKey, storedHash);
            if (match) {
                cached.lastUsedAt = new Date();
                request.agentId = cached.agentId;
                request.apiKeyHash = storedHash;
                return;
            }
        }
        try {
            // Try bcrypt hashes first
            const allRows = await db `
        SELECT agent_id, wallet_address, api_key_hash
        FROM agent_credentials
        WHERE revoked_at IS NULL
      `;
            for (const row of allRows) {
                const credential = row;
                const match = await verifyApiKey(rawApiKey, credential.api_key_hash);
                if (match) {
                    // If it was a legacy SHA-256 hash, rehash with bcrypt and update DB
                    if (!credential.api_key_hash.startsWith("$2")) {
                        const newHash = hashApiKey(rawApiKey);
                        try {
                            await db `
                UPDATE agent_credentials
                SET api_key_hash = ${newHash}
                WHERE api_key_hash = ${credential.api_key_hash}
              `;
                            credential.api_key_hash = newHash;
                        }
                        catch {
                            app.log.warn("Failed to upgrade API key hash to bcrypt");
                        }
                    }
                    request.agentId = credential.agent_id;
                    request.apiKeyHash = credential.api_key_hash;
                    memoryCredentials.set(credential.api_key_hash, {
                        agentId: credential.agent_id,
                        walletAddress: credential.wallet_address,
                        apiKeyHash: credential.api_key_hash,
                        revokedAt: null,
                        lastUsedAt: new Date()
                    });
                    return;
                }
            }
            reply.code(401).send({ error: "Invalid API key" });
        }
        catch {
            reply.code(401).send({ error: "Invalid API key" });
        }
    });
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
        memoryCredentials.set(apiKeyHash, {
            agentId: body.agentId,
            walletAddress: body.walletAddress,
            apiKeyHash,
            revokedAt: null,
            lastUsedAt: null
        });
        try {
            await db `
        INSERT INTO agent_credentials (agent_id, wallet_address, api_key_hash)
        VALUES (${body.agentId}, ${body.walletAddress}, ${apiKeyHash})
        ON CONFLICT (agent_id) DO UPDATE
          SET api_key_hash = EXCLUDED.api_key_hash,
              wallet_address = EXCLUDED.wallet_address,
              created_at = NOW(),
              revoked_at = NULL
      `;
        }
        catch {
            app.log.warn("agent_credentials table unavailable or agent missing; using in-memory auth record");
        }
        reply.code(200).send({ apiKey, agentId: body.agentId });
    });
    app.get("/api/auth/verify", {
        preHandler: app.authenticate
    }, async (request) => {
        return {
            agentId: request.agentId,
            authenticated: true
        };
    });
    app.post("/api/auth/revoke", {
        preHandler: app.authenticate
    }, async (request) => {
        const apiKeyHash = request.apiKeyHash;
        if (!apiKeyHash) {
            return { revoked: false };
        }
        const cached = memoryCredentials.get(apiKeyHash);
        if (cached) {
            cached.revokedAt = new Date();
        }
        try {
            await db `
          UPDATE agent_credentials
          SET revoked_at = NOW()
          WHERE api_key_hash = ${apiKeyHash}
        `;
        }
        catch {
            app.log.warn("Unable to persist credential revocation");
        }
        return { revoked: true };
    });
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
        const oldApiKeyHash = request.apiKeyHash;
        const agentId = request.agentId;
        if (!oldApiKeyHash || !agentId) {
            return reply.code(401).send({ error: "Missing credentials" });
        }
        // Revoke old key
        const cached = memoryCredentials.get(oldApiKeyHash);
        if (cached) {
            cached.revokedAt = new Date();
        }
        // Generate new key
        const newApiKey = randomBytes(32).toString("hex");
        const newApiKeyHash = hashApiKey(newApiKey);
        try {
            await db `
          UPDATE agent_credentials
          SET api_key_hash = ${newApiKeyHash}, revoked_at = NULL, created_at = NOW()
          WHERE agent_id = ${agentId}
        `;
        }
        catch {
            app.log.warn("Unable to persist key rotation");
        }
        memoryCredentials.delete(oldApiKeyHash);
        memoryCredentials.set(newApiKeyHash, {
            agentId,
            walletAddress: cached?.walletAddress ?? "",
            apiKeyHash: newApiKeyHash,
            revokedAt: null,
            lastUsedAt: new Date()
        });
        return reply.code(200).send({ apiKey: newApiKey, agentId });
    });
    if (ownsDbConnection && typeof db.end === "function") {
        app.addHook("onClose", async () => {
            await db.end?.({ timeout: 5 });
        });
    }
}
