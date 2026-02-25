import { createWalletClient, createPublicClient, http, parseUnits, formatUnits, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Hex, Address } from "viem";

const PLATFORM_KEY = process.env.PLATFORM_PRIVATE_KEY as Hex;
const ESCROW_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS as Address;
const USDC_ADDRESS = (process.env.USDC_CONTRACT_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;
const RPC_URL = process.env.BASE_RPC_URL ?? process.env.RPC_URL ?? "https://mainnet.base.org";
const API_URL = "https://api.agentpact.xyz";

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const ESCROW_ABI = [
  { name: "createMilestone", type: "function", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }, { name: "milestoneId", type: "bytes32" }, { name: "seller", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { name: "acceptMilestone", type: "function", stateMutability: "nonpayable", inputs: [{ name: "milestoneId", type: "bytes32" }], outputs: [] },
  { name: "milestones", type: "function", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "dealId", type: "bytes32" }, { name: "buyer", type: "address" }, { name: "seller", type: "address" }, { name: "amount", type: "uint256" }, { name: "status", type: "uint8" }, { name: "createdAt", type: "uint256" }] },
  { name: "platformFeePercent", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "platformWallet", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

function uuidToBytes32(uuid: string): Hex {
  return `0x${uuid.replace(/-/g, "").padStart(64, "0")}` as Hex;
}

async function api(method: string, path: string, body?: any, apiKey?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const platformAccount = privateKeyToAccount(PLATFORM_KEY);
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const platformWallet = createWalletClient({ account: platformAccount, chain: base, transport: http(RPC_URL) });

  // Generate a fresh seller wallet (just need an address — seller doesn't sign anything for receive)
  const sellerKey = generatePrivateKey();
  const sellerAccount = privateKeyToAccount(sellerKey);
  console.log("🔑 Platform (buyer):", platformAccount.address);
  console.log("🔑 Seller wallet:", sellerAccount.address);
  console.log("🔑 Seller private key:", sellerKey, "(save this!)");

  const balanceBefore = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [platformAccount.address] });
  console.log("💰 Platform USDC before:", formatUnits(balanceBefore, 6));

  const feePct = await publicClient.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "platformFeePercent" });
  const configuredPlatformWallet = await publicClient.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "platformWallet" });
  console.log(`📋 Escrow: fee=${feePct}%, platformWallet=${configuredPlatformWallet}`);

  // Register fresh agents
  const crypto = await import("crypto");
  const buyerId = crypto.randomUUID();
  const sellerId = crypto.randomUUID();

  const buyerReg = await api("POST", "/api/auth/register", { agentId: buyerId, walletAddress: platformAccount.address });
  const sellerReg = await api("POST", "/api/auth/register", { agentId: sellerId, walletAddress: sellerAccount.address });
  console.log(`\n✅ Buyer: ${buyerId} key=${buyerReg.apiKey.slice(0,8)}...`);
  console.log(`✅ Seller: ${sellerId} key=${sellerReg.apiKey.slice(0,8)}...`);

  // Create deal
  console.log("\n=== Creating deal ===");
  const offer = await api("POST", "/api/offers", {
    agentId: sellerId, title: "On-Chain Test: 1 USDC Service",
    descriptionMd: "Testing full escrow flow with real USDC on Base",
    category: "consulting", tags: ["test", "onchain"],
    currency: "USDC", basePrice: 1, maxPriceDeltaPct: 0, fulfillmentType: "generic",
  }, sellerReg.apiKey);

  const need = await api("POST", "/api/needs", {
    agentId: buyerId, title: "Need on-chain test service",
    descriptionMd: "Testing escrow", category: "consulting",
    tags: ["test", "onchain"], currency: "USDC", budgetMax: 2, fulfillmentType: "generic",
  }, buyerReg.apiKey);

  const deal = await api("POST", "/api/deals/propose", {
    buyerAgentId: buyerId, sellerAgentId: sellerId,
    offerId: offer.id, needId: need.id,
    negotiatedTotal: 1, maxPriceDeltaPct: 0,
    milestones: [{ idx: 1, title: "Test service", amount: 1, acceptanceCriteria: ["Done"] }],
  }, buyerReg.apiKey);
  console.log("✅ Deal:", deal.id, "milestone:", deal.milestones[0].id);

  await api("POST", `/api/deals/${deal.id}/accept`, { actorAgentId: sellerId }, sellerReg.apiKey);
  console.log("✅ Accepted");

  // Verify status
  const dealCheck = await api("GET", `/api/deals/${deal.id}`);
  console.log("   Deal status:", dealCheck.status, "Milestone status:", dealCheck.milestones[0].status);

  // Create payment intent
  console.log("\n=== Funding on-chain ===");
  const intent = await api("POST", "/api/payments/create-intent", {
    milestoneId: deal.milestones[0].id, buyerAgentId: buyerId,
    walletProvider: "metamask", buyerWalletAddress: platformAccount.address, chain: "base",
  }, buyerReg.apiKey);
  console.log("✅ Intent:", intent.paymentIntentId, "mode:", intent.mode);

  // Approve USDC
  const amount = parseUnits("1", 6);
  const approveTx = await platformWallet.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [ESCROW_ADDRESS, amount],
  });
  console.log("📤 Approve:", approveTx);
  await publicClient.waitForTransactionReceipt({ hash: approveTx, confirmations: 2 });

  // Fund escrow
  const dealBytes = uuidToBytes32(deal.id);
  const msBytes = uuidToBytes32(deal.milestones[0].id);
  const fundTx = await platformWallet.writeContract({
    address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "createMilestone",
    args: [dealBytes, msBytes, sellerAccount.address, amount],
  });
  console.log("📤 Fund:", fundTx);
  await publicClient.waitForTransactionReceipt({ hash: fundTx, confirmations: 2 });
  console.log("✅ Funded on-chain");

  // Confirm funding
  await api("POST", "/api/payments/confirm-funding", {
    paymentIntentId: intent.paymentIntentId, txHash: fundTx, buyerAgentId: buyerId,
  }, buyerReg.apiKey);
  console.log("✅ Funding confirmed");

  // Deliver
  console.log("\n=== Deliver + Confirm ===");
  await api("POST", `/api/deals/${deal.id}/fulfillment`, {
    agentId: sellerId,
    fulfillmentData: { description: "Full on-chain test completed successfully. Escrow funded and released." },
  }, sellerReg.apiKey);
  console.log("✅ Delivered");

  // Confirm — this should trigger on-chain release!
  const result = await api("POST", `/api/deals/${deal.id}/confirm-delivery`, {
    agentId: buyerId, skipOnChainRelease: false,
  }, buyerReg.apiKey);
  console.log("✅ Confirmed! Status:", result.status);
  console.log("   Release:", JSON.stringify(result.release));

  // Check balances
  const balanceAfter = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [platformAccount.address] });
  const sellerBalance = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [sellerAccount.address] });
  console.log(`\n💰 Platform USDC after: ${formatUnits(balanceAfter, 6)} (before: ${formatUnits(balanceBefore, 6)})`);
  console.log(`💰 Seller USDC: ${formatUnits(sellerBalance, 6)}`);
  console.log(`💵 Platform fee (10%): ${formatUnits(balanceAfter - balanceBefore, 6)} USDC`);

  // Milestone state
  const msState = await publicClient.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "milestones", args: [msBytes] });
  const statusMap: Record<number, string> = { 0: "Funded", 1: "Accepted", 2: "Disputed", 3: "Resolved" };
  console.log(`📋 On-chain milestone status: ${statusMap[Number(msState[4])] ?? msState[4]}`);
}

main().catch(err => { console.error("❌ FAILED:", err.message); process.exit(1); });
