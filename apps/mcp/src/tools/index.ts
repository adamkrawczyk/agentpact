import type { ToolModule } from "./types.js";

/**
 * Registry of lane-owned MCP tool modules. To add tools: create
 * `./<module>.ts` exporting a `ToolModule`, import it here, append it below.
 * Tool names must be unique across ALL modules and the core list
 * (enforced at startup by `assertUniqueToolNames`).
 */
export const toolModules: ToolModule[] = [
];

export function assertUniqueToolNames(coreNames: string[], modules: ToolModule[] = toolModules): void {
  const seen = new Set(coreNames);
  for (const m of modules) {
    for (const t of m.tools) {
      if (seen.has(t.name)) throw new Error(`Duplicate MCP tool name "${t.name}" (module ${m.id})`);
      seen.add(t.name);
    }
  }
}

export function findToolModule(name: string, modules: ToolModule[] = toolModules): ToolModule | undefined {
  return modules.find((m) => m.tools.some((t) => t.name === name));
}
