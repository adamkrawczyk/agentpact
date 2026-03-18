export function createNotifier(input) {
    const log = input.log ?? console.log;
    const postJson = input.postJson ?? (async (url, body) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`Webhook POST failed with ${response.status}`);
        }
    });
    const runCommand = input.runCommand ?? (async (command, args) => {
        const { spawn } = await import("node:child_process");
        await new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: "ignore" });
            child.once("error", reject);
            child.once("exit", (code) => {
                if (code === 0)
                    resolve();
                else
                    reject(new Error(`${command} exited with code ${code ?? 1}`));
            });
        });
    });
    async function fanOut(match, event, dealId) {
        const payload = {
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
                log("[agentpact-daemon] dry-run enabled, skipping webhook and OpenClaw side effects");
            }
            return;
        }
        if (input.webhookUrl) {
            await postJson(input.webhookUrl, payload);
        }
        try {
            await runCommand("openclaw", ["system", "event", "--text", `AgentPact match: ${match.summary}`]);
        }
        catch (error) {
            if (input.verbose) {
                log(`[agentpact-daemon] OpenClaw notification failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    return {
        async notifyNewMatches(matches) {
            for (const match of matches) {
                await fanOut(match, "daemon.match.detected");
            }
        },
        async notifyAutopilotDeal(match, dealId) {
            await fanOut(match, "daemon.match.autopilot", dealId);
        },
    };
}
