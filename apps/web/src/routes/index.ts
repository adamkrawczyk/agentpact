import type { FastifyInstance } from "fastify";
import type { RouteModule, WebContext } from "./types.js";
import { receiptsRoutes } from "./receipts.js";

/**
 * Registry of lane-owned web route modules. To add pages: create
 * `./<module>.ts` exporting a `RouteModule`, import it here, append it below.
 * Never grow ../index.ts with new pages.
 */
export const routeModules: RouteModule[] = [
  receiptsRoutes,
];

export async function registerRouteModules(app: FastifyInstance, ctx: WebContext): Promise<void> {
  for (const register of routeModules) await register(app, ctx);
}
