import Fastify, { type FastifyInstance } from "fastify";
import { EVM_USDC, parseUsd, x402Escrow, x402EscrowFastify, type EvmNetworkName } from "@agentpact/x402-escrow";
import { validateCsv, type CsvSchema } from "./csv.js";

export interface DemoConfig {
  sellerAgentId: string;
  apiKey: string;
  offerId: string;
  payTo: string;
  network: EvmNetworkName;
  /** "$0.02"-style decimal string. */
  pricePerCallUsd: string;
  thresholdUsd: string;
  facilitatorUrl?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  logger?: boolean;
}

const MAX_JOBS = 1000;

const jobSchema = {
  type: "object",
  required: ["csv", "schema"],
  properties: {
    csv: { type: "string", maxLength: 200_000 },
    schema: {
      type: "object",
      required: ["columns"],
      properties: {
        columns: {
          type: "array", minItems: 1, maxItems: 100,
          items: {
            type: "object", required: ["name"],
            properties: {
              name: { type: "string", minLength: 1 },
              type: { enum: ["string", "integer", "number", "boolean"] },
              required: { type: "boolean" },
            },
          },
        },
        minRows: { type: "integer", minimum: 0 },
        maxRows: { type: "integer", minimum: 1 },
      },
    },
  },
} as const;

export async function buildServer(cfg: DemoConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: cfg.logger ?? false, bodyLimit: 5 * 1024 * 1024, trustProxy: true });
  const perCall = parseUsd(cfg.pricePerCallUsd);
  const common = {
    sellerAgentId: cfg.sellerAgentId,
    apiKey: cfg.apiKey,
    offerId: cfg.offerId,
    payTo: cfg.payTo,
    network: cfg.network,
    thresholdUsd: cfg.thresholdUsd,
    facilitatorUrl: cfg.facilitatorUrl,
    apiBase: cfg.apiBase,
    fetch: cfg.fetch,
    mimeType: "application/json",
    onError: (err: unknown, ctx: { stage: string; dealId?: string }) => app.log.warn({ err, ...ctx }, "x402-escrow"),
  };

  const single = x402EscrowFastify(x402Escrow({
    ...common,
    price: { amountBaseUnits: perCall },
    description: "Validate one CSV against a column schema",
  }));
  const batch = x402EscrowFastify(x402Escrow({
    ...common,
    // Batch price = jobs × per-call price, in integer base units.
    price: (req) => ({ amountBaseUnits: perCall * BigInt(((req.body as { jobs?: unknown[] })?.jobs ?? []).length || 1) }),
    isBatch: () => true,
    description: "Validate a batch of CSVs (escrow with a receipt available)",
  }));

  app.get("/health", async () => ({
    ok: true,
    service: "demo-x402-seller",
    network: EVM_USDC[cfg.network].caip2,
    pricePerCallUsd: cfg.pricePerCallUsd,
    thresholdUsd: cfg.thresholdUsd,
  }));

  app.get("/", async () => ({
    service: "CSV validation for agents",
    endpoints: {
      "POST /validate-csv": `{ csv, schema } — $${cfg.pricePerCallUsd} per call, plain x402`,
      "POST /validate-csv/batch": `{ jobs: [{ csv, schema }, …] } — $${cfg.pricePerCallUsd} per job; AgentPact escrow offered (retry with X-AGENTPACT-DEAL)`,
    },
    sellerAgentId: cfg.sellerAgentId,
    offerId: cfg.offerId,
    docs: "https://agentpact.xyz/sell",
  }));

  app.post("/validate-csv", { schema: { body: jobSchema }, preHandler: single.preHandler, onSend: single.onSend }, async (req) => {
    const { csv, schema } = req.body as { csv: string; schema: CsvSchema };
    return validateCsv(csv, schema);
  });

  app.post("/validate-csv/batch", {
    schema: { body: { type: "object", required: ["jobs"], properties: { jobs: { type: "array", minItems: 1, maxItems: MAX_JOBS, items: jobSchema } } } },
    preHandler: batch.preHandler,
    onSend: batch.onSend,
  }, async (req) => {
    const { jobs } = req.body as { jobs: Array<{ csv: string; schema: CsvSchema }> };
    return { results: jobs.map((j) => validateCsv(j.csv, j.schema)) };
  });

  return app;
}
