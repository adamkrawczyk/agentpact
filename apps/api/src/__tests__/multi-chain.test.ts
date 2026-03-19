import { describe, it, expect } from "vitest";
import { resolveChainFromAddress, validateWalletAddress, CHAIN_CONFIG } from "../chain.js";

describe("multi-chain wallet support", () => {
  describe("resolveChainFromAddress", () => {
    it("detects EVM address as base by default", () => {
      expect(resolveChainFromAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe("base");
    });

    it("respects explicit arbitrum hint for EVM address", () => {
      expect(resolveChainFromAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "arbitrum")).toBe("arbitrum");
    });

    it("respects explicit polygon hint for EVM address", () => {
      expect(resolveChainFromAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "polygon")).toBe("polygon");
    });

    it("detects Solana base58 address", () => {
      expect(resolveChainFromAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("solana");
    });

    it("Solana hint wins for Solana address", () => {
      expect(resolveChainFromAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "solana")).toBe("solana");
    });

    it("falls back to base for unknown format", () => {
      expect(resolveChainFromAddress("not_a_wallet_address_xyz")).toBe("base");
    });
  });

  describe("validateWalletAddress", () => {
    it("accepts valid EVM address on base", () => {
      expect(validateWalletAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "base")).toEqual({ valid: true });
    });

    it("accepts valid EVM address on arbitrum", () => {
      expect(validateWalletAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "arbitrum")).toEqual({ valid: true });
    });

    it("accepts valid EVM address on polygon", () => {
      expect(validateWalletAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "polygon")).toEqual({ valid: true });
    });

    it("accepts valid Solana address", () => {
      expect(validateWalletAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "solana")).toEqual({ valid: true });
    });

    it("rejects EVM address on solana chain", () => {
      const result = validateWalletAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "solana");
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/Solana/);
    });

    it("rejects Solana address on base chain", () => {
      const result = validateWalletAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "base");
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/EVM/);
    });

    it("rejects malformed EVM address", () => {
      const result = validateWalletAddress("0xSHORT", "base");
      expect(result.valid).toBe(false);
    });
  });

  describe("CHAIN_CONFIG", () => {
    it("has entries for all supported chains", () => {
      expect(CHAIN_CONFIG).toHaveProperty("base");
      expect(CHAIN_CONFIG).toHaveProperty("arbitrum");
      expect(CHAIN_CONFIG).toHaveProperty("polygon");
      expect(CHAIN_CONFIG).toHaveProperty("solana");
    });

    it("each chain config has required fields", () => {
      for (const [chainName, cfg] of Object.entries(CHAIN_CONFIG)) {
        expect(cfg).toHaveProperty("usdcAddress");
        expect(cfg).toHaveProperty("rpcUrl");
        expect(cfg).toHaveProperty("name");
        expect(cfg.name.length).toBeGreaterThan(0);
      }
    });
  });
});
