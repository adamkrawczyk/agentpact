import type { FastifyInstance } from "fastify";

export interface PageMeta {
  description?: string;
  ogImage?: string;
  canonical?: string;
  jsonLd?: object;
}

/** Shared helpers handed to every lane route module (avoids importing index.ts, which boots the server). */
export interface WebContext {
  page(title: string, body: string, meta?: PageMeta): string;
  escapeHtml(value: unknown): string;
  apiBase: string;
}

export type RouteModule = (app: FastifyInstance, ctx: WebContext) => void | Promise<void>;
