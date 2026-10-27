// Address conversion vectors. Solana expectations were produced with
// @solana/web3.js 1.x + @solana/spl-token 0.4 (`new PublicKey(..).toBytes()`,
// `getAssociatedTokenAddressSync(mint, owner, true)`, `findProgramAddressSync`)
// in a scratch dir — those libraries are NOT dependencies of this package, so
// the vectors check our zero-dependency implementation against the reference.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  base58Decode,
  base58Encode,
  bytes32ToEvmAddress,
  bytes32ToSolanaAddress,
  evmAddressToBytes32,
  findProgramAddress,
  isOnEd25519Curve,
  solanaAddressToBytes32,
  solanaUsdcAta,
} from "../src/cctp/address.js";

const USDC_MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const SOL_VECTORS = [
  {
    owner: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    hex: "0x7e8c088760bfde1dddcf32c17f209b8242ee52aaf131facd88d0ea2c6d0b06f2",
    ataMain: "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B",
    ataDev: "HwpBSwuyVKJi7d9kqqNexc54MS9i4BEDKDVDLeUVjZm8",
  },
  {
    owner: "11111111111111111111111111111111",
    hex: "0x" + "0".repeat(64),
    ataMain: "HJt8Tjdsc9ms9i4WCZEzhzr4oyf3ANcdzXrNdLPFqm3M",
    ataDev: "27SXXCACcdgCZLU5hwYYjCb4j22H4ovDpHooVJpAJtXw",
  },
  {
    owner: "Gx1YcW7Qh2CKHbT3xYZJbXyPwKUfR8nQ9Sgc5rr6Wv2b",
    hex: "0xecf6dd5af0196205b5a9b3f64a60c05941c03325ac33d2f0b84526847acbdd88",
    ataMain: "Hviv5ucAzRvPFbBuJwwXdrxWgtmqATs8i5HZ1mpWwzJU",
    ataDev: "987hQrG5JH66MXR5RctatLFDATginBKt2AL9XoBCrsNM",
  },
];

describe("EVM ↔ bytes32", () => {
  it("left-pads a 20-byte address to 32 bytes (CCTP mintRecipient form)", () => {
    assert.equal(
      evmAddressToBytes32("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
      "0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    );
  });

  it("round-trips to the checksummed address", () => {
    const b = evmAddressToBytes32("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.equal(bytes32ToEvmAddress(b), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("refuses a bytes32 whose top 12 bytes are not zero (it is not an EVM address)", () => {
    assert.throws(() => bytes32ToEvmAddress(`0x${"1".repeat(64)}`), /not an EVM address/);
  });

  it("refuses malformed input", () => {
    assert.throws(() => evmAddressToBytes32("0x1234"), /EVM address/);
    assert.throws(() => bytes32ToEvmAddress("0x1234" as `0x${string}`), /bytes32/);
  });
});

describe("base58", () => {
  it("round-trips leading zero bytes as leading '1's", () => {
    const bytes = new Uint8Array([0, 0, ...new Array(30).fill(7)]);
    const s = base58Encode(bytes);
    assert.equal(s, "112QftUJC9yYkE7xr4ikuFmaHKhLCxkpK5RL1J2QqC2");
    assert.deepEqual(base58Decode(s), bytes);
  });

  it("rejects characters outside the bitcoin alphabet (0, O, I, l)", () => {
    assert.throws(() => base58Decode("0OIl"), /base58/);
  });
});

describe("Solana ↔ bytes32", () => {
  for (const v of SOL_VECTORS) {
    it(`${v.owner.slice(0, 6)}… → ${v.hex.slice(0, 10)}… and back`, () => {
      assert.equal(solanaAddressToBytes32(v.owner), v.hex);
      assert.equal(bytes32ToSolanaAddress(v.hex as `0x${string}`), v.owner);
    });
  }

  it("refuses a base58 string that is not 32 bytes", () => {
    assert.throws(() => solanaAddressToBytes32("abc"), /32 bytes/);
  });
});

describe("Solana PDA + USDC associated token account", () => {
  it("findProgramAddress matches web3.js (seed 'sender_authority')", () => {
    const { address, bump } = findProgramAddress(
      [new TextEncoder().encode("sender_authority")],
      "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    );
    assert.equal(address, "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE");
    assert.equal(bump, 254);
  });

  for (const v of SOL_VECTORS) {
    it(`derives the USDC ATA for ${v.owner.slice(0, 6)}… on mainnet and devnet`, () => {
      assert.equal(solanaUsdcAta(v.owner, USDC_MAINNET_MINT), v.ataMain);
      assert.equal(solanaUsdcAta(v.owner, USDC_DEVNET_MINT), v.ataDev);
    });
  }

  it("a derived PDA is off-curve; a wallet key is on-curve", () => {
    assert.equal(isOnEd25519Curve(base58Decode("45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE")), false);
    assert.equal(isOnEd25519Curve(base58Decode("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")), true);
  });
});
