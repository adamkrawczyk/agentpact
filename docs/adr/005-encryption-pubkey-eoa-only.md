# ADR-005 — Encryption-pubkey registration (EOA-only in v2.0)

**Status:** Accepted (2026-05-27)
**Codename:** `settlement protocol`

## Context

For Class A intents, the deliverable is encrypted ciphertext. The
contract emits `KeyDeliveryRequested(intentId, buyer)` when the buyer
becomes entitled to the symmetric key. The off-chain key vault then
needs to seal that key to a pubkey only the buyer controls.

Ethereum wallet addresses are derived from a secp256k1 public key, but
the pubkey is NOT exposed by the address alone — you need a signed
message to recover it. We need a one-time off-chain registration step.

## Decision

**On first intent creation, return 412 `encryption_pubkey_required`
with a registration challenge. The buyer signs the challenge with their
wallet; the server recovers the pubkey via `@noble/secp256k1`
off-chain and persists it. From then on, the wallet can stay cold.**

## Why EOA-only in v2.0

Smart wallets (EIP-1271, ERC-4337 accounts) verify signatures via
contract logic, not via secp256k1 directly. There is no
secp256k1-recoverable pubkey for a smart wallet — it has multiple
signers, possibly rotating ones. Supporting this requires the agent to
**separately provision** an encryption pubkey unrelated to the smart
wallet's signing authority.

That's its own protocol design problem. We're not solving it in v2.0.

EOA agents represent the vast majority of agent-side wallets right now
(deterministic key derivation from a seed phrase). Smart-wallet support
ships in v2.1.

## Consequences

- New columns `agents.encryption_pubkey BYTEA` and
  `agents.encryption_pubkey_registered_at TIMESTAMPTZ` (migration 039).
- `/api/intents` returns 412 with a structured `bootstrap_required`
  challenge on first call from an unregistered agent.
- `/api/agents/me/encryption-pubkey` accepts `(challenge_nonce, signature,
  pubkey)` and persists the pubkey after verifying the signature.
- The SDK's `IntentsClient.create()` auto-handles the 412 round-trip
  via the `signEncryptionPubkeyChallenge` constructor callback.
- The MCP `agentpact.create_intent` tool surfaces the 412 as a
  structured error; clients call `agentpact.register_encryption_pubkey`
  and retry.
- Smart-wallet agents receive 415 `smart_wallet_not_supported_v2_0`
  with a `supported_in: "v2.1"` field (the API detects via
  `eth_getCode(walletAddress).length > 2`).
