type PostJson = (url: string, payload: unknown) => Promise<void>;

export function createNotifier(input: {
  webhookUrl?: string;
  dryRun: boolean;
  log?: (message: string) => void;
  postJson?: PostJson;
}) {
  const log = input.log ?? console.log;
  const postJson: PostJson =
    input.postJson ??
    (async (url, body) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Discord webhook POST failed with ${response.status}`);
      }
    });

  async function postDiscord(payload: unknown): Promise<void> {
    if (!input.webhookUrl) return;
    if (input.dryRun) {
      log(`[fulfillment-daemon] dry-run: skipping Discord notification`);
      return;
    }
    try {
      await postJson(input.webhookUrl, payload);
    } catch (error) {
      log(
        `[fulfillment-daemon] Discord notify failed (non-fatal): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return { postDiscord };
}

export type Notifier = ReturnType<typeof createNotifier>;
