import { createWalletClient, createPublicClient, http, encodeFunctionData, parseUnits, formatUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, Address } from "viem";

// Load env
// env loaded via shell

const PLATFORM_KEY = process.env.PLATFORM_PRIVATE_KEY as Hex;
const ESCROW_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS as Address;
const USDC_ADDRESS = (process.env.USDC_CONTRACT_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;
const RPC_URL = process.env.BASE_RPC_URL ?? process.env.RPC_URL ?? "https://mainnet.base.org";
const API_URL = "https://api.agentpact.xyz";

const BUYER_KEY = process.env.TEST_BUYER_KEY!;
const BUYER_ID = process.env.TEST_BUYER_ID!;
const SELLER_KEY = process.env.TEST_SELLER_KEY!;
const SELLER_ID = process.env.TEST_SELLER_ID!;

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const ESCROW_ABI = [
  { name: "createMilestone", type: "function", stateMutability: "nonpayable", inputs: [{ name: "dealId", type: "bytes32" }, { name: "milestoneId", type: "bytes32" }, { name: "seller", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
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
  if (!res.ok) throw new Error(`API ${method} ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const account = privateKeyToAccount(PLATFORM_KEY);
  const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });

  console.log("🔑 Using wallet:", account.address);

  // Check USDC balance
  const balance = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log("💰 USDC balance:", formatUnits(balance, 6));

  // Check escrow contract config
  const feePct = await publicClient.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "platformFeePercent" });
  const platformWallet = await publicClient.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "platformWallet" });
  console.log(`📋 Escrow: fee=${feePct}%, platformWallet=${platformWallet}`);

  // Step 1: Create a new deal via API
  console.log("\n=== Step 1: Create offer + need + deal ===");
  const offer = await api("POST", "/api/offers", {
    agentId: SELLER_ID,
    title: "On-chain test: ROS2 Micro-Consulting",
    descriptionMd: "Quick architecture review — on-chain escrow test with 1 USDC",
    category: "consulting",
    tags: ["test", "ros2"],
    currency: "USDC",
    basePrice: 1,
    maxPriceDeltaPct: 0,
    fulfillmentType: "generic",
  }, SELLER_KEY);
  console.log("✅ Offer:", offer.id);

  const need = await api("POST", "/api/needs", {
    agentId: BUYER_ID,
    title: "Need quick ROS2 review — 1 USDC test",
    descriptionMd: "Testing on-chain escrow flow",
    category: "consulting",
    tags: ["test", "ros2"],
    currency: "USDC",
    budgetMax: 2,
    fulfillmentType: "generic",
  }, BUYER_KEY);
  console.log("✅ Need:", need.id);

  const deal = await api("POST", "/api/deals/propose", {
    buyerAgentId: BUYER_ID,
    sellerAgentId: SELLER_ID,
    offerId: offer.id,
    needId: need.id,
    negotiatedTotal: 1,
    maxPriceDeltaPct: 0,
    milestones: [{ idx: 1, title: "Architecture review", amount: 1, acceptanceCriteria: ["Delivered"] }],
  }, BUYER_KEY);
  console.log("✅ Deal:", deal.id, "status:", deal.status);
  const milestoneId = deal.milestones[0].id;
  console.log("   Milestone:", milestoneId);

  // Accept deal
  await api("POST", `/api/deals/${deal.id}/accept`, { actorAgentId: SELLER_ID }, SELLER_KEY);
  console.log("✅ Deal accepted");

  // Step 2: Create payment intent
  console.log("\n=== Step 2: Fund on-chain ===");
  const intent = await api("POST", "/api/payments/create-intent", {
    milestoneId,
    buyerAgentId: BUYER_ID,
    walletProvider: "metamask",
    buyerWalletAddress: account.address,
    chain: "base",
  }, BUYER_KEY);
  console.log("✅ Payment intent:", intent.paymentIntentId, "mode:", intent.mode);
  console.log("   Amount:", intent.amount, intent.currency, "(raw:", intent.txData?.amountRaw, ")");

  if (intent.mode !== "on-chain") {
    console.log("⚠️  Simulation mode — skipping on-chain transactions");
    return;
  }

  // Step 3: Approve USDC
  console.log("\n=== Step 3: Approve USDC ===");
  const amount = parseUnits("1", 6); // 1 USDC
  const approveTx = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [ESCROW_ADDRESS, amount],
  });
  console.log("📤 Approve tx:", approveTx);
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx, confirmations: 2 });
  console.log("✅ Approved, block:", approveReceipt.blockNumber);

  // Step 4: Fund escrow
  console.log("\n=== Step 4: Fund escrow ===");
  const dealBytes32 = uuidToBytes32(deal.id);
  const msBytes32 = uuidToBytes32(milestoneId);

  // Get seller wallet
  const sellerAgent = await api("GET", `/api/agents/${SELLER_ID}`);
  const sellerWallet = sellerAgent.owner_wallet_address as Address;
  console.log("   Seller wallet:", sellerWallet);

  const fundTx = await walletClient.writeContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "createMilestone",
    args: [dealBytes32, msBytes32, sellerWallet, amount],
  });
  console.log("📤 Fund tx:", fundTx);
  const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTx, confirmations: 2 });
  console.log("✅ Funded, block:", fundReceipt.blockNumber);

  // Step 5: Confirm funding via API
  console.log("\n=== Step 5: Confirm funding ===");
  const confirm = await api("POST", "/api/payments/confirm-funding", {
    paymentIntentId: intent.paymentIntentId,
    txHash: fundTx,
    buyerAgentId: BUYER_ID,
  }, BUYER_KEY);
  console.log("✅ Funding confirmed:", confirm);

  // Step 6: Deliver + confirm
  console.log("\n=== Step 6: Deliver + confirm ===");
  await api("POST", `/api/deals/${deal.id}/fulfillment`, {
    agentId: SELLER_ID,
    fulfillmentData: { description: "Architecture review completed. Full on-chain test deal." },
  }, SELLER_KEY);
  console.log("✅ Fulfilled");

  const result = await api("POST", `/api/deals/${deal.id}/confirm-delivery`, {
    agentId: BUYER_ID,
    skipOnChainRelease: false,
  }, BUYER_KEY);
  console.log("✅ Confirmed:", result.status);
  console.log("   Release:", JSON.stringify(result.release));

  // Check final balance
  const finalBalance = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log("\n💰 Final USDC balance:", formatUnits(finalBalance, 6), "(was:", formatUnits(balance, 6), ")");
  console.log("💵 Commission should have arrived at platform wallet:", platformWallet);
}

main().catch(err => { console.error("❌ FAILED:", err.message); process.exit(1); });
