# @agentpact/receipts

AgentPact Receipt v1 (`apr-1`): the one implementation of receipt canonicalisation, signing and verification, shared by the issuer (`apps/relayer-daemon/src/receipt-sweeper.ts`) and the verifier (`apps/api/src/routes/receipts.ts`). Zero runtime dependencies (`node:crypto` only).

- `canonicalize(value)`: RFC 8785 JSON Canonicalization Scheme
- `payloadHash(payload)`: sha256 of the canonical bytes, lowercase hex
- `signerFromSeed(seedB64, keyId)` / `signReceipt` / `verifyReceipt`: ed25519 over the canonical bytes. The seed is a base64 32-byte ed25519 seed.
- `classifyOutcome` / `buildReceiptPayload`: pure builder from deal facts. Returns `null` for unfunded or non-terminal deals.
- `merkleRoot` / `merkleProof` / `verifyMerkleProof`: RFC 6962 tree over payload hashes, used for daily anchoring

The format is documented in `docs/WHITEPAPER.md` §5.6.

```bash
npm run build -w @agentpact/receipts   # also run automatically by the api / relayer prebuild
npm test -w @agentpact/receipts
```
