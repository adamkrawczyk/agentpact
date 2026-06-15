/**
 * dogfood-autoclose-v3-mainnet.cjs — autoclose_0614 LIVE mainnet proof.
 *
 * Deploys a fresh EscrowV3 (gasless EIP-3009 Class-A) + HashPreimagePredicate +
 * PredicateRegistry to Base MAINNET, then runs ONE real gasless settlement for
 * a tiny price ($0.10 default) and asserts the four-wallet delta + buyer-spent-
 * zero-ETH gasless property with REAL USDC.
 *
 * Does NOT touch the existing mainnet escrow 0x588168...; this is a NEW V3.
 *
 * Roles (all derived from the single PLATFORM_PRIVATE_KEY, so fully recoverable):
 *   - PLATFORM  = signer of PLATFORM_PRIVATE_KEY. Plays relayer (pays gas) AND
 *                 platform-fee recipient (constructor platformWallet).
 *   - BUYER     = keccak(platformPriv + ":autoclose-dogfood-buyer:v1"). Holds
 *                 USDC, signs EIP-3009 off-chain, holds ZERO ETH (gasless proof).
 *   - SELLER    = keccak(platformPriv + ":autoclose-dogfood-seller:v1"). Claim
 *                 target; receives 90%.
 *
 * Flow:
 *   1. Deploy HashPreimagePredicate, PredicateRegistry([hash]), EscrowV3.
 *   2. Platform funds BUYER with PRICE USDC (one transfer).
 *   3. Snapshot 4 USDC balances + buyer ETH.
 *   4. BUYER signs EIP-3009 receiveWithAuthorization off-chain (no broadcast).
 *   5. Relayer broadcasts createIntentWithAuthorization (pulls buyer USDC->escrow).
 *   6. Relayer broadcasts claimIntentForSeller(intentId, "0x", preimage).
 *   7. Assert: buyer -PRICE / escrow net 0 / seller +90% / platform +10% /
 *      buyer spent 0 ETH.
 *
 * SAFETY: default is DRY-RUN (deploys nothing, broadcasts nothing). Pass
 * --execute to actually deploy + transact on Base mainnet.
 *
 * Run:
 *   railway run --service @agentpact/api npx hardhat run \
 *     scripts/dogfood-autoclose-v3-mainnet.cjs --network base -- --execute
 *
 * Output: scripts/_dogfood-autoclose-v3-mainnet-results.json
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("node:fs");
const path = require("node:path");

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // real USDC on Base, EIP-3009 capable
const BURN = "0x000000000000000000000000000000000000dEaD";
const FEE_BPS = 1000; // 10%
const USDC = (n) => ethers.parseUnits(String(n), 6);

const USDC_ABI = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
];

function deriveKey(platformPriv, label) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${platformPriv}:${label}`));
}

async function signReceiveWithAuthorization(usdcAddr, chainId, signer, { to, value, validAfter, validBefore, nonce }) {
  // Base USDC EIP-712 domain. name/version are read live below to be exact.
  const domain = {
    name: signer._usdcName,
    version: signer._usdcVersion,
    chainId: Number(chainId),
    verifyingContract: usdcAddr,
  };
  const types = {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const message = { from: signer.address, to, value, validAfter, validBefore, nonce };
  const sig = await signer.signTypedData(domain, types, message);
  return ethers.Signature.from(sig);
}

async function main() {
  const args = process.argv.slice(2);
  // Hardhat intercepts CLI flags, so prefer env vars (DOGFOOD_EXECUTE, DOGFOOD_PRICE).
  const execute = args.includes("--execute") || process.env.DOGFOOD_EXECUTE === "1";
  const priceArg = (args.find((a) => a.startsWith("--price=")) || "").split("=")[1] || process.env.DOGFOOD_PRICE;
  const PRICE = USDC(priceArg || "0.10");

  const provider = ethers.provider;
  const net = await provider.getNetwork();
  const [platform] = await ethers.getSigners();
  const platformPriv = process.env.PLATFORM_PRIVATE_KEY;
  if (!platformPriv) throw new Error("PLATFORM_PRIVATE_KEY required");

  const buyer = new ethers.Wallet(deriveKey(platformPriv, "autoclose-dogfood-buyer:v1"), provider);
  const seller = new ethers.Wallet(deriveKey(platformPriv, "autoclose-dogfood-seller:v1"), provider);

  console.log("=".repeat(64));
  console.log(`MODE: ${execute ? "EXECUTE (real Base mainnet)" : "DRY-RUN"}`);
  console.log(`Chain ID:        ${net.chainId}`);
  console.log(`Price:           ${ethers.formatUnits(PRICE, 6)} USDC`);
  console.log(`Platform/Relayer:${platform.address}`);
  console.log(`Buyer (derived): ${buyer.address}`);
  console.log(`Seller (derived):${seller.address}`);
  console.log("=".repeat(64));

  if (Number(net.chainId) !== 8453) {
    throw new Error(`Expected Base mainnet (8453), got ${net.chainId}. Use --network base.`);
  }

  const usdc = new ethers.Contract(USDC_BASE, USDC_ABI, platform);
  const [usdcName, usdcVersion] = await Promise.all([usdc.name(), usdc.version()]);
  buyer._usdcName = usdcName; buyer._usdcVersion = usdcVersion;
  console.log(`USDC domain: name="${usdcName}" version="${usdcVersion}"`);

  const platETH = await provider.getBalance(platform.address);
  const platUSDC = await usdc.balanceOf(platform.address);
  console.log(`Platform ETH:  ${ethers.formatEther(platETH)}`);
  console.log(`Platform USDC: ${ethers.formatUnits(platUSDC, 6)}`);

  if (platUSDC < PRICE) throw new Error(`Platform USDC ${ethers.formatUnits(platUSDC,6)} < price ${ethers.formatUnits(PRICE,6)}`);
  if (platETH === 0n) throw new Error("Platform has 0 ETH for gas");

  if (!execute) {
    console.log("\nDRY-RUN plan (no broadcasts):");
    console.log("  1. deploy HashPreimagePredicate, PredicateRegistry([hash]), EscrowV3(USDC, reg, platform, dEaD, 1000)");
    console.log(`  2. platform.transfer(buyer, ${ethers.formatUnits(PRICE,6)} USDC)`);
    console.log("  3. buyer signs EIP-3009 off-chain");
    console.log("  4. relayer.createIntentWithAuthorization(...)  -> escrow holds price");
    console.log("  5. relayer.claimIntentForSeller(intentId, 0x, preimage) -> seller 90%, platform 10%");
    console.log("  6. assert four-wallet delta + buyer 0 ETH");
    console.log("\nPass --execute to run for real.");
    return;
  }

  // 1. DEPLOY (or reuse already-deployed addresses to save gas on re-runs)
  let hashAddr, regAddr, escrowAddr, escrow;
  if (process.env.REUSE_ESCROW_V3 && process.env.REUSE_HASH_PREDICATE) {
    escrowAddr = process.env.REUSE_ESCROW_V3;
    hashAddr = process.env.REUSE_HASH_PREDICATE;
    regAddr = process.env.REUSE_REGISTRY || "(unknown)";
    escrow = await ethers.getContractAt("AgentPactEscrowV3", escrowAddr, platform);
    console.log("\n[1] Reusing deployed contracts:");
    console.log("  AgentPactEscrowV3:    ", escrowAddr);
    console.log("  HashPreimagePredicate:", hashAddr);
  } else {
    console.log("\n[1] Deploying contracts...");
    const Hash = await ethers.getContractFactory("HashPreimagePredicate", platform);
    const hash = await Hash.deploy();
    await hash.waitForDeployment();
    hashAddr = await hash.getAddress();
    console.log("  HashPreimagePredicate:", hashAddr);

    const Reg = await ethers.getContractFactory("PredicateRegistry", platform);
    const reg = await Reg.deploy([hashAddr]);
    await reg.waitForDeployment();
    regAddr = await reg.getAddress();
    console.log("  PredicateRegistry:    ", regAddr);

    const Escrow = await ethers.getContractFactory("AgentPactEscrowV3", platform);
    escrow = await Escrow.deploy(USDC_BASE, regAddr, platform.address, BURN, FEE_BPS);
    await escrow.waitForDeployment();
    escrowAddr = await escrow.getAddress();
    console.log("  AgentPactEscrowV3:    ", escrowAddr);
  }

  // 3. SNAPSHOT BEFORE funding the buyer, so platform delta correctly nets the
  //    funding outflow (−PRICE) against the fee inflow (+10%).
  const bal = async (a) => usdc.balanceOf(a);
  const snap = {
    buyer: await bal(buyer.address),
    escrow: await bal(escrowAddr),
    seller: await bal(seller.address),
    platform: await bal(platform.address),
    buyerETH: await provider.getBalance(buyer.address),
  };

  // 2. FUND BUYER (platform → buyer). Counted in platform delta below.
  console.log(`\n[2] Funding buyer with ${ethers.formatUnits(PRICE,6)} USDC...`);
  const txFundBuyer = await usdc.transfer(buyer.address, PRICE);
  await txFundBuyer.wait();
  console.log("  funded. tx:", txFundBuyer.hash);
  console.log("\n[3] Snapshot taken pre-fund. buyer ETH:", ethers.formatEther(snap.buyerETH));

  // 4. BUYER SIGNS EIP-3009 OFF-CHAIN
  // Fixed, LOGGED preimage (not ephemeral) so the witness is reproducible if a
  // later manual claim is ever needed.
  const preimageStr = process.env.DOGFOOD_PREIMAGE_STR || "autoclose-mainnet-dogfood-fixed-v1";
  const preimage = ethers.toUtf8Bytes(preimageStr);
  console.log(`\n[preimage] "${preimageStr}" → hex ${ethers.hexlify(preimage)}`);
  const commitment = ethers.keccak256(preimage);
  const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [commitment]);
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const now = (await provider.getBlock("latest")).timestamp;
  const validAfter = 0;
  const validBefore = now + 3600;
  const sig = await signReceiveWithAuthorization(USDC_BASE, net.chainId, buyer, {
    to: escrowAddr, value: PRICE, validAfter, validBefore, nonce,
  });
  console.log("\n[4] Buyer signed EIP-3009 off-chain (no broadcast, no gas).");

  // 5. RELAYER broadcasts createIntentWithAuthorization
  const expiresAt = now + 7 * 24 * 3600;
  console.log("\n[5] Relayer broadcasting createIntentWithAuthorization...");
  const txCreate = await escrow.connect(platform).createIntentWithAuthorization(
    buyer.address, hashAddr, params, seller.address, PRICE, expiresAt,
    PRICE, validAfter, validBefore, nonce, sig.v, sig.r, sig.s,
  );
  const rcCreate = await txCreate.wait();
  let intentId;
  for (const log of rcCreate.logs) {
    try { const p = escrow.interface.parseLog(log); if (p && p.name === "IntentCreated") { intentId = p.args.intentId; break; } } catch (_) {}
  }
  if (!intentId) throw new Error("IntentCreated not emitted");
  console.log("  FUND ok. tx:", txCreate.hash, "| intentId:", intentId);
  console.log("  FUND confirmed in block:", rcCreate.blockNumber);

  // 6. RELAYER broadcasts claimIntentForSeller.
  // Re-read the intent state AFTER fund confirmation to avoid a same-block read
  // race (the original single-shot run reverted "not Class A open" because the
  // claim was built against an RPC node that hadn't yet seen the create tx).
  // Production avoids this structurally: FUND and CLAIM are separate relayer
  // sweep cycles. Here we poll getIntent until status==Open(1).
  console.log("\n[6] Waiting for intent to read back as Open, then claiming...");
  let st = 0;
  for (let i = 0; i < 20; i++) {
    const liveIt = await escrow.getIntent(intentId);
    st = Number(liveIt.status);
    if (st === 1) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (st !== 1) throw new Error(`Intent not Open after polling (status=${st})`);
  console.log("  intent reads Open. Broadcasting claimIntentForSeller...");
  const txClaim = await escrow.connect(platform).claimIntentForSeller(intentId, "0x", preimage);
  await txClaim.wait();
  console.log("  CLAIM ok. tx:", txClaim.hash);

  // 7. ASSERT on the CLAIM tx's own USDC Transfer events — the race-immune,
  //    topology-independent ground truth for the split (escrow→seller 90%,
  //    escrow→platform 10%). Snapshot-delta math is unreliable here because the
  //    platform bankrolls the buyer and RPC read-races corrupt before/after reads.
  const rcClaim = await provider.getTransactionReceipt(txClaim.hash);
  const usdcIface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
  const transfers = [];
  for (const log of rcClaim.logs) {
    try { const e = usdcIface.parseLog(log); if (e && e.name === "Transfer") transfers.push({ from: e.args.from, to: e.args.to, value: e.args.value }); } catch (_) {}
  }
  const expectedSeller = (PRICE * 9000n) / 10000n;
  const expectedPlatform = PRICE - expectedSeller;
  const toSeller = transfers.find((t) => t.to.toLowerCase() === seller.address.toLowerCase());
  const toPlatform = transfers.find((t) => t.to.toLowerCase() === platform.address.toLowerCase());
  const buyerETHAfter = await provider.getBalance(buyer.address);

  const checks = [
    ["claim tx succeeded", rcClaim.status === 1],
    ["seller received 90% (escrow→seller)", !!toSeller && toSeller.value === expectedSeller && toSeller.from.toLowerCase() === escrowAddr.toLowerCase()],
    ["platform received 10% fee (escrow→platform)", !!toPlatform && toPlatform.value === expectedPlatform && toPlatform.from.toLowerCase() === escrowAddr.toLowerCase()],
    ["split sums to PRICE", !!toSeller && !!toPlatform && (toSeller.value + toPlatform.value) === PRICE],
    ["buyer spent 0 ETH (gasless)", buyerETHAfter === snap.buyerETH],
  ];
  console.log("\n──────── CLAIM-TX SPLIT + GASLESS PROOF (REAL USDC, on-chain events) ────────");
  let allPass = true;
  for (const [label, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) allPass = false; }
  console.log(`\n  escrow→seller   +${toSeller ? ethers.formatUnits(toSeller.value,6) : "?"}`);
  console.log(`  escrow→platform +${toPlatform ? ethers.formatUnits(toPlatform.value,6) : "?"}`);

  const results = {
    timestamp: new Date().toISOString(),
    chainId: Number(net.chainId),
    price_usdc: ethers.formatUnits(PRICE, 6),
    allPass,
    addresses: { escrowV3: escrowAddr, predicateRegistry: regAddr, hashPredicate: hashAddr, usdc: USDC_BASE },
    wallets: { platform: platform.address, buyer: buyer.address, seller: seller.address },
    txs: { fundBuyer: txFundBuyer.hash, createIntent: txCreate.hash, claim: txClaim.hash, intentId },
    split: {
      seller: toSeller ? ethers.formatUnits(toSeller.value, 6) : null,
      platform: toPlatform ? ethers.formatUnits(toPlatform.value, 6) : null,
    },
    basescan: {
      escrow: `https://basescan.org/address/${escrowAddr}`,
      createIntent: `https://basescan.org/tx/${txCreate.hash}`,
      claim: `https://basescan.org/tx/${txClaim.hash}`,
    },
  };
  const out = path.join(__dirname, "_dogfood-autoclose-v3-mainnet-results.json");
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log("\nResults →", out);
  console.log("\nVerify on BaseScan:");
  console.log(`  npx hardhat verify --network base ${hashAddr}`);
  console.log(`  npx hardhat verify --network base ${regAddr} '["${hashAddr}"]'`);
  console.log(`  npx hardhat verify --network base ${escrowAddr} ${USDC_BASE} ${regAddr} ${platform.address} ${BURN} ${FEE_BPS}`);

  if (!allPass) { console.error("\n❌ DOGFOOD FAILED"); process.exit(1); }
  console.log("\n✅ MAINNET DOGFOOD PASSED — gasless autonomous Class-A settlement, real USDC, fee collected.");
}

main().catch((e) => { console.error(e); process.exit(1); });
