// deploy/ecosystem.config.cjs — canonical pm2 process definition for prod.
//
// deploy.yml copies this file to <app root>/ecosystem.config.cjs on every
// deploy and reloads from it. Edit it HERE; a hand edit on the box is
// overwritten by the next deploy.
//
// ── Why ap-api and ap-web run in CLUSTER mode (zero-downtime reload) ────────
// In fork mode `pm2 reload` is a plain restart: the old process exits, the
// port is closed while the new one runs its boot work, and the reverse proxy
// answers 502 for those seconds (~4 s per deploy, measured 2026-10). In
// cluster mode the pm2 daemon owns the listening socket and `pm2 reload`
// starts the new worker FIRST, waits for it, and only then stops the old one,
// so the port never closes.
//
//   wait_ready + listen_timeout: the new worker counts as up only once it
//     calls process.send('ready'), which the app does AFTER app.listen()
//     resolves (see notifyPm2Ready in apps/api/src/server.ts and
//     apps/web/src/index.ts). The API runs boot-time schema checks before it
//     listens, which can take several seconds; pm2's default listen_timeout
//     (3 s) would declare the worker up early and stop the old one too soon.
//   kill_timeout: the old worker gets SIGINT and drains in-flight requests
//     (app.close()) before exiting. pm2's default 1.6 s would SIGKILL long
//     requests (on-chain verification can take many seconds).
//   instances: 1. Neither app keeps per-process state that must be unique,
//     but one worker is what ran before; this change is about reload
//     behaviour, not capacity.
//
// ── Why ap-mcp and ap-relayer stay in FORK mode ─────────────────────────────
// ap-relayer is a singleton sweeper: two copies would race settlement work.
// It must stay a single fork-mode instance. Its entrypoint guard accepts
// pm2's pm_exec_path for that reason (apps/relayer-daemon entrypoint test).
// ap-mcp holds Streamable-HTTP sessions in process memory, so a reload drops
// them either way; moving it is a separate change.
//
// Runtime env comes from the shared env file (AGENTPACT_ENV_FILE overrides
// the default path, for local rehearsals).

const fs = require("fs");
const path = require("path");

const ENV_FILE = process.env.AGENTPACT_ENV_FILE || "/etc/agentpact/.env";
const base = process.env.AGENTPACT_APP_ROOT || path.resolve(__dirname, "..");

// Plain KEY=value parse, values taken verbatim (no quote stripping). The
// deploy step writes BUILD_SHA unquoted for this reason.
const shared = {};
for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) shared[m[1]] = m[2];
}

const fork = (name, rel, extra = {}) => ({
  name,
  cwd: base,
  script: path.join(base, rel),
  interpreter: "node",
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  env: { ...shared, ...extra },
});

const cluster = (name, rel, extra = {}) => ({
  ...fork(name, rel, extra),
  exec_mode: "cluster",
  instances: 1,
  wait_ready: true,
  listen_timeout: 60000,
  kill_timeout: 30000,
  // Without this, cluster mode suffixes log files with the pm2 id
  // (ap-api-out-4.log) and the id changes whenever the app is recreated.
  // Keep the fork-mode file names so log readers and runbooks keep working.
  merge_logs: true,
});

module.exports = {
  apps: [
    cluster("ap-api", "apps/api/dist/server.js", { RUN_MIGRATIONS: "false" }),
    cluster("ap-web", "apps/web/dist/index.js"),
    fork("ap-mcp", "apps/mcp/dist/index.js"),
    // Relayer uses the session-mode pooler port (:5432) rather than the
    // transaction pooler (:6543): through the transaction pooler a query
    // intermittently never returned and wedged its small pool. Long-lived
    // servers belong on session mode.
    fork("ap-relayer", "apps/relayer-daemon/dist/index.js", {
      DATABASE_URL: String(shared.DATABASE_URL).replace(":6543/", ":5432/"),
    }),
  ],
};
