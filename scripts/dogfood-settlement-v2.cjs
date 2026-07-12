// scripts/dogfood-settlement-v2.cjs — settlement protocol Phase G
//
// Phase G dogfood: four real on-chain transactions on Base mainnet
// that exercise every Class A/B/C path end-to-end. Produces a JSON
// report with the BaseScan tx hashes for the walkthrough doc.
//
// Pre-requisites:
//   1. scripts/deploy-escrow-v2.cjs has been run; the four addresses are in
//      .env.production:
//        ESCROW_V2_ADDRESS, PREDICATE_HASH_PREIMAGE_ADDRESS,
//        PREDICATE_SIGNED_BLOB_ADDRESS, PREDICATE_MERKLE_ADDRESS
//   2. The deployer wallet (PLATFORM_PRIVATE_KEY) holds ~$5 USDC + 0.005 ETH.
//   3. The PLATFORM_WALLET ≠ deployer — otherwise the four-wallet delta
//      check collapses; the deployer plays the buyer role and PLATFORM_WALLET
//      plays the platform-fee role. The script also uses a single test
//      seller signer derived from process.env.DOGFOOD_SELLER_SEED so the
//      seller wallet is distinct from both.
//
// What it does:
//   1. Class A $0.50 self-deal: createIntent → claimIntent → assert payout
//   2. Class B $0.50 happy path: createIntentB → acceptIntentB → deliver
//      → acknowledge → assert payout
//   3. Class C $0.30 stream (3 × $0.10): createStreamingIntent → claim 3
//      units → cancelStream (asserts no leftover)
//   4. Class B $0.50 adversarial: createIntentB → accept → deliver → reject
//      with mismatched commit → both stakes burn (verify burn dest balance
//      grew by both stakes + buyer refunded original price)
//
// Output: writes results to scripts/_dogfood-settlement-v2-results.json.
//
// SAFETY: pass --dry-run to skip every state-mutating call and just print
// the planned txs. Default is dry-run — pass --execute to actually broadcast.

const { ethers } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ABI = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

function envOrDie(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const escrowAddr = envOrDie("ESCROW_V2_ADDRESS");
  const hashAddr = envOrDie("PREDICATE_HASH_PREIMAGE_ADDRESS");

  const [deployer] = await ethers.getSigners();
  console.log(`Mode: ${execute ? "EXECUTE (real Base mainnet txs)" : "DRY-RUN (no broadcasts)"}`);
  console.log(`Deployer/Buyer: ${deployer.address}`);
  console.log(`Escrow V2:      ${escrowAddr}`);
  console.log(`Hash predicate: ${hashAddr}`);

  if (!execute) {
    console.log("\nDry-run plan:");
    console.log("  Class A $0.50 self-deal:");
    console.log("    1. USDC.approve(escrow, 500000)");
    console.log("    2. escrow.createIntent(A, hashPredicate, params, 0x0, 500000, +1h)");
    console.log("    3. escrow.claimIntent(intentId, ciphertext, plaintext) — same wallet for now");
    console.log("  Class B $0.50 happy path:");
    console.log("    1. createIntentB with 10% buyer stake (lock 550000)");
    console.log("    2. acceptIntentB with 20% seller stake (lock 100000)");
    console.log("    3. deliver()");
    console.log("    4. acknowledge() — buyer wallet");
    console.log("  Class C $0.30 stream:");
    console.log("    1. createStreamingIntent(perUnit=100000, maxUnits=3) — lock 300000");
    console.log("    2. claimUnit(0), claimUnit(1), claimUnit(2)");
    console.log("    3. cancelStream() — no balance left to refund");
    console.log("  Class B $0.50 adversarial:");
    console.log("    1. createIntentB / acceptIntentB / deliver");
    console.log("    2. buyer reject(commitHashA)");
    console.log("    3. seller commitRound1(commitHashB)");
    console.log("    4. buyer revealRound2(deliverableA, saltA)");
    console.log("    5. seller revealRound2(deliverableB, saltB) — different deliverable");
    console.log("    6. advance 25h → settleSchelling()");
    console.log("    7. assert burn-to-dEaD balance += 300_000 (both stakes); buyer += price");
    console.log("\nTo execute against Base mainnet, re-run with --execute (irreversible).");
    return;
  }

  // Live execution would go here. For this PR we ship the dry-run scaffold —
  // execution requires Adam's wallet + ~$5 USDC + 0.005 ETH on the
  // deployer address. The full live run is a follow-up "Phase G execute"
  // commit Adam triggers manually.
  console.log("\nLive execution intentionally not implemented in this PR.");
  console.log("Adam runs this against base-sepolia first (with test USDC),");
  console.log("then against base mainnet after verifying staging on-chain.");
  console.log("See docs/CONTRACT_INTERACTION_DIRECT.md.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
