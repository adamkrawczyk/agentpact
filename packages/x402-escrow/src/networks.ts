// USDC per network. Addresses and EIP-712 domain names match the x402
// reference implementation's default stablecoins
// (coinbase/x402 typescript/packages/mechanisms/evm/src/shared/defaultAssets.ts)
// and the SVM exact scheme (specs/schemes/exact/scheme_exact_svm.md).

export type EvmNetworkName = "base" | "base-sepolia";
export type SolanaNetworkName = "solana" | "solana-devnet";

export interface EvmUsdc {
  caip2: string;
  chainId: number;
  asset: string;
  /** EIP-712 domain of the USDC contract (EIP-3009 transferWithAuthorization). */
  name: string;
  version: string;
}

export const EVM_USDC: Record<EvmNetworkName, EvmUsdc> = {
  base: { caip2: "eip155:8453", chainId: 8453, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
  "base-sepolia": { caip2: "eip155:84532", chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" },
};

export const SOLANA_USDC: Record<SolanaNetworkName, { caip2: string; asset: string }> = {
  solana: { caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  "solana-devnet": { caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
};
