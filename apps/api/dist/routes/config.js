import { ESCROW_ADDRESS, USDC_ADDRESS } from "../chain.js";
const CHAIN_ID = 8453; // Base mainnet
const NETWORK_NAME = "base";
export default async function configRoutes(app) {
    app.get("/api/config/addresses", async (_request, reply) => {
        return reply.code(200).send({
            chainId: CHAIN_ID,
            network: NETWORK_NAME,
            escrow: ESCROW_ADDRESS,
            usdc: USDC_ADDRESS,
        });
    });
}
