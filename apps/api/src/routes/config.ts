/**
 * Public chain-config endpoint.
 *
 * escrow-safety rollout — SDK-address-match sub-acceptance: agents need a way to discover
 * the canonical escrow + USDC addresses the API is currently configured against,
 * so SDKs can self-verify they're transacting with the same contract the platform
 * accepts. Hardcoded constants in the SDK go stale every time the contract is
 * redeployed; pulling from the API at runtime fixes that.
 *
 * No authentication — chain addresses are public information by design (anyone
 * can grep them on BaseScan). Rate limiting via the global fastify rate-limit
 * plugin is sufficient.
 */
import type { FastifyInstance } from "fastify";
import { ESCROW_ADDRESS, USDC_ADDRESS } from "../chain.js";

const CHAIN_ID = 8453; // Base mainnet
const NETWORK_NAME = "base";

export default async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/config/addresses", async (_request, reply) => {
    return reply.code(200).send({
      chainId: CHAIN_ID,
      network: NETWORK_NAME,
      escrow: ESCROW_ADDRESS,
      usdc: USDC_ADDRESS,
    });
  });
}
