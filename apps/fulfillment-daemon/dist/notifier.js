export function createNotifier(input) {
    const log = input.log ?? console.log;
    const postJson = input.postJson ??
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
    async function postDiscord(payload) {
        if (!input.webhookUrl)
            return;
        if (input.dryRun) {
            log(`[fulfillment-daemon] dry-run: skipping Discord notification`);
            return;
        }
        try {
            await postJson(input.webhookUrl, payload);
        }
        catch (error) {
            log(`[fulfillment-daemon] Discord notify failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { postDiscord };
}
