import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Calls the AgentPact REST API (same helper the core tools use). */
export type ApiFn = (path: string, method: string, body?: unknown, apiKey?: string) => Promise<unknown>;

export interface ToolContext {
  api: ApiFn;
  /** Per-call API key supplied by the agent (falls back to the server key inside `api`). */
  apiKey?: string;
}

/**
 * A lane-owned group of MCP tools. Add new tools as a module in this folder and
 * append it to `toolModules` in ./index.ts — never grow the core switch in
 * ../index.ts. Each module owns its tool definitions AND their handler.
 */
export interface ToolModule {
  /** Stable module id, used in logs and tests. */
  id: string;
  tools: Tool[];
  handle(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}
