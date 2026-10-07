import { buildServer } from "./server.js";
import type { EvmNetworkName } from "@agentpact/x402-escrow";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return v;
}

const app = await buildServer({
  sellerAgentId: required("AGENTPACT_AGENT_ID"),
  apiKey: required("AGENTPACT_API_KEY"),
  offerId: required("AGENTPACT_OFFER_ID"),
  payTo: required("PAY_TO"),
  network: (process.env.X402_NETWORK ?? "base-sepolia") as EvmNetworkName,
  pricePerCallUsd: process.env.PRICE_PER_CALL_USD ?? "0.02",
  thresholdUsd: process.env.ESCROW_THRESHOLD_USD ?? "1",
  facilitatorUrl: process.env.FACILITATOR_URL,
  apiBase: process.env.AGENTPACT_API_BASE,
  logger: true,
});

const port = Number(process.env.PORT ?? 4402);
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
