// Fee math + buyer burn instructions. EVM calldata vectors come from Foundry:
//   cast calldata "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)" \
//     5000501 6 <gateway32> 0x1c7D…7238 <gateway32> 501 1000 0xdeadbeef
//   cast calldata "approve(address,uint256)" 0x8FE6…2DAA 5000501
// Solana PDAs come from @solana/web3.js findProgramAddressSync (scratch dir,
// not a dependency).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sha256, toBytes } from "viem";
import { applyRate, parseBps, quoteDeposit, quoteForwardedBurn, SOLANA_TOKEN_ACCOUNT_RENT_LAMPORTS } from "../src/cctp/fees.js";
import {
  buildEthereumBurn,
  buildSolanaBurn,
  DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR,
} from "../src/cctp/burn-instructions.js";
import { CCTP, cctpConstants } from "../src/cctp/constants.js";

const TIERS = [
  { finalityThreshold: 1000, minimumFeeBps: "1" },
  { finalityThreshold: 2000, minimumFeeBps: "0" },
];

describe("fee math", () => {
  it("parses fractional bps exactly (1.3 bps = 13/100000)", () => {
    assert.deepEqual(parseBps("1.3"), { num: 13n, den: 100_000n });
    assert.deepEqual(parseBps("0"), { num: 0n, den: 10_000n });
    assert.throws(() => parseBps("1e3"), /invalid bps/);
    assert.throws(() => parseBps("-1"), /invalid bps/);
  });

  it("floor matches what the chain charged live (383 on 2,949,684 at 1.3 bps)", () => {
    assert.equal(applyRate(2_949_684n, parseBps("1.3"), "floor"), 383n);
    assert.equal(applyRate(2_949_684n, parseBps("1.3"), "ceil"), 384n);
  });

  it("quoteDeposit: fast, 1 bps — the net mint covers the price even at the full cap", () => {
    const q = quoteDeposit({ price: 5_000_000n, sourceDomain: 0, speed: "fast", tiers: TIERS });
    assert.equal(q.maxFee, 501n);
    assert.equal(q.burnAmount, 5_000_501n);
    assert.equal(q.minFinalityThreshold, 1000);
    assert.ok(q.burnAmount - q.maxFee >= q.price);
    // the chain charges floor(A·r) <= maxFee
    assert.ok(applyRate(q.burnAmount, parseBps("1"), "floor") <= q.maxFee);
  });

  it("quoteDeposit: fast, 1.3 bps — fixed point reached, never under-funds", () => {
    const tiers = [{ finalityThreshold: 1000, minimumFeeBps: "1.3" }];
    for (const price of [1n, 999n, 2_000_000n, 123_456_789n, 10n ** 12n]) {
      const q = quoteDeposit({ price, sourceDomain: 5, speed: "fast", tiers });
      assert.ok(q.burnAmount - q.maxFee >= price, `price ${price}`);
      assert.ok(applyRate(q.burnAmount, parseBps("1.3"), "ceil") <= q.maxFee, `cap suffices for ${price}`);
    }
    assert.equal(quoteDeposit({ price: 2_000_000n, sourceDomain: 5, speed: "fast", tiers }).maxFee, 261n);
  });

  it("quoteDeposit: standard = zero protocol fee", () => {
    const q = quoteDeposit({ price: 5_000_000n, sourceDomain: 5, speed: "standard", tiers: TIERS });
    assert.equal(q.maxFee, 0n);
    assert.equal(q.burnAmount, 5_000_000n);
  });

  it("labels every line exact or estimate; Ethereum adds L1 gas estimates", () => {
    const eth = quoteDeposit({ price: 5_000_000n, sourceDomain: 0, speed: "fast", tiers: TIERS });
    const sol = quoteDeposit({ price: 5_000_000n, sourceDomain: 5, speed: "fast", tiers: TIERS });
    for (const l of [...eth.lines, ...sol.lines]) assert.equal(typeof l.exact, "boolean");
    assert.ok(eth.lines.some((l) => l.key === "eth_gas_burn" && !l.exact && l.unit === "gas_units"));
    assert.ok(!sol.lines.some((l) => l.unit === "gas_units"));
    assert.equal(eth.lines.find((l) => l.key === "cctp_fee_cap")?.exact, true);
  });

  it("refuses a Base source (not a cross-chain deposit) and a non-positive price", () => {
    assert.throws(() => quoteDeposit({ price: 1n, sourceDomain: 6, speed: "fast", tiers: TIERS }), /ethereum \(0\) or solana \(5\)/);
    assert.throws(() => quoteDeposit({ price: 0n, sourceDomain: 0, speed: "fast", tiers: TIERS }), /price/);
  });

  it("quoteForwardedBurn: maxFee = protocol cap + forwardFee.med, Solana shows rent as estimate", () => {
    const q = quoteForwardedBurn({
      amount: 5_000_000n,
      destinationDomain: 5,
      speed: "standard",
      tiers: TIERS,
      forwardFee: { low: 300_000n, med: 308_810n, high: 340_000n },
    });
    assert.equal(q.maxFee, 308_810n);
    assert.equal(q.minReceived, 5_000_000n - 308_810n);
    const rent = q.lines.find((l) => l.key === "solana_ata_rent");
    assert.equal(rent?.amount, SOLANA_TOKEN_ACCOUNT_RENT_LAMPORTS);
    assert.equal(rent?.exact, false);
    assert.equal(SOLANA_TOKEN_ACCOUNT_RENT_LAMPORTS, 1_488_440n);
  });

  it("quoteForwardedBurn refuses when fees would eat the whole amount", () => {
    assert.throws(
      () => quoteForwardedBurn({ amount: 100_000n, destinationDomain: 0, speed: "fast", tiers: TIERS, forwardFee: { low: 1n, med: 3_672_010n, high: 9n } }),
      /consume the whole amount/,
    );
  });
});

const GATEWAY = "0x9999999999999999999999999999999999999999" as const;

describe("buildEthereumBurn", () => {
  it("produces Foundry-identical approve + depositForBurnWithHook calldata (testnet)", () => {
    const b = buildEthereumBurn({
      network: "testnet",
      amount: 5_000_501n,
      maxFee: 501n,
      minFinalityThreshold: 1000,
      hookData: "0xdeadbeef",
      gateway: GATEWAY,
    });
    assert.equal(b.approve.to, CCTP.testnet.ethereum.usdc);
    assert.equal(b.approve.chainId, 11155111);
    assert.equal(
      b.approve.data,
      "0x095ea7b30000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa00000000000000000000000000000000000000000000000000000000004c4d35",
    );
    assert.equal(b.depositForBurnWithHook.to, CCTP.testnet.ethereum.tokenMessengerV2);
    assert.equal(
      b.depositForBurnWithHook.data,
      "0x779b432d" +
        "00000000000000000000000000000000000000000000000000000000004c4d35" +
        "0000000000000000000000000000000000000000000000000000000000000006" +
        "0000000000000000000000009999999999999999999999999999999999999999" +
        "0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238" +
        "0000000000000000000000009999999999999999999999999999999999999999" +
        "00000000000000000000000000000000000000000000000000000000000001f5" +
        "00000000000000000000000000000000000000000000000000000000000003e8" +
        "0000000000000000000000000000000000000000000000000000000000000100" +
        "0000000000000000000000000000000000000000000000000000000000000004" +
        "deadbeef00000000000000000000000000000000000000000000000000000000",
    );
  });

  it("refuses empty hookData (the contract would revert) and maxFee >= amount", () => {
    const p = { network: "testnet" as const, amount: 10n, maxFee: 1n, minFinalityThreshold: 1000, hookData: "0xab" as const, gateway: GATEWAY };
    assert.throws(() => buildEthereumBurn({ ...p, hookData: "0x" }), /hookData/);
    assert.throws(() => buildEthereumBurn({ ...p, maxFee: 10n }), /maxFee/);
  });
});

describe("buildSolanaBurn", () => {
  const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const EVENT = "Gx1YcW7Qh2CKHbT3xYZJbXyPwKUfR8nQ9Sgc5rr6Wv2b";
  const ix = buildSolanaBurn({
    network: "testnet",
    owner: OWNER,
    messageSentEventData: EVENT,
    amount: 5_000_501n,
    maxFee: 501n,
    minFinalityThreshold: 1000,
    hookData: "0xdeadbeef",
    gateway: GATEWAY,
  });

  it("discriminator = sha256('global:deposit_for_burn_with_hook')[0..8]", () => {
    assert.deepEqual(
      DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR,
      toBytes(sha256(toBytes("global:deposit_for_burn_with_hook"))).slice(0, 8),
    );
  });

  it("targets TokenMessengerMinterV2 with the 18 accounts in IDL order (PDAs match web3.js)", () => {
    assert.equal(ix.programId, "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
    const k = ix.keys;
    assert.equal(k.length, 18);
    assert.deepEqual(k[0], { pubkey: OWNER, isSigner: true, isWritable: false });
    assert.deepEqual(k[1], { pubkey: OWNER, isSigner: true, isWritable: true });
    assert.equal(k[2].pubkey, "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE"); // sender_authority
    assert.equal(k[3].pubkey, "HwpBSwuyVKJi7d9kqqNexc54MS9i4BEDKDVDLeUVjZm8"); // owner's devnet USDC ATA
    assert.equal(k[4].pubkey, "5fV7zrrjKu7SMTqLKTH1nRs5BDa9NNLXQUY3EzVVd7pu"); // denylist(owner)
    assert.equal(k[5].pubkey, "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU"); // message_transmitter @MT
    assert.equal(k[6].pubkey, "AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W"); // token_messenger
    assert.equal(k[7].pubkey, "BwmDYtQ7jFj8ddaTmKa7fz9hyuK9n58mvc8G7DYNcKjM"); // remote_token_messenger "6"
    assert.equal(k[8].pubkey, "E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux"); // token_minter
    assert.equal(k[9].pubkey, "7MwmWTK2R9Na6rnoSAEt5gytFmSZj9WLVdazvxvru9AU"); // local_token(devnet mint)
    assert.equal(k[10].pubkey, cctpConstants("testnet").solana.usdcMint);
    assert.deepEqual(k[11], { pubkey: EVENT, isSigner: true, isWritable: true });
    assert.equal(k[16].pubkey, "6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd"); // __event_authority
    assert.equal(k[17].pubkey, ix.programId);
    assert.deepEqual(
      k.filter((a) => a.isSigner).map((a) => a.pubkey),
      [OWNER, OWNER, EVENT],
      "only owner, rent payer and the event keypair sign",
    );
  });

  it("encodes Borsh params in program field order", () => {
    const d = ix.data;
    const hex = Buffer.from(d).toString("hex");
    const gateway32 = "000000000000000000000000" + "99".repeat(20);
    assert.equal(
      hex,
      "6ff53e83cc6cdf9b" + // discriminator
        "354d4c0000000000" + // amount u64 LE (5_000_501)
        "06000000" + // destination_domain u32 LE
        gateway32 + // mint_recipient
        gateway32 + // destination_caller
        "f501000000000000" + // max_fee u64 LE (501)
        "e8030000" + // min_finality_threshold u32 LE (1000)
        "04000000" + // hook_data len
        "deadbeef",
    );
  });
});
