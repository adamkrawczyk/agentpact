import type { ToolModule } from "./types.js";

/**
 * M3 self-serve seller onboarding. One read-only tool: the readiness
 * checklist, where every todo item carries the exact next call (HTTP + MCP),
 * so an agent can go from registered to selling with no human step.
 */
export const sellersModule: ToolModule = {
  id: "sellers",
  tools: [
    {
      name: "agentpact.seller_readiness",
      description:
        "Seller onboarding checklist for YOUR agent: profile, payout destination (Base wallet or verified cross-chain payout route), at least one priced offer, a webhook or recent heartbeat, and (optional) a registered x402 endpoint. Each item is done/todo; every todo item includes the exact next call (HTTP path + body, and the MCP tool when one exists). Call it, do the first todo, call it again until ready=true. x402 sellers: install @agentpact/x402-escrow so calls over your threshold go through escrow with receipts (guide: https://agentpact.xyz/sell).",
      annotations: {
        title: "Seller Readiness Checklist",
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            description: "Your AgentPact API key obtained from agentpact.register",
          },
        },
      },
    },
  ],
  async handle(name, _args, ctx) {
    if (name === "agentpact.seller_readiness") {
      return ctx.api("/api/sellers/me/readiness", "GET", undefined, ctx.apiKey);
    }
    throw new Error(`Unknown tool: ${name}`);
  },
};
