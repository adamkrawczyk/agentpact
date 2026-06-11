/**
 * E2E On-Chain Test — AgentPact Full Payment Flow
 *
 * Tests the complete lifecycle against the live API + real Base blockchain:
 *   1. Register two agents (buyer + seller)
 *   2. Create an offer ($0.50 USDC)
 *   3. Create a matching need
 *   4. Propose a deal with 1 milestone
 *   5. Accept the deal
 *   6. Create payment intent → get tx data
 *   7. Sign & send USDC approve tx
 *   8. Sign & send escrow createMilestone tx
 *   9. Confirm funding via API
 *  10. Release payment (acceptMilestone on-chain)
 *  11. Verify final state
 *
 * Prerequisites:
 *   - BUYER_PRIVATE_KEY env var (hex, with or without 0x prefix)
 *   - The buyer wallet needs ≥ 0.50 USDC on Base + some ETH for gas
 *   - API_URL defaults to https://api.agentpact.xyz
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x... tsx scripts/e2e-onchain-test.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  parseUnits,
  type Hex,
  type Address,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";

// ── Config ───────────────────────────────────────────────────────────

const API_URL = process.env.API_URL ?? "https://api.agentpact.xyz";
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY;
const RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

const ESCROW_ADDRESS: Address = "0x588168712bF758aFD747bF46471afa53f9599A64";
const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const USDC_AMOUNT = 0.5; // $0.50 USDC
const TEST_CATEGORY = "e2e-testing";
const TEST_TAG = "e2e-onchain";

// ── ABIs (minimal) ───────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ESCROW_ABI = [
  {
    name: "createMilestone",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dealId", type: "bytes32" },
      { name: "milestoneId", type: "bytes32" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "acceptMilestone",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "milestones",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "milestoneId", type: "bytes32" }],
    outputs: [
      { name: "dealId", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "createdAt", type: "uint256" },
    ],
  },
] as const;

const MILESTONE_STATUS = ["Funded", "Accepted", "Disputed", "Resolved"] as const;

// ── Helpers ──────────────────────────────────────────────────────────

function log(step: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${step}] ${msg}`);
}

function logError(step: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ❌ [${step}] ${msg}`);
}

function logSuccess(step: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ✅ [${step}] ${msg}`);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  apiKey?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["x-api-key"] = apiKey;

  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function uuidToBytes32(uuid: string): Hex {
  const stripped = uuid.replace(/-/g, "");
  return `0x${stripped.padStart(64, "0")}` as Hex;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  AgentPact E2E On-Chain Test");
  console.log("═".repeat(60) + "\n");

  // ── Validate env ─────────────────────────────────────────────────

  if (!BUYER_PRIVATE_KEY) {
    logError("ENV", "BUYER_PRIVATE_KEY is required. Set it in your environment.");
    logError("ENV", "The wallet needs USDC on Base and some ETH for gas.");
    process.exit(1);
  }

  const privKey = BUYER_PRIVATE_KEY.startsWith("0x")
    ? (BUYER_PRIVATE_KEY as Hex)
    : (`0x${BUYER_PRIVATE_KEY}` as Hex);

  const account = privateKeyToAccount(privKey);
  const buyerAddress = account.address;

  log("INIT", `API URL: ${API_URL}`);
  log("INIT", `Buyer wallet: ${buyerAddress}`);
  log("INIT", `Escrow contract: ${ESCROW_ADDRESS}`);
  log("INIT", `USDC contract: ${USDC_ADDRESS}`);
  log("INIT", `Test amount: ${USDC_AMOUNT} USDC`);

  // ── Setup viem clients ───────────────────────────────────────────

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  // ── Pre-flight checks ───────────────────────────────────────────

  log("PREFLIGHT", "Checking balances...");

  const [ethBalance, usdcBalance] = await Promise.all([
    publicClient.getBalance({ address: buyerAddress }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [buyerAddress],
    }),
  ]);

  const ethFormatted = formatUnits(ethBalance, 18);
  const usdcFormatted = formatUnits(usdcBalance, 6);

  log("PREFLIGHT", `ETH balance: ${ethFormatted} ETH`);
  log("PREFLIGHT", `USDC balance: ${usdcFormatted} USDC`);

  if (ethBalance < parseUnits("0.0001", 18)) {
    logError("PREFLIGHT", "Insufficient ETH for gas. Need at least 0.0001 ETH.");
    process.exit(1);
  }

  if (usdcBalance < parseUnits(USDC_AMOUNT.toString(), 6)) {
    logError("PREFLIGHT", `Insufficient USDC. Need at least ${USDC_AMOUNT} USDC.`);
    process.exit(1);
  }

  logSuccess("PREFLIGHT", "Balances OK");

  // ── Step 1: Register agents ──────────────────────────────────────

  log("STEP 1", "Registering buyer agent...");
  const buyerAgentId = randomUUID();
  const { status: buyerRegStatus, data: buyerReg } = await api("POST", "/api/auth/register", {
    agentId: buyerAgentId,
    walletAddress: buyerAddress,
  });

  if (buyerRegStatus !== 201) {
    logError("STEP 1", `Buyer registration failed: ${JSON.stringify(buyerReg)}`);
    process.exit(1);
  }

  const buyerApiKey = buyerReg.apiKey;
  logSuccess("STEP 1", `Buyer registered: ${buyerAgentId}`);

  // Create the buyer agent profile
  const { status: buyerProfileStatus } = await api(
    "POST",
    "/api/agents",
    {
      handle: `e2e-buyer-${Date.now()}`,
      displayName: "E2E Test Buyer",
      ownerWalletAddress: buyerAddress,
      walletProvider: "metamask",
    },
    buyerApiKey,
  );
  if (buyerProfileStatus !== 201) {
    log("STEP 1", "Buyer agent profile creation returned non-201 (may already exist)");
  }

  log("STEP 1", "Registering seller agent...");
  const sellerAgentId = randomUUID();
  // Use a deterministic seller address (doesn't need to sign anything for this test)
  const sellerAddress = "0x1234567890abcdef1234567890abcdef12345678" as Address;
  const { status: sellerRegStatus, data: sellerReg } = await api("POST", "/api/auth/register", {
    agentId: sellerAgentId,
    walletAddress: sellerAddress,
  });

  if (sellerRegStatus !== 201) {
    logError("STEP 1", `Seller registration failed: ${JSON.stringify(sellerReg)}`);
    process.exit(1);
  }

  const sellerApiKey = sellerReg.apiKey;
  logSuccess("STEP 1", `Seller registered: ${sellerAgentId}`);

  // Create the seller agent profile
  await api(
    "POST",
    "/api/agents",
    {
      handle: `e2e-seller-${Date.now()}`,
      displayName: "E2E Test Seller",
      ownerWalletAddress: sellerAddress,
      walletProvider: "metamask",
    },
    sellerApiKey,
  );

  // ── Step 2: Create offer ─────────────────────────────────────────

  log("STEP 2", "Creating offer ($0.50 USDC)...");
  const { status: offerStatus, data: offer } = await api(
    "POST",
    "/api/offers",
    {
      agentId: sellerAgentId,
      title: "E2E Test Service Offer",
      descriptionMd: "Automated E2E test offer for on-chain payment flow testing.",
      category: TEST_CATEGORY,
      tags: [TEST_TAG],
      basePrice: USDC_AMOUNT,
      currency: "USDC",
      maxPriceDeltaPct: 15,
      slaDays: 7,
    },
    sellerApiKey,
  );

  if (offerStatus !== 201) {
    logError("STEP 2", `Offer creation failed: ${JSON.stringify(offer)}`);
    process.exit(1);
  }

  logSuccess("STEP 2", `Offer created: ${offer.id}`);

  // ── Step 3: Create need ──────────────────────────────────────────

  log("STEP 3", "Creating matching need...");
  const { status: needStatus, data: need } = await api(
    "POST",
    "/api/needs",
    {
      agentId: buyerAgentId,
      title: "E2E Test Service Need",
      descriptionMd: "Automated E2E test need for on-chain payment flow testing.",
      category: TEST_CATEGORY,
      tags: [TEST_TAG],
      budgetMin: 0.1,
      budgetMax: 1.0,
      currency: "USDC",
      acceptanceCriteria: ["Task completed", "Verified on-chain"],
    },
    buyerApiKey,
  );

  if (needStatus !== 201) {
    logError("STEP 3", `Need creation failed: ${JSON.stringify(need)}`);
    process.exit(1);
  }

  logSuccess("STEP 3", `Need created: ${need.id}`);

  // ── Step 4: Propose deal ─────────────────────────────────────────

  log("STEP 4", "Proposing deal with 1 milestone...");
  const { status: dealStatus, data: deal } = await api(
    "POST",
    "/api/deals/propose",
    {
      buyerAgentId,
      sellerAgentId,
      offerId: offer.id,
      needId: need.id,
      negotiatedTotal: USDC_AMOUNT,
      maxPriceDeltaPct: 15,
      milestones: [
        {
          idx: 1,
          title: "Complete E2E test task",
          amount: USDC_AMOUNT,
          acceptanceCriteria: ["Task completed", "Verified on-chain"],
        },
      ],
    },
    buyerApiKey,
  );

  if (dealStatus !== 201) {
    logError("STEP 4", `Deal proposal failed: ${JSON.stringify(deal)}`);
    process.exit(1);
  }

  const dealId = deal.id;
  const milestoneId = deal.milestones[0].id;
  logSuccess("STEP 4", `Deal proposed: ${dealId}`);
  log("STEP 4", `Milestone ID: ${milestoneId}`);

  // ── Step 5: Accept deal ──────────────────────────────────────────

  log("STEP 5", "Seller accepting deal...");
  const { status: acceptStatus, data: acceptData } = await api(
    "POST",
    `/api/deals/${dealId}/accept`,
    { actorAgentId: sellerAgentId },
    sellerApiKey,
  );

  if (acceptStatus !== 200) {
    logError("STEP 5", `Deal acceptance failed: ${JSON.stringify(acceptData)}`);
    process.exit(1);
  }

  logSuccess("STEP 5", "Deal accepted");

  // ── Step 6: Create payment intent ────────────────────────────────

  log("STEP 6", "Creating payment intent...");
  const { status: intentStatus, data: intent } = await api(
    "POST",
    "/api/payments/create-intent",
    {
      milestoneId,
      buyerAgentId,
      walletProvider: "metamask",
      buyerWalletAddress: buyerAddress,
      chain: "base",
    },
    buyerApiKey,
  );

  if (intentStatus !== 201) {
    logError("STEP 6", `Payment intent failed: ${JSON.stringify(intent)}`);
    process.exit(1);
  }

  logSuccess("STEP 6", `Payment intent created: ${intent.paymentIntentId}`);
  log("STEP 6", `Mode: ${intent.mode}`);

  if (intent.mode !== "on-chain") {
    logError("STEP 6", "API returned simulation mode — PLATFORM_PRIVATE_KEY may not be set on the server.");
    logError("STEP 6", "The server needs PLATFORM_PRIVATE_KEY for on-chain mode. Aborting.");
    process.exit(1);
  }

  const txData = intent.txData;
  log("STEP 6", `Approve to: ${txData.step1_approve.to}`);
  log("STEP 6", `Fund to: ${txData.step2_fund.to}`);
  log("STEP 6", `Amount (raw): ${txData.amountRaw} (${USDC_AMOUNT} USDC)`);

  // ── Step 7: Sign & send USDC approve ─────────────────────────────

  log("STEP 7", "Sending USDC approve transaction...");

  const approveHash = await walletClient.sendTransaction({
    to: txData.step1_approve.to as Address,
    data: txData.step1_approve.data as Hex,
    value: 0n,
  });

  log("STEP 7", `Approve tx sent: ${approveHash}`);
  log("STEP 7", "Waiting for confirmation...");

  const approveReceipt = await publicClient.waitForTransactionReceipt({
    hash: approveHash,
    confirmations: 2,
    timeout: 120_000,
  });

  if (approveReceipt.status !== "success") {
    logError("STEP 7", "Approve transaction reverted!");
    process.exit(1);
  }

  logSuccess("STEP 7", `Approve confirmed in block ${approveReceipt.blockNumber}`);

  // Verify allowance
  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [buyerAddress, ESCROW_ADDRESS],
  });
  log("STEP 7", `USDC allowance for escrow: ${formatUnits(allowance, 6)} USDC`);

  // ── Step 8: Sign & send createMilestone ──────────────────────────

  log("STEP 8", "Sending createMilestone transaction...");

  const fundHash = await walletClient.sendTransaction({
    to: txData.step2_fund.to as Address,
    data: txData.step2_fund.data as Hex,
    value: 0n,
  });

  log("STEP 8", `Fund tx sent: ${fundHash}`);
  log("STEP 8", "Waiting for confirmation...");

  const fundReceipt = await publicClient.waitForTransactionReceipt({
    hash: fundHash,
    confirmations: 2,
    timeout: 120_000,
  });

  if (fundReceipt.status !== "success") {
    logError("STEP 8", "createMilestone transaction reverted!");
    logError("STEP 8", `Receipt: ${JSON.stringify(fundReceipt, null, 2)}`);
    process.exit(1);
  }

  logSuccess("STEP 8", `createMilestone confirmed in block ${fundReceipt.blockNumber}`);
  log("STEP 8", `Gas used: ${fundReceipt.gasUsed.toString()}`);

  // Verify on-chain milestone state
  const milestoneBytes32 = uuidToBytes32(milestoneId);
  const onChainMilestone = await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "milestones",
    args: [milestoneBytes32],
  });

  const [mDealId, mBuyer, mSeller, mAmount, mStatus, mCreatedAt] = onChainMilestone;
  log("STEP 8", `On-chain milestone status: ${MILESTONE_STATUS[mStatus]} (${mStatus})`);
  log("STEP 8", `On-chain amount: ${formatUnits(mAmount, 6)} USDC`);
  log("STEP 8", `On-chain buyer: ${mBuyer}`);
  log("STEP 8", `On-chain seller: ${mSeller}`);

  // ── Step 9: Confirm funding via API ──────────────────────────────

  log("STEP 9", "Confirming funding with API...");
  const { status: confirmStatus, data: confirmData } = await api(
    "POST",
    "/api/payments/confirm-funding",
    {
      paymentIntentId: intent.paymentIntentId,
      txHash: fundHash,
    },
    buyerApiKey,
  );

  if (confirmStatus !== 200) {
    logError("STEP 9", `Confirm funding failed: ${JSON.stringify(confirmData)}`);
    logError("STEP 9", "This may be a timing issue — the API waits for 2 confirmations.");
    process.exit(1);
  }

  logSuccess("STEP 9", `Funding confirmed! Status: ${confirmData.status}`);

  // ── Step 10: Release payment (acceptMilestone) ───────────────────

  log("STEP 10", "Getting release tx data from API...");
  const { status: releaseStatus, data: releaseData } = await api(
    "POST",
    "/api/payments/release",
    { milestoneId },
    buyerApiKey,
  );

  if (releaseStatus !== 200) {
    logError("STEP 10", `Release request failed: ${JSON.stringify(releaseData)}`);
    process.exit(1);
  }

  log("STEP 10", `Release action: ${releaseData.action}`);

  if (releaseData.action !== "buyer_sign_required") {
    logError("STEP 10", `Unexpected action: ${releaseData.action}`);
    process.exit(1);
  }

  log("STEP 10", "Sending acceptMilestone transaction...");

  const acceptHash = await walletClient.sendTransaction({
    to: releaseData.txData.to as Address,
    data: releaseData.txData.data as Hex,
    value: 0n,
  });

  log("STEP 10", `acceptMilestone tx sent: ${acceptHash}`);
  log("STEP 10", "Waiting for confirmation...");

  const acceptReceipt = await publicClient.waitForTransactionReceipt({
    hash: acceptHash,
    confirmations: 2,
    timeout: 120_000,
  });

  if (acceptReceipt.status !== "success") {
    logError("STEP 10", "acceptMilestone transaction reverted!");
    process.exit(1);
  }

  logSuccess("STEP 10", `acceptMilestone confirmed in block ${acceptReceipt.blockNumber}`);
  log("STEP 10", `Gas used: ${acceptReceipt.gasUsed.toString()}`);

  // ── Step 11: Verify final state ──────────────────────────────────

  log("STEP 11", "Verifying final state...");

  // Check on-chain milestone status
  const finalMilestone = await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "milestones",
    args: [milestoneBytes32],
  });

  const finalStatus = finalMilestone[4];
  log("STEP 11", `On-chain milestone status: ${MILESTONE_STATUS[finalStatus]} (${finalStatus})`);

  if (finalStatus !== 1) {
    // 1 = Accepted
    logError("STEP 11", `Expected status Accepted (1), got ${MILESTONE_STATUS[finalStatus]} (${finalStatus})`);
    process.exit(1);
  }

  // Check API state
  const { data: dealFinal } = await api("GET", `/api/deals/${dealId}`, undefined, buyerApiKey);
  log("STEP 11", `API deal status: ${dealFinal.status}`);

  const { data: paymentStatus } = await api(
    "GET",
    `/api/payments/status?milestoneId=${milestoneId}`,
    undefined,
    buyerApiKey,
  );
  if (paymentStatus && paymentStatus.length > 0) {
    log("STEP 11", `API payment status: ${paymentStatus[0].status}`);
  }

  // Check final USDC balance
  const finalUsdcBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [buyerAddress],
  });
  log("STEP 11", `Final USDC balance: ${formatUnits(finalUsdcBalance, 6)} USDC`);
  log(
    "STEP 11",
    `USDC spent: ${formatUnits(usdcBalance - finalUsdcBalance, 6)} USDC`,
  );

  logSuccess("STEP 11", "On-chain milestone status: Accepted ✓");

  // ── Summary ──────────────────────────────────────────────────────

  console.log("\n" + "═".repeat(60));
  console.log("  ✅ E2E On-Chain Test PASSED");
  console.log("═".repeat(60));
  console.log(`
  Deal ID:        ${dealId}
  Milestone ID:   ${milestoneId}
  Buyer:          ${buyerAddress}
  Seller:         ${sellerAddress}
  Amount:         ${USDC_AMOUNT} USDC

  Transactions:
    Approve:          ${approveHash}
    createMilestone:  ${fundHash}
    acceptMilestone:  ${acceptHash}

  BaseScan links:
    Approve:  https://basescan.org/tx/${approveHash}
    Fund:     https://basescan.org/tx/${fundHash}
    Release:  https://basescan.org/tx/${acceptHash}
`);
}

// ── Run ──────────────────────────────────────────────────────────────

main().catch((err) => {
  logError("FATAL", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
