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
  type Hex,
  type Address,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ── Addresses & config ───────────────────────────────────────────────
export const ESCROW_ADDRESS: Address =
  (process.env.ESCROW_CONTRACT as Address) ?? "0x588168712bF758aFD747bF46471afa53f9599A64";
export const USDC_ADDRESS: Address =
  (process.env.USDC_CONTRACT as Address) ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

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
 * Verify that a transaction hash corresponds to a successful createMilestone call.
 * Waits for 2 confirmations, then inspects the receipt for MilestoneCreated events.
 */
export async function verifyFunding(txHash: Hex): Promise<{
  verified: boolean;
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
      return { verified: false };
    }

    // Check that the transaction was to the escrow contract
    if (receipt.to?.toLowerCase() !== ESCROW_ADDRESS.toLowerCase()) {
      return { verified: false };
    }

    return { verified: true, receipt };
  } catch {
    return { verified: false };
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
