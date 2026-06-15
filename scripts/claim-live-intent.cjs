/**
 * claim-live-intent.cjs — finish the one live mainnet intent left Open by the
 * dogfood run (the CLAIM step reverted on a bad ad-hoc decode; this uses the
 * real compiled ABI so encoding is correct).
 *
 * Reads the intent via the compiled EscrowV3 ABI, prints true state, then
 * broadcasts claimIntentForSeller with the original preimage IF the preimage
 * is provided (DOGFOOD_PREIMAGE env) — otherwise just reports state.
 *
 * The preimage from the original run was ephemeral (Date.now()-based), so it is
 * LOST. Therefore the predicate witness cannot be reproduced and the intent
 * cannot be claimed. It will instead be refundable to the buyer after expiry.
 * This script's job now: read TRUE state, and (if expired) refund to buyer so
 * the 0.10 USDC returns and nothing is stranded.
 *
 * Run: railway run --service @agentpact/api npx hardhat run scripts/claim-live-intent.cjs --network base
 */
const hre = require("hardhat");
const { ethers } = hre;

const ESCROW = "0x1cc92210988522a06d9950241B32750f82005eb7";
const INTENT_ID = "0xc47d408cc984784ffd5410a05fbb9fb615b7cef232d9ecbcd47e3f7c5a9fcff6";
const STATUS = ["None","Open","ClaimedA","CancelledByExpiry","AwaitingAccept","Accepted","Delivered","Acknowledged","Round1Commit","Round2Reveal","SettledSchelling","Streaming","StreamCancelled"];

async function main() {
  const [platform] = await ethers.getSigners();
  const escrow = await ethers.getContractAt("AgentPactEscrowV3", ESCROW, platform);

  const it = await escrow.getIntent(INTENT_ID);
  console.log("=== LIVE INTENT STATE (real ABI) ===");
  console.log("class       :", Number(it.class), "(0=ClassA)");
  console.log("status      :", Number(it.status), "=", STATUS[Number(it.status)]);
  console.log("buyer       :", it.buyer);
  console.log("sellerTarget:", it.sellerTarget);
  console.log("verifier    :", it.verifier);
  console.log("maxPrice    :", ethers.formatUnits(it.maxPrice, 6), "USDC");
  const now = Math.floor(Date.now() / 1000);
  console.log("expiresAt   :", Number(it.expiresAt), "| now:", now, "| expired?", now >= Number(it.expiresAt));

  const preimageHex = process.env.DOGFOOD_PREIMAGE;
  if (Number(it.status) === 1 && preimageHex) {
    console.log("\n[CLAIM] attempting claimIntentForSeller with provided preimage...");
    const tx = await escrow.claimIntentForSeller(INTENT_ID, "0x", preimageHex);
    await tx.wait();
    console.log("  CLAIM ok. tx:", tx.hash);
  } else if (Number(it.status) === 1 && now >= Number(it.expiresAt)) {
    console.log("\n[REFUND] intent expired + open → refunding 0.10 USDC to buyer...");
    const tx = await escrow.refundExpiredIntent(INTENT_ID);
    await tx.wait();
    console.log("  REFUND ok. tx:", tx.hash);
  } else if (Number(it.status) === 1) {
    console.log("\nIntent OPEN but not yet expired and no preimage available.");
    console.log("Preimage from the original run was ephemeral and is lost; cannot reproduce the witness.");
    console.log("Funds are safe in escrow and refundable to buyer after expiresAt.");
  } else {
    console.log("\nIntent not in Open state; nothing to do.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
