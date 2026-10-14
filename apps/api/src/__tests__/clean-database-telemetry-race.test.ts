import { describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp } from "./helpers/testApp.js";

// Test-infra regression (surfaced as 2 random `cleanDatabase()` failures in the
// combined #171+#172 run — needs, verified-seller-ranking — and again in
// offers.test.ts on a fresh isolated database).
//
// The in-process telemetry flusher (plugins/telemetry.ts, 2 s timer) runs
//   INSERT INTO api_usage … LEFT JOIN agents … (SELECT … FROM agent_credentials)
// i.e. it locks api_usage first, then agents and agent_credentials. The old
// cleanDatabase() TRUNCATE listed agent_credentials/agents BEFORE api_usage, so
// the two could wait on each other and Postgres aborted one with
// `deadlock detected` (40P01) — occasionally the TRUNCATE, which failed whichever
// test hook called it. The window is microseconds wide in real life, so this
// test builds the interleaving deterministically.

describe("cleanDatabase() vs the telemetry flusher's lock order", () => {
  it("does not deadlock with a writer that holds api_usage and then wants agents", async () => {
    const { sql } = await createTestApp();

    let cleanError: unknown = null;
    let clean: Promise<void> = Promise.resolve();

    // "Writer": takes api_usage first, exactly like the telemetry INSERT.
    const writerOutcome = await sql
      .begin(async (tx) => {
        await tx`LOCK TABLE api_usage IN ROW EXCLUSIVE MODE`;

        clean = cleanDatabase().catch((err) => {
          cleanError = err;
        });

        // Wait until cleanDatabase() is queued behind us on a lock (the old
        // TRUNCATE would by now already hold agents / agent_credentials).
        const deadline = Date.now() + 5_000;
        for (;;) {
          const [{ n }] = await sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND query ~* '^\s*(TRUNCATE|LOCK TABLE)'
              AND pid <> pg_backend_pid()
              AND query !~* 'pg_stat_activity'`;
          if (n > 0 || Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 25));
        }

        // …then the writer needs the tables the INSERT joins.
        await tx`SELECT count(*) FROM agents`;
        await tx`SELECT count(*) FROM agent_credentials`;
        return "writer-committed" as const;
      })
      .catch((err: { code?: string }) => (err.code === "40P01" ? ("writer-deadlock-victim" as const) : Promise.reject(err)));

    await clean;

    expect(cleanError, `cleanDatabase() failed: ${(cleanError as Error | null)?.message}`).toBeNull();
    // The writer must also get through; it is the cleaner that used to lose only
    // sometimes, but a victim on either side means the lock orders still clash.
    expect(writerOutcome).toBe("writer-committed");
  }, 60_000);
});
