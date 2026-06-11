import type { RuntimeConfig } from "./config.js";

export async function sendHeartbeat(input: {
  config: RuntimeConfig;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
}): Promise<void> {
  const fetchFn = input.fetchFn ?? fetch;
  const response = await fetchFn(`${input.config.apiUrl}/api/agents/${input.config.agentId}/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.config.apiKey,
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`POST /api/agents/${input.config.agentId}/heartbeat failed with ${response.status}`);
  }
  if (input.config.flags.verbose) {
    input.log?.("[agentpact-daemon] heartbeat sent");
  }
}
