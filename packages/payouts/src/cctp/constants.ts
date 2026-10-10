// CCTP v2 constants. Every value is cited; verified 2026-10-07.
//
// Domains:          https://developers.circle.com/cctp/concepts/supported-chains-and-domains
// EVM contracts:    https://developers.circle.com/cctp/references/contract-addresses
// USDC addresses:   https://developers.circle.com/stablecoins/usdc-contract-addresses
// Solana programs:  https://developers.circle.com/cctp/references/solana-programs
//                   (declare_id! in circlefin/solana-cctp-contracts programs/v2/*/src/lib.rs)
// Iris hosts:       https://developers.circle.com/cctp/references/technical-guide
// Finality:         circlefin/evm-cctp-contracts src/v2/FinalityThresholds.sol

import type { Address } from "viem";

export const CCTP_DOMAIN = { ethereum: 0, solana: 5, base: 6 } as const;
export type CctpChain = keyof typeof CCTP_DOMAIN;
export type CctpDomain = (typeof CCTP_DOMAIN)[CctpChain];

export function chainForDomain(domain: number): CctpChain {
  for (const [chain, d] of Object.entries(CCTP_DOMAIN)) if (d === domain) return chain as CctpChain;
  throw new Error(`unsupported CCTP domain ${domain}`);
}

/** minFinalityThreshold values: ≤1000 is Fast (confirmed), >1000 is Standard (finalized). */
export const FINALITY = { fast: 1000, standard: 2000 } as const;
export type TransferSpeed = keyof typeof FINALITY;

export type CctpNetwork = "mainnet" | "testnet";

export interface EvmCctpChain {
  chainId: number;
  domain: CctpDomain;
  usdc: Address;
  tokenMessengerV2: Address;
  messageTransmitterV2: Address;
  tokenMinterV2: Address;
}

export interface SolanaCctp {
  domain: typeof CCTP_DOMAIN.solana;
  /** USDC mint (base58). */
  usdcMint: string;
  messageTransmitterV2: string;
  tokenMessengerMinterV2: string;
}

export interface CctpNetworkConstants {
  network: CctpNetwork;
  irisBaseUrl: string;
  ethereum: EvmCctpChain;
  base: EvmCctpChain;
  solana: SolanaCctp;
}

// Solana CCTP v2 program IDs are the same on mainnet and devnet.
const SOLANA_MESSAGE_TRANSMITTER_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
const SOLANA_TOKEN_MESSENGER_MINTER_V2 = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";

export const CCTP: Record<CctpNetwork, CctpNetworkConstants> = {
  mainnet: {
    network: "mainnet",
    irisBaseUrl: "https://iris-api.circle.com",
    ethereum: {
      chainId: 1,
      domain: 0,
      usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      tokenMinterV2: "0xfd78EE919681417d192449715b2594ab58f5D002",
    },
    base: {
      chainId: 8453,
      domain: 6,
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      tokenMinterV2: "0xfd78EE919681417d192449715b2594ab58f5D002",
    },
    solana: {
      domain: 5,
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      messageTransmitterV2: SOLANA_MESSAGE_TRANSMITTER_V2,
      tokenMessengerMinterV2: SOLANA_TOKEN_MESSENGER_MINTER_V2,
    },
  },
  testnet: {
    network: "testnet",
    irisBaseUrl: "https://iris-api-sandbox.circle.com",
    ethereum: {
      chainId: 11155111, // Sepolia
      domain: 0,
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
      tokenMinterV2: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
    },
    base: {
      chainId: 84532, // Base Sepolia
      domain: 6,
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
      tokenMinterV2: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
    },
    solana: {
      domain: 5, // Devnet
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      messageTransmitterV2: SOLANA_MESSAGE_TRANSMITTER_V2,
      tokenMessengerMinterV2: SOLANA_TOKEN_MESSENGER_MINTER_V2,
    },
  },
};

export function cctpConstants(network: CctpNetwork): CctpNetworkConstants {
  const c = CCTP[network];
  if (!c) throw new Error(`unknown CCTP network ${String(network)}`);
  return c;
}
