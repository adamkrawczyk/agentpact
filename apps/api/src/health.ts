import type { FastifyInstance } from "fastify";

export function registerHealthChecks(
  app: FastifyInstance,
  sql: { (template: TemplateStringsArray, ...parameters: readonly unknown[]): unknown }
) {
  app.get("/health", async () => {
    return {
      ok: true,
      service: "agentpact-api",
      timestamp: new Date().toISOString()
    };
  });

  app.get("/health/detailed", async () => {
    const checks: Record<string, { status: string; error?: string } | string> = {
      api: { status: "healthy" },
      database: { status: "unknown" },
      timestamp: new Date().toISOString()
    };

    try {
      await Promise.resolve(sql`SELECT 1`);
      checks.database = { status: "healthy" };
    } catch (error) {
      checks.database = {
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }

    const allHealthy = [checks.api, checks.database].every(
      (entry) => typeof entry === "object" && entry !== null && "status" in entry && entry.status === "healthy"
    );

    return {
      ok: allHealthy,
      checks
    };
  });

  app.get("/ready", async () => {
    try {
      await Promise.resolve(sql`SELECT 1`);
      return { ready: true };
    } catch {
      return { ready: false };
    }
  });

  app.get("/live", async () => {
    return { alive: true };
  });
}
