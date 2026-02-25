import { createWalletClient, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
const PLATFORM_KEY = process.env.PLATFORM_PRIVATE_KEY;
const ESCROW_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS;
const RPC_URL = process.env.BASE_RPC_URL ?? process.env.RPC_URL ?? "https://mainnet.base.org";
const ESCROW_ABI = [
    { name: "openDispute", type: "function", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "bytes32" }], outputs: [] },
    { name: "resolveDispute", type: "function", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "bytes32" }, { name: "refundBuyer", type: "bool" }], outputs: [] },
    { name: "milestones", type: "function", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "dealId", type: "bytes32" }, { name: "buyer", type: "address" }, { name: "seller", type: "address" }, { name: "amount", type: "uint256" }, { name: "status", type: "uint8" }, { name: "createdAt", type: "uint256" }] },
];
function uuidToBytes32(uuid) {
    return `0x${uuid.replace(/-/g, "").padStart(64, "0")}`;
}
async function main() {
    const account = privateKeyToAccount(PLATFORM_KEY);
    const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });
    const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
    const milestoneId = "361a11a3-cfc7-46a7-91bd-391da379f558";
    const msBytes = uuidToBytes32(milestoneId);
    console.log("Step 1: Open dispute (buyer = platform wallet)...");
    const disputeTx = await walletClient.writeContract({
        address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "openDispute", args: [msBytes],
    });
    console.log("Dispute tx:", disputeTx);
    await publicClient.waitForTransactionReceipt({ hash: disputeTx, confirmations: 2 });
    console.log("✅ Disputed");
    console.log("Step 2: Resolve dispute (refund to buyer)...");
    const refundTx = await walletClient.writeContract({
        address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "resolveDispute", args: [msBytes, true],
    });
    console.log("Refund tx:", refundTx);
    await publicClient.waitForTransactionReceipt({ hash: refundTx, confirmations: 2 });
    console.log("✅ Refunded 1 USDC back!");
}
main().catch(err => console.error("❌", err.message));
