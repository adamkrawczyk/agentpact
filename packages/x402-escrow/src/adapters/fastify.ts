import { x402Escrow, type X402EscrowConfig } from "../seller.js";
import type { CoreRequest, Decision } from "../types.js";

// Structural types: no dependency on fastify itself.
interface FastifyLikeRequest {
  method: string;
  url: string;
  protocol?: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface FastifyLikeReply {
  statusCode: number;
  sent?: boolean;
  code(status: number): FastifyLikeReply;
  header(name: string, value: string): FastifyLikeReply;
  send(payload?: unknown): FastifyLikeReply;
}

const pending = new WeakMap<object, Extract<Decision, { action: "serve" }>>();

/**
 * Fastify route hooks:
 *   const pay = x402EscrowFastify({...});
 *   app.post("/validate", { preHandler: pay.preHandler, onSend: pay.onSend }, handler);
 * onSend settles / submits the delivery before the payload is flushed.
 * Streamed payloads are not supported (return a string or Buffer).
 */
export function x402EscrowFastify(config: X402EscrowConfig | ReturnType<typeof x402Escrow>) {
  const core = "handle" in config ? config : x402Escrow(config);
  return {
    async preHandler(request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<void> {
      const host = request.hostname ?? (request.headers.host as string | undefined) ?? "localhost";
      const coreReq: CoreRequest = { method: request.method, url: `${request.protocol ?? "https"}://${host}${request.url}`, headers: request.headers };
      const decision = await core.handle(coreReq);
      if (decision.action === "respond") {
        reply.code(decision.status);
        for (const [k, v] of Object.entries(decision.headers)) reply.header(k, v);
        reply.send(decision.body);
        return;
      }
      pending.set(request, decision);
    },
    async onSend(request: FastifyLikeRequest, reply: FastifyLikeReply, payload: unknown): Promise<unknown> {
      const decision = pending.get(request);
      if (!decision) return payload;
      pending.delete(request);
      if (payload !== null && payload !== undefined && typeof payload !== "string" && !(payload instanceof Uint8Array)) {
        reply.code(500);
        return JSON.stringify({ error: "x402-escrow: streamed responses are not supported; return a string or Buffer" });
      }
      const result = await decision.complete(payload as string | Uint8Array | null, reply.statusCode);
      for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
      if (result.ok) return payload;
      reply.code(result.status);
      reply.header("content-type", "application/json");
      return JSON.stringify(result.body);
    },
  };
}
