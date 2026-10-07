import { x402Escrow, type X402EscrowConfig } from "../seller.js";

// Structural Hono context: c.req.raw is a Fetch Request, c.res a Fetch Response.
interface HonoLikeContext {
  req: { raw: Request };
  res: Response;
}

/**
 * Hono middleware:  app.post("/validate", x402EscrowHono({...}), handler)
 */
export function x402EscrowHono(config: X402EscrowConfig | ReturnType<typeof x402Escrow>) {
  const core = "handle" in config ? config : x402Escrow(config);
  return async function x402EscrowHonoMiddleware(c: HonoLikeContext, next: () => Promise<void>): Promise<Response | void> {
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const decision = await core.handle({ method: c.req.raw.method, url: c.req.raw.url, headers });
    if (decision.action === "respond") {
      return new Response(JSON.stringify(decision.body), { status: decision.status, headers: decision.headers });
    }
    await next();
    const body = new Uint8Array(await c.res.clone().arrayBuffer());
    const result = await decision.complete(body, c.res.status);
    if (result.ok) {
      const h = new Headers(c.res.headers);
      for (const [k, v] of Object.entries(result.headers)) h.set(k, v);
      c.res = new Response(body, { status: c.res.status, statusText: c.res.statusText, headers: h });
      return;
    }
    c.res = new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { ...result.headers, "Content-Type": "application/json" },
    });
  };
}
