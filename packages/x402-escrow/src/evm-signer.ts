import { randomHex } from "./codec.js";
import type { PaymentPayload, PaymentRequirements } from "./types.js";

/**
 * Minimal account shape — a viem `LocalAccount` / `WalletClient.account`
 * satisfies it, as does any wallet exposing EIP-712 signing.
 */
export interface TypedDataSigner {
  address: string;
  signTypedData(args: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
}

export type X402Signer = (requirements: PaymentRequirements) => Promise<PaymentPayload>;

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/**
 * x402 `exact` scheme on EVM (EIP-3009 transferWithAuthorization), per
 * specs/schemes/exact/scheme_exact_evm.md: the buyer signs an authorization
 * for exactly `amount` to `payTo`; the facilitator submits it.
 */
export function createEvmExactSigner(
  account: TypedDataSigner,
  opts: { now?: () => number } = {},
): X402Signer {
  const now = opts.now ?? Date.now;
  return async (req) => {
    const m = /^eip155:(\d+)$/.exec(req.network);
    if (!m || req.scheme !== "exact") throw new Error(`EVM exact signer cannot pay ${req.scheme} on ${req.network}`);
    const name = req.extra?.name;
    const version = req.extra?.version;
    if (typeof name !== "string" || typeof version !== "string") {
      throw new Error("EVM exact requirements must carry extra.name and extra.version (the token's EIP-712 domain)");
    }
    const t = Math.floor(now() / 1000);
    const authorization = {
      from: account.address,
      to: req.payTo,
      value: req.amount,
      validAfter: String(t - 600),
      validBefore: String(t + req.maxTimeoutSeconds),
      nonce: `0x${randomHex(32)}`,
    };
    const signature = await account.signTypedData({
      domain: { name, version, chainId: Number(m[1]), verifyingContract: req.asset },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    return { x402Version: 2, accepted: req, payload: { signature, authorization } };
  };
}
