// scripts/deploy-escrow-v2.cjs — settlement_2705 Phase G
//
// One-shot deploy script for the v2 contract suite on Base mainnet (or
// Base Sepolia for staging). Mirrors scripts/deploy-escrow.cjs.
//
// What it deploys, in order:
//   1. HashPreimagePredicate
//   2. SignedBlobPredicate
//   3. MerkleMembershipPredicate
//   4. PredicateRegistry([1, 2, 3])  — IMMUTABLE allowlist
//   5. AgentPactEscrowV2(USDC, registry, PLATFORM_WALLET, BURN_TO, PLATFORM_FEE_BPS)
//   6. AgentPactDeadMansSwitch(true, 0x0, 0x0)  — Q6 default: dormant
//
// Required env (read from .env.production via hardhat.config.cjs):
//   PLATFORM_PRIVATE_KEY  — deployer key (must hold ~0.005 Base ETH for gas)
//   PLATFORM_WALLET       — address that receives 10% fees + acts as 1-of-1 Safe
//   BURN_TO               — burn destination (default: 0x...dEaD per Q1)
//   PLATFORM_FEE_BPS      — basis points; default 1000 (10%)
//
// Output: prints the four deployed addresses + the lines that need to be
// appended to .env.production. BaseScan verification runs separately via
// the existing `npx hardhat verify` flow.

const { ethers } = require("hardhat");

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BURN_TO_DEFAULT = "0x000000000000000000000000000000000000dEaD";
const FEE_BPS_DEFAULT = 1000;

async function main() {
  const [deployer] = await ethers.getSigners();
  const PLATFORM_WALLET = process.env.PLATFORM_WALLET;
  if (!PLATFORM_WALLET) throw new Error("PLATFORM_WALLET env var required");
  const BURN_TO = process.env.BURN_TO || BURN_TO_DEFAULT;
  const FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || FEE_BPS_DEFAULT);

  console.log("Deployer:        ", deployer.address);
  console.log("USDC:            ", USDC_BASE);
  console.log("Platform wallet: ", PLATFORM_WALLET);
  console.log("Burn destination:", BURN_TO);
  console.log("Platform fee bps:", FEE_BPS);
  console.log();

  // 1-3. Predicate verifiers
  console.log("Deploying HashPreimagePredicate…");
  const Hash = await ethers.getContractFactory("HashPreimagePredicate");
  const hash = await Hash.deploy();
  await hash.waitForDeployment();
  const hashAddr = await hash.getAddress();
  console.log("  →", hashAddr);

  console.log("Deploying SignedBlobPredicate…");
  const Signed = await ethers.getContractFactory("SignedBlobPredicate");
  const signed = await Signed.deploy();
  await signed.waitForDeployment();
  const signedAddr = await signed.getAddress();
  console.log("  →", signedAddr);

  console.log("Deploying MerkleMembershipPredicate…");
  const Merkle = await ethers.getContractFactory("MerkleMembershipPredicate");
  const merkle = await Merkle.deploy();
  await merkle.waitForDeployment();
  const merkleAddr = await merkle.getAddress();
  console.log("  →", merkleAddr);

  // 4. Registry (immutable allowlist)
  console.log("Deploying PredicateRegistry…");
  const Reg = await ethers.getContractFactory("PredicateRegistry");
  const reg = await Reg.deploy([hashAddr, signedAddr, merkleAddr]);
  await reg.waitForDeployment();
  const regAddr = await reg.getAddress();
  console.log("  →", regAddr);

  // 5. Main escrow
  console.log("Deploying AgentPactEscrowV2…");
  const Escrow = await ethers.getContractFactory("AgentPactEscrowV2");
  const escrow = await Escrow.deploy(USDC_BASE, regAddr, PLATFORM_WALLET, BURN_TO, FEE_BPS);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("  →", escrowAddr);

  // 6. Dead-man's switch (dormant per Q6 default)
  console.log("Deploying AgentPactDeadMansSwitch (dormant — Q6 default)…");
  const DMS = await ethers.getContractFactory("AgentPactDeadMansSwitch");
  const dms = await DMS.deploy(true, ethers.ZeroAddress, ethers.ZeroAddress);
  await dms.waitForDeployment();
  const dmsAddr = await dms.getAddress();
  console.log("  →", dmsAddr);

  console.log("\n✅ DEPLOY COMPLETE\n");
  console.log("Append to .env.production:");
  console.log(`ESCROW_V2_ADDRESS=${escrowAddr}`);
  console.log(`PREDICATE_REGISTRY_ADDRESS=${regAddr}`);
  console.log(`PREDICATE_HASH_PREIMAGE_ADDRESS=${hashAddr}`);
  console.log(`PREDICATE_SIGNED_BLOB_ADDRESS=${signedAddr}`);
  console.log(`PREDICATE_MERKLE_ADDRESS=${merkleAddr}`);
  console.log(`DEAD_MANS_SWITCH_ADDRESS=${dmsAddr}`);
  console.log();
  console.log("Verify on BaseScan (one per contract):");
  console.log(`  npx hardhat verify --network base ${hashAddr}`);
  console.log(`  npx hardhat verify --network base ${signedAddr}`);
  console.log(`  npx hardhat verify --network base ${merkleAddr}`);
  console.log(`  npx hardhat verify --network base ${regAddr} '[\"${hashAddr}\",\"${signedAddr}\",\"${merkleAddr}\"]'`);
  console.log(`  npx hardhat verify --network base ${escrowAddr} ${USDC_BASE} ${regAddr} ${PLATFORM_WALLET} ${BURN_TO} ${FEE_BPS}`);
  console.log(`  npx hardhat verify --network base ${dmsAddr} true 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000`);
  console.log();
  console.log("Dogfood: run scripts/dogfood-settlement-v2.cjs once the addresses are live.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
