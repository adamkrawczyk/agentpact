/**
 * deploy-cctp-gateway.ts — deploy AgentPactCctpGateway (CCTP v2 pay-in/payout
 * for AgentPactEscrowV3 on Base).
 *
 * Usage:
 *   npx hardhat compile
 *   npx tsx scripts/deploy-cctp-gateway.ts --network base-sepolia [--dry-run]
 *   CONFIRM_MAINNET=yes npx tsx scripts/deploy-cctp-gateway.ts --network base
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY   deployer key (not needed for --dry-run)
 *   ESCROW_V3_ADDRESS      EscrowV3 to bind (required on base-sepolia;
 *                          defaults to the BaseScan-verified mainnet V3 on base)
 *   CCTP_GATEWAY_PAUSER    optional pauser (may only pause NEW deposits);
 *                          default address(0) = never pausable
 *   CCTP_FEE_CAP_BPS       maxFee cap in bps of the burn amount (default 100, max 100)
 *   CCTP_FEE_CAP_FLAT      maxFee floor cap in USDC base units (default 250000, max 1000000)
 *   BASE_RPC_URL / BASE_SEPOLIA_RPC_URL   RPC overrides
 *
 * Mainnet is refused unless CONFIRM_MAINNET=yes. The constructor itself
 * re-checks the wiring (transmitter localDomain == 6, messenger ↔ transmitter
 * pair, escrow.usdc() == usdc), so a wrong address fails at deploy time.
 *
 * Addresses: https://developers.circle.com/cctp/references/contract-addresses
 *            https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";

export type GatewayNetwork = "base" | "base-sepolia";

export interface GatewayDeployConfig {
  network: GatewayNetwork;
  chainId: bigint;
  rpcUrl: string;
  args: {
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
    escrow: string;
    pauser: string;
    feeCapBps: bigint;
    feeCapFlat: bigint;
  };
}

const NETWORKS: Record<GatewayNetwork, {
  chainId: bigint;
  rpcEnv: string;
  defaultRpc: string;
  usdc: string;
  messageTransmitter: string;
  tokenMessenger: string;
  defaultEscrow?: string;
}> = {
  base: {
    chainId: 8453n,
    rpcEnv: "BASE_RPC_URL",
    defaultRpc: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    defaultEscrow: "0x1cc92210988522a06d9950241B32750f82005eb7",
  },
  "base-sepolia": {
    chainId: 84532n,
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
    defaultRpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  },
};

function parseAddress(name: string, value: string): string {
  if (!ethers.isAddress(value)) throw new Error(`${name} is not an address: ${value}`);
  return ethers.getAddress(value);
}

function parseBigint(name: string, value: string, max: bigint): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer: ${value}`);
  const v = BigInt(value);
  if (v > max) throw new Error(`${name} ${v} exceeds the contract limit ${max}`);
  return v;
}

/** Resolve and validate the deployment config. Throws on anything unsafe. */
export function resolveConfig(network: string, env: NodeJS.ProcessEnv): GatewayDeployConfig {
  if (network !== "base" && network !== "base-sepolia") {
    throw new Error(`--network must be base-sepolia or base (got ${JSON.stringify(network)})`);
  }
  if (network === "base" && env.CONFIRM_MAINNET !== "yes") {
    throw new Error("Refusing to target Base mainnet without CONFIRM_MAINNET=yes");
  }
  const n = NETWORKS[network];
  const escrowRaw = env.ESCROW_V3_ADDRESS ?? n.defaultEscrow;
  if (!escrowRaw) throw new Error(`ESCROW_V3_ADDRESS is required on ${network}`);
  return {
    network,
    chainId: n.chainId,
    rpcUrl: env[n.rpcEnv] || n.defaultRpc,
    args: {
      usdc: n.usdc,
      messageTransmitter: n.messageTransmitter,
      tokenMessenger: n.tokenMessenger,
      escrow: parseAddress("ESCROW_V3_ADDRESS", escrowRaw),
      pauser: parseAddress("CCTP_GATEWAY_PAUSER", env.CCTP_GATEWAY_PAUSER ?? ethers.ZeroAddress),
      feeCapBps: parseBigint("CCTP_FEE_CAP_BPS", env.CCTP_FEE_CAP_BPS ?? "100", 100n),
      feeCapFlat: parseBigint("CCTP_FEE_CAP_FLAT", env.CCTP_FEE_CAP_FLAT ?? "250000", 1_000_000n),
    },
  };
}

export function constructorArgs(c: GatewayDeployConfig): [string, string, string, string, string, bigint, bigint] {
  const a = c.args;
  return [a.usdc, a.messageTransmitter, a.tokenMessenger, a.escrow, a.pauser, a.feeCapBps, a.feeCapFlat];
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = resolveConfig(argValue(argv, "--network") ?? "", process.env);
  const dryRun = argv.includes("--dry-run");
  const args = constructorArgs(config);

  console.log(`Network:            ${config.network} (chainId ${config.chainId})`);
  console.log("Constructor args:");
  console.log(`  usdc               ${args[0]}`);
  console.log(`  messageTransmitter ${args[1]}`);
  console.log(`  tokenMessenger     ${args[2]}`);
  console.log(`  escrow (V3)        ${args[3]}`);
  console.log(`  pauser             ${args[4]}`);
  console.log(`  feeCapBps          ${args[5]}`);
  console.log(`  feeCapFlat         ${args[6]}`);
  console.log(`ABI-encoded:        ${ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "address", "uint256", "uint256"], args,
  )}`);
  if (dryRun) {
    console.log("--dry-run: not deploying.");
    return;
  }

  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("DEPLOYER_PRIVATE_KEY is required to deploy (use --dry-run to print args only)");
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const { chainId } = await provider.getNetwork();
  if (chainId !== config.chainId) throw new Error(`RPC chainId ${chainId} != expected ${config.chainId}`);

  const artifactPath = join(process.cwd(), "artifacts/contracts/cctp/AgentPactCctpGateway.sol/AgentPactCctpGateway.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: ethers.InterfaceAbi; bytecode: string };
  const wallet = new ethers.Wallet(key, provider);
  console.log(`Deployer:           ${wallet.address}`);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const gateway = await factory.deploy(...args);
  await gateway.waitForDeployment();
  console.log(`AgentPactCctpGateway deployed: ${await gateway.getAddress()}`);
  console.log(`tx: ${gateway.deploymentTransaction()?.hash}`);
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
