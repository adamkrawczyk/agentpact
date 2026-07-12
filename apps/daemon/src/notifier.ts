import type { MarketMatch } from "./watcher.js";

type NotificationPayload = {
  event: "daemon.match.detected" | "daemon.match.autopilot";
  summary: string;
  score: number;
  offerId: string;
  needId: string;
  offerAgentId: string;
  needAgentId: string;
  offerTitle: string;
  needTitle: string;
  category?: string;
  price: number;
  dealId?: string;
};

type RunCommand = (command: string, args: string[]) => Promise<void>;
type PostJson = (url: string, body: NotificationPayload) => Promise<void>;

export function createNotifier(input: {
  webhookUrl?: string;
  notifyCommand?: string;
  dryRun: boolean;
  verbose: boolean;
  log?: (message: string) => void;
  postJson?: PostJson;
  runCommand?: RunCommand;
}) {
  const log = input.log ?? console.log;
  const postJson: PostJson = input.postJson ?? (async (url, body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Webhook POST failed with ${response.status}`);
    }
  });
  const runCommand: RunCommand = input.runCommand ?? (async (command, args) => {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} exited with code ${code ?? 1}`));
      });
    });
  });

  async function fanOut(match: MarketMatch, event: NotificationPayload["event"], dealId?: string) {
    const payload: NotificationPayload = {
      event,
      summary: match.summary,
      score: match.score,
      offerId: match.offerId,
      needId: match.needId,
      offerAgentId: match.offerAgentId,
      needAgentId: match.needAgentId,
      offerTitle: match.offerTitle,
      needTitle: match.needTitle,
      category: match.category,
      price: match.price,
      dealId,
    };

    log(`[agentpact-daemon] ${event} ${match.summary}`);

    if (input.dryRun) {
      if (input.verbose) {
        log("[agentpact-daemon] dry-run enabled, skipping webhook and command side effects");
      }
      return;
    }

    if (input.webhookUrl) {
      await postJson(input.webhookUrl, payload);
    }

    // Optional shell-command notification. Set NOTIFY_COMMAND to a CLI that
    // accepts: <command> system event --text "<message>" (e.g. a desktop
    // notifier, a chat-bridge CLI, or any custom hook). Left unset, the
    // daemon notifies via webhook only.
    if (input.notifyCommand) {
      try {
        await runCommand(input.notifyCommand, ["system", "event", "--text", `AgentPact match: ${match.summary}`]);
      } catch (error) {
        if (input.verbose) {
          log(`[agentpact-daemon] command notification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  return {
    async notifyNewMatches(matches: MarketMatch[]) {
      for (const match of matches) {
        await fanOut(match, "daemon.match.detected");
      }
    },
    async notifyAutopilotDeal(match: MarketMatch, dealId: string) {
      await fanOut(match, "daemon.match.autopilot", dealId);
    },
  };
}
