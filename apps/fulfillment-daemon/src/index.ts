#!/usr/bin/env node

import { homedir } from "node:os";

import { createApiClient } from "./api-client.js";
import { loadConfig } from "./config.js";
import { createNotifier } from "./notifier.js";
import { runTick } from "./loop.js";
import { runSelfCheck } from "./self-check.js";
import { loadState, saveState } from "./state.js";

export async function main(env = process.env): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("self-check") || argv.includes("--self-check")) {
    const config = loadConfig({ env, homeDir: homedir() });
    const results = await runSelfCheck({ config });
    if (results.some((r) => !r.ok)) {
      process.exitCode = 1;
    }
    return;
  }

  const config = loadConfig({ env, homeDir: homedir() });
  const log = (message: string) => console.log(message);

  log(
    JSON.stringify({
      ts: new Date().toISOString(),
      daemon: "fulfillment-daemon",
      event: "start",
      apiUrl: config.apiUrl,
      tickSeconds: config.tickSeconds,
      dryRun: config.dryRun,
    })
  );

  const apiClient = createApiClient({
    apiUrl: config.apiUrl,
    adminApiKey: config.adminApiKey,
  });

  const notifier = createNotifier({
    webhookUrl: config.discordWebhookUrl,
    dryRun: config.dryRun,
    log,
  });

  let state = loadState(config.stateFilePath);
  let tickN = 0;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const result = await runTick({ apiClient, config, state, tickN: ++tickN, log });
      state = result.state;
      state = { ...state, lastTickAt: new Date().toISOString() };
      saveState(config.stateFilePath, state);

      if (result.processed > 0 || result.failed > 0) {
        await notifier.postDiscord({
          content: `fulfillment-daemon tick=${tickN} — processed=${result.processed} failed=${result.failed} skipped=${result.skipped}`,
        });
      }
    } catch (error) {
      log(
        `[fulfillment-daemon] tick error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      running = false;
    }
  }

  await tick();

  const timer = setInterval(() => {
    void tick();
  }, config.tickSeconds * 1000);
  timer.unref();

  const handleSignal = (signal: NodeJS.Signals) => {
    console.log(`[fulfillment-daemon] received ${signal}, shutting down`);
    clearInterval(timer);
    saveState(config.stateFilePath, state);
    process.exit(0);
  };

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(
      `[fulfillment-daemon] fatal: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  });
}
