/**
 * Blockchain integration for AgentPact Escrow on Base.
 *
 * Two modes:
 *   1. **On-chain** — PLATFORM_PRIVATE_KEY is set → real USDC txs via the deployed escrow contract.
 *   2. **Simulation** — no private key → returns simulated data, no on-chain calls.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  parseEventLogs,
  type Hex,
  type Address,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ── Addresses & config ───────────────────────────────────────────────
export const ESCROW_ADDRESS: Address =
  (process.env.ESCROW_CONTRACT as Address) ??
  (process.env.ESCROW_CONTRACT_ADDRESS as Address) ??
  "0x588168712bF758aFD747bF46471afa53f9599A64";
export const USDC_ADDRESS: Address =
  (process.env.USDC_CONTRACT as Address) ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const RPC_URL =
  process.env.BASE_RPC_URL ??
  process.env.RPC_URL ??
  "https://mainnet.base.org";

// ── ABI — derived from contracts/AgentPactEscrow.sol ─────────────────
// Contract functions:
//   createMilestone(bytes32 dealId, bytes32 milestoneId, address seller, uint256 amount) — buyer calls (after USDC approve)
//   acceptMilestone(bytes32 milestoneId) — buyer calls to release funds to seller
//   openDispute(bytes32 milestoneId) — buyer calls
//   resolveDispute(bytes32 milestoneId, bool refundBuyer) — platformWallet calls
//   claimAfterTimeout(bytes32 milestoneId) — seller calls after 7-day timeout

export const ESCROW_ABI = [
  // State-changing
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
    name: "openDispute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "resolveDispute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneId", type: "bytes32" },
      { name: "refundBuyer", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "claimAfterTimeout",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "milestoneId", type: "bytes32" }],
    outputs: [],
  },
  // Views
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
  {
    name: "usdc",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "platformWallet",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "platformFeePercent",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "TIMEOUT_PERIOD",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Events — required for verifyFunding() to bind a tx receipt to the specific
  // milestone/deal/buyer/seller/amount it claims to fund. Without this in the
  // ABI, decodeEventLog/parseEventLogs cannot decode MilestoneCreated logs.
  {
    name: "MilestoneCreated",
    type: "event",
    anonymous: false,
    inputs: [
      { name: "milestoneId", type: "bytes32", indexed: true },
      { name: "dealId", type: "bytes32", indexed: true },
      { name: "buyer", type: "address", indexed: false },
      { name: "seller", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
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
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Clients ──────────────────────────────────────────────────────────
export const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

const PLATFORM_PRIVATE_KEY = process.env.PLATFORM_PRIVATE_KEY;
export const platformAccount = PLATFORM_PRIVATE_KEY
  ? privateKeyToAccount(PLATFORM_PRIVATE_KEY as Hex)
  : null;

export const walletClient =
  platformAccount
    ? createWalletClient({
        account: platformAccount,
        chain: base,
        transport: http(RPC_URL),
      })
    : null;

/** Whether we can send on-chain transactions */
export const isOnChainMode = (): boolean => walletClient !== null;

// ── Enum mapping (matches Solidity MilestoneStatus) ──────────────────
const MILESTONE_STATUS_MAP: Record<number, string> = {
  0: "Funded",
  1: "Accepted",
  2: "Disputed",
  3: "Resolved",
};

// ── Helpers ──────────────────────────────────────────────────────────

/** Convert a UUID to a bytes32 hex (left-padded with zeros after removing dashes) */
export function uuidToBytes32(uuid: string): Hex {
  const stripped = uuid.replace(/-/g, "");
  return `0x${stripped.padStart(64, "0")}` as Hex;
}

/** USDC has 6 decimals on Base */
export function usdcToUnits(amount: number): bigint {
  return parseUnits(amount.toString(), 6);
}

export function unitsToUsdc(units: bigint): string {
  return formatUnits(units, 6);
}

// ── Public functions ─────────────────────────────────────────────────

/**
 * Generate the unsigned transaction(s) the buyer needs to sign to fund a milestone.
 *
 * Returns two call descriptions:
 *   1. USDC.approve(escrow, amount)
 *   2. Escrow.createMilestone(dealId, milestoneId, seller, amount)
 *
 * The API does NOT sign these — the buyer's wallet does.
 */
export function generateFundingTransaction(
  dealId: string,
  milestoneId: string,
  amount: number,
  sellerAddress: Address,
): {
  approveCalldata: Hex;
  fundCalldata: Hex;
  approveTo: Address;
  fundTo: Address;
  value: string;
  amountRaw: string;
} {
  const amountRaw = usdcToUnits(amount);
  const dealBytes32 = uuidToBytes32(dealId);
  const milestoneBytes32 = uuidToBytes32(milestoneId);

  const approveCalldata = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [ESCROW_ADDRESS, amountRaw],
  });

  const fundCalldata = encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: "createMilestone",
    args: [dealBytes32, milestoneBytes32, sellerAddress, amountRaw],
  });

  return {
    approveCalldata,
    fundCalldata,
    approveTo: USDC_ADDRESS,
    fundTo: ESCROW_ADDRESS,
    value: "0",
    amountRaw: amountRaw.toString(),
  };
}

/**
 * Verify that a transaction hash corresponds to a successful createMilestone call
 * that funded THIS SPECIFIC milestone.
 *
 * Waits for 2 confirmations, then decodes the receipt's logs looking for a
 * `MilestoneCreated` event emitted BY the escrow contract. The decoded
 * milestoneId/dealId/buyer/seller/amount are returned, and — critically — if an
 * `expected` binding is supplied, ANY mismatch against it (wrong milestone, wrong
 * buyer, wrong seller, wrong amount) is rejected with `verified:false` and a
 * `reason`. This closes the custody hole where any successful past transaction
 * sent to the escrow address (e.g. someone else's funding, or an unrelated
 * milestone's funding) could be replayed as "proof" of funding a different
 * payment intent — the caller only ever checked `receipt.to`, never *what* was
 * funded.
 *
 * A receipt with no MilestoneCreated log at all (e.g. wrong tx, unrelated escrow
 * call) is always `verified:false`.
 */
export async function verifyFunding(
  txHash: Hex,
  expected?: {
    milestoneId: string; // UUID or bytes32 hex — converted via uuidToBytes32 if not already 0x-prefixed
    dealId?: string;
    buyer?: Address;
    seller?: Address;
    amountRaw?: bigint;
  },
): Promise<{
  verified: boolean;
  reason?: string;
  milestoneId?: Hex;
  dealId?: Hex;
  buyer?: Address;
  seller?: Address;
  amount?: string;
  receipt?: TransactionReceipt;
}> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 2,
      timeout: 120_000, // 2 minutes
    });

    if (receipt.status !== "success") {
      return { verified: false, reason: "Transaction did not succeed on-chain" };
    }

    // Check that the transaction was to the escrow contract
    if (receipt.to?.toLowerCase() !== ESCROW_ADDRESS.toLowerCase()) {
      return { verified: false, reason: "Transaction was not sent to the escrow contract" };
    }

    // Decode only logs emitted BY the escrow contract itself — a receipt could
    // in principle contain logs from other contracts (e.g. the USDC transfer
    // inside the same tx); we must not accept a MilestoneCreated-shaped log
    // that didn't actually come from the escrow.
    const escrowLogs = receipt.logs.filter(
      (log) => log.address.toLowerCase() === ESCROW_ADDRESS.toLowerCase(),
    );

    const decoded = parseEventLogs({
      abi: ESCROW_ABI,
      eventName: "MilestoneCreated",
      logs: escrowLogs,
    });

    const created = decoded[0];
    if (!created) {
      return {
        verified: false,
        reason: "No MilestoneCreated event found in this transaction's receipt",
      };
    }

    // Every field is a required (non-indexed-optional) part of the event ABI
    // above, so decoding a match always yields all five — the `| undefined`
    // TS sees is viem's generic decode signature, not a real runtime case.
    const milestoneId = created.args.milestoneId as Hex;
    const dealId = created.args.dealId as Hex;
    const buyer = created.args.buyer as Address;
    const seller = created.args.seller as Address;
    const amount = created.args.amount as bigint;

    if (expected) {
      const expectedMilestoneBytes32 = expected.milestoneId.startsWith("0x")
        ? (expected.milestoneId as Hex)
        : uuidToBytes32(expected.milestoneId);

      if (milestoneId.toLowerCase() !== expectedMilestoneBytes32.toLowerCase()) {
        return {
          verified: false,
          reason: "On-chain MilestoneCreated event does not name the milestone being confirmed — this tx funded a DIFFERENT milestone",
        };
      }

      if (expected.dealId) {
        const expectedDealBytes32 = expected.dealId.startsWith("0x")
          ? (expected.dealId as Hex)
          : uuidToBytes32(expected.dealId);
        if (dealId.toLowerCase() !== expectedDealBytes32.toLowerCase()) {
          return { verified: false, reason: "On-chain MilestoneCreated event does not match the expected deal" };
        }
      }

      if (expected.buyer && buyer.toLowerCase() !== expected.buyer.toLowerCase()) {
        return { verified: false, reason: "On-chain MilestoneCreated buyer does not match the expected buyer" };
      }

      if (expected.seller && seller.toLowerCase() !== expected.seller.toLowerCase()) {
        return { verified: false, reason: "On-chain MilestoneCreated seller does not match the expected seller" };
      }

      if (expected.amountRaw !== undefined && amount !== expected.amountRaw) {
        return { verified: false, reason: "On-chain MilestoneCreated amount does not match the expected amount" };
      }
    }

    return {
      verified: true,
      milestoneId,
      dealId,
      buyer,
      seller,
      amount: unitsToUsdc(amount),
      receipt,
    };
  } catch (err) {
    return { verified: false, reason: err instanceof Error ? err.message : "Verification failed" };
  }
}

/**
 * Release milestone funds — buyer calls acceptMilestone on-chain.
 *
 * In the on-chain flow the *buyer* would normally call acceptMilestone from their wallet.
 * But for platform-initiated releases (after delivery verification), the platform
 * calls resolveDispute(milestoneId, false) which pays the seller.
 *
 * However, since the contract's acceptMilestone requires msg.sender == buyer,
 * the platform cannot call it directly. So for platform-initiated release we have two options:
 *   A) Return unsigned tx for buyer to sign (like funding)
 *   B) If the milestone is disputed, use resolveDispute(milestoneId, false)
 *
 * This function handles option B (platform resolves in seller's favor).
 * For option A, use generateAcceptTransaction().
 */
export function generateAcceptTransaction(milestoneId: string): {
  calldata: Hex;
  to: Address;
} {
  const milestoneBytes32 = uuidToBytes32(milestoneId);
  const calldata = encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: "acceptMilestone",
    args: [milestoneBytes32],
  });
  return { calldata, to: ESCROW_ADDRESS };
}

/**
 * Platform resolves a dispute in favor of the seller (releases funds).
 * Requires PLATFORM_PRIVATE_KEY.
 */
export async function resolveDisputeOnChain(
  milestoneId: string,
  refundBuyer: boolean,
): Promise<{ txHash: Hex }> {
  if (!walletClient || !platformAccount) {
    throw new Error("PLATFORM_PRIVATE_KEY not set — cannot resolve dispute on-chain");
  }

  const milestoneBytes32 = uuidToBytes32(milestoneId);

  const txHash = await walletClient.writeContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "resolveDispute",
    args: [milestoneBytes32, refundBuyer],
  });

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 2,
  });

  return { txHash };
}

// ── Multi-chain support ───────────────────────────────────────────────────────

/** Supported chains and their USDC contract addresses. */
export const CHAIN_CONFIG: Record<string, { usdcAddress: Address; rpcUrl: string; name: string }> = {
  base: {
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    name: "Base",
  },
  arbitrum: {
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpcUrl: process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    name: "Arbitrum One",
  },
  polygon: {
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpcUrl: process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com",
    name: "Polygon",
  },
  solana: {
    // USDC-SPL on Solana mainnet
    usdcAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address,
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    name: "Solana",
  },
};

/**
 * Infer the blockchain from a wallet address format.
 *
 * - EVM addresses: "0x" prefix + 40 hex chars → base (default EVM)
 * - Solana addresses: base58, 32-44 chars, no "0x" prefix
 *
 * The caller can optionally pass an explicit `chainHint` (e.g. "arbitrum") which
 * overrides auto-detection when the same wallet address format appears on multiple EVM chains.
 */
export function resolveChainFromAddress(
  walletAddress: string,
  chainHint?: string,
): string {
  if (chainHint && CHAIN_CONFIG[chainHint]) {
    return chainHint;
  }

  if (/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    // EVM address — default to base unless a hint says otherwise
    return "base";
  }

  // Solana: base58 alphabet, 32-44 characters
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return "solana";
  }

  // Fallback
  return "base";
}

/**
 * Validate that a wallet address is syntactically valid for the given chain.
 * Returns `{ valid: true }` or `{ valid: false, reason: string }`.
 */
export function validateWalletAddress(
  walletAddress: string,
  chain: string,
): { valid: boolean; reason?: string } {
  if (chain === "solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      return { valid: false, reason: "Invalid Solana address (expected base58, 32-44 chars)" };
    }
    return { valid: true };
  }

  // All EVM chains (base, arbitrum, polygon)
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return { valid: false, reason: `Invalid EVM address for chain ${chain} (expected 0x + 40 hex chars)` };
  }
  return { valid: true };
}

/**
 * Read on-chain milestone status from the escrow contract.
 */
export async function getMilestoneStatus(milestoneId: string): Promise<{
  exists: boolean;
  dealId?: string;
  buyer?: Address;
  seller?: Address;
  amount?: string;
  status?: string;
  statusCode?: number;
  createdAt?: number;
}> {
  try {
    const milestoneBytes32 = uuidToBytes32(milestoneId);

    const result = await publicClient.readContract({
      address: ESCROW_ADDRESS,
      abi: ESCROW_ABI,
      functionName: "milestones",
      args: [milestoneBytes32],
    });

    const [dealId, buyer, seller, amount, status, createdAt] = result;

    // If amount is 0, the milestone doesn't exist on-chain
    if (amount === 0n) {
      return { exists: false };
    }

    return {
      exists: true,
      dealId: dealId as string,
      buyer: buyer as Address,
      seller: seller as Address,
      amount: unitsToUsdc(amount as bigint),
      status: MILESTONE_STATUS_MAP[Number(status)] ?? "Unknown",
      statusCode: Number(status),
      createdAt: Number(createdAt),
    };
  } catch {
    return { exists: false };
  }
}
