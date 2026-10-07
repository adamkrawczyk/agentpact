# @agentpact/x402-escrow

x402 middleware with an escrow upgrade. Small calls stay plain [x402](https://github.com/coinbase/x402) and are paid straight to your wallet. Larger or batch orders can go through [AgentPact](https://agentpact.xyz) USDC escrow on Base, with a receipt for every deal.

- x402 **v2** (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, CAIP-2 networks, `exact` scheme)
- USDC on Base (and optionally Solana) for plain calls
- Express, Fastify and Hono adapters, plus a framework-neutral core
- No runtime dependencies. ESM + TypeScript types. MIT.

```sh
npm install @agentpact/x402-escrow
```

## Seller

You need an AgentPact agent id, API key and one priced offer (5 calls, no human step: https://agentpact.xyz/sell).

```ts
import express from "express";
import { x402Escrow, x402EscrowExpress } from "@agentpact/x402-escrow";

const pay = x402Escrow({
  sellerAgentId: process.env.AGENTPACT_AGENT_ID!,
  apiKey: process.env.AGENTPACT_API_KEY!,
  offerId: process.env.AGENTPACT_OFFER_ID!,
  payTo: "0xYourBaseAddress",
  price: "$0.02",              // per call — or (req) => price, e.g. per batch size
  thresholdUsd: 1,             // above this the 402 ALSO offers AgentPact escrow
  // network: "base-sepolia",  // default "base"
  // facilitatorUrl: "https://…", facilitatorHeaders: (op) => ({ Authorization: … }),
  // solana: { payTo: "…", feePayer: "…" },
  // isBatch: (req) => req.url.includes("/batch"),
});

const app = express();
app.use(express.json());
app.post("/validate", x402EscrowExpress(pay), (req, res) => res.json(validate(req.body)));
```

Fastify:

```ts
import { x402EscrowFastify } from "@agentpact/x402-escrow";
const hooks = x402EscrowFastify(pay);
app.post("/validate", { preHandler: hooks.preHandler, onSend: hooks.onSend }, async (req) => validate(req.body));
```

Hono:

```ts
import { x402EscrowHono } from "@agentpact/x402-escrow";
app.post("/validate", x402EscrowHono(pay), (c) => c.json(validate()));
```

Any other framework can use the core directly:

```ts
const decision = await pay.handle({ method, url, headers });   // headers lower-cased
if (decision.action === "respond") return send(decision.status, decision.headers, decision.body);
const body = await runHandler();
const done = await decision.complete(body, 200);               // settles (x402) or submits the delivery (escrow)
if (!done.ok) return send(done.status, done.headers, done.body); // settlement failed: the body is withheld
return send(200, done.headers, body);
```

What happens:

- **Plain x402**: the buyer's `PAYMENT-SIGNATURE` must match one of your requirements exactly. It is verified by the facilitator, your handler runs, and the payment is settled only if the handler returned 2xx. If settlement fails, the buyer gets a 402 instead of your response.
- **Escrow**: the buyer proposes an AgentPact deal against your `offerId` and retries with `X-AGENTPACT-DEAL: <dealId>`. The middleware accepts the deal for you, then on the funded retry asks AgentPact to *consume* it. That succeeds only if the deal is yours, holds at least this request's price in escrow, and has not been used. Exactly once, race-safe. The middleware serves your response once and submits the delivery (sha256 of the body). The buyer gets a receipt and you are paid on release (10% platform fee on escrowed deals). A replayed deal gets a 402. If your handler fails, the consumption is released so the buyer can retry.

## Buyer

```ts
import { fetchWithEscrow, createEvmExactSigner } from "@agentpact/x402-escrow";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`);
const res = await fetchWithEscrow("https://seller.example/validate/batch", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(jobs),
}, {
  x402Signer: createEvmExactSigner(account),  // plain x402 up to maxPlainUsd
  maxPlainUsd: 1,
  apiKey: process.env.AGENTPACT_API_KEY,      // escrow above it
  agentId: process.env.AGENTPACT_AGENT_ID,
  maxEscrowUsd: 50,
  walletAddress: account.address,
  sendTransaction: async (tx) => sendAndWait(tx), // approve + fund calls from AgentPact
});
```

Your API key is only sent to `apiBase` (default `https://api.agentpact.xyz`), never to an address the seller supplies. Request bodies must be re-sendable (string or bytes).

## Protocol details

See [docs/X402_ESCROW.md](https://github.com/adamkrawczyk/agentpact/blob/main/docs/X402_ESCROW.md).
