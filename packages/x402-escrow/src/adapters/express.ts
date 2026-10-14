import { x402Escrow, type X402EscrowConfig } from "../seller.js";
import type { CoreRequest } from "../types.js";

// Structural types: no runtime or type dependency on express itself.
interface ExpressLikeRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  protocol?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  get?(name: string): string | undefined;
}
interface ExpressLikeResponse {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string): unknown;
  removeHeader?(name: string): unknown;
  // `any` mirrors Node's ServerResponse.write/end overloads, which this
  // structural type must stay assignable from.
  write(chunk: any, ...args: any[]): boolean;
  end(chunk?: any, ...args: any[]): unknown;
}
type Next = (err?: unknown) => void;

export function expressRequestUrl(req: ExpressLikeRequest): string {
  const host = req.get?.("host") ?? (req.headers.host as string | undefined) ?? "localhost";
  return `${req.protocol ?? "https"}://${host}${req.originalUrl ?? req.url ?? "/"}`;
}

/**
 * Express middleware. Put it in front of the paid route:
 *   app.post("/validate", x402EscrowExpress({...}), handler)
 * The handler's response is buffered and only flushed after the payment is
 * settled (x402) or the delivery submitted (escrow).
 */
export function x402EscrowExpress(config: X402EscrowConfig | ReturnType<typeof x402Escrow>) {
  const core = "handle" in config ? config : x402Escrow(config);
  return async function x402EscrowMiddleware(req: ExpressLikeRequest, res: ExpressLikeResponse, next: Next): Promise<void> {
    const coreReq: CoreRequest = { method: req.method, url: expressRequestUrl(req), headers: req.headers, body: req.body };
    let decision;
    try {
      decision = await core.handle(coreReq);
    } catch (err) {
      next(err);
      return;
    }
    if (decision.action === "respond") {
      res.statusCode = decision.status;
      for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
      res.end(JSON.stringify(decision.body));
      return;
    }

    const chunks: Uint8Array[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const collect = (chunk: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === "function") return;
      if (typeof chunk === "string") chunks.push(new TextEncoder().encode(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(chunk);
      else chunks.push(new TextEncoder().encode(String(chunk)));
    };
    res.write = (chunk: unknown) => { collect(chunk); return true; };
    res.end = ((chunk?: unknown) => {
      collect(chunk);
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { body.set(c, off); off += c.byteLength; }
      res.write = origWrite;
      res.end = origEnd;
      decision.complete(body, res.statusCode).then((result) => {
        if (result.ok) {
          for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
          origEnd(body);
        } else {
          res.statusCode = result.status;
          res.removeHeader?.("Content-Length");
          for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
          res.setHeader("Content-Type", "application/json");
          origEnd(JSON.stringify(result.body));
        }
      }, () => {
        // complete() reports through onError; the paid body is never flushed here.
        res.statusCode = 500;
        res.removeHeader?.("Content-Length");
        origEnd(JSON.stringify({ error: "payment_completion_failed" }));
      });
      return res;
    }) as ExpressLikeResponse["end"];
    next();
  };
}
