// Deterministic delivery validators for data deals (M3).
//
// A buyer puts `{ "validator": { "type": "<format>", ... } }` into a need's or
// milestone's acceptanceCriteria (next to plain-text criteria). When the
// seller submits a delivery, the API fetches the artifact (SSRF-guarded) and
// runs every validator BEFORE any LLM judge sees the deal:
//   pass → delivery 'auto-verified'; eligible for auto-accept through the
//          existing settlement path (sweeper → /fulfillment/auto-complete);
//   fail → delivery 'rejected' with the reasons recorded; the milestone stays
//          open so the seller can resubmit.
//
// Extensible by format: registerValidator({ type, schema, create }).

import { createHash } from "node:crypto";
import { z } from "zod";
import { createCsvChecker, csvSpecSchema } from "./csv.js";
import { createJsonSchemaChecker, jsonSchemaSpecSchema } from "./json-schema.js";
import { createSha256Checker, sha256SpecSchema } from "./sha256.js";
import { ArtifactFetchError, fetchArtifact, type FetchArtifactOptions } from "./fetch-artifact.js";
import type { Checker, CheckOutcome, ValidatorVerdict } from "./types.js";

export type { Checker, CheckOutcome, ValidatorVerdict } from "./types.js";
export { ArtifactFetchError, fetchArtifact, isPublicAddress, assertFetchableUrl } from "./fetch-artifact.js";

interface BaseSpec { type: string; maxBytes: number; artifactIndex: number }

export interface ValidatorDefinition<S extends BaseSpec = BaseSpec> {
  type: string;
  schema: z.ZodType<S, z.ZodTypeDef, unknown>;
  /** `digest` returns the artifact's final sha256 hex (valid inside finish()). */
  create(spec: S, digest: () => string): Checker;
}

const registry = new Map<string, ValidatorDefinition>();

export function registerValidator<S extends BaseSpec>(def: ValidatorDefinition<S>): void {
  if (registry.has(def.type)) throw new Error(`validator "${def.type}" already registered`);
  registry.set(def.type, def as unknown as ValidatorDefinition);
}

export function validatorTypes(): string[] {
  return [...registry.keys()];
}

registerValidator({ type: "csv-schema", schema: csvSpecSchema, create: (spec) => createCsvChecker(spec) });
registerValidator({ type: "json-schema", schema: jsonSchemaSpecSchema, create: (spec) => createJsonSchemaChecker(spec) });
registerValidator({ type: "sha256", schema: sha256SpecSchema, create: (spec, digest) => createSha256Checker(spec, digest) });

/** `{ type, ... }` — validated against the registered format's schema. */
export const validatorSpecSchema = z.object({ type: z.string() }).passthrough().transform((value, ctx) => {
  const def = registry.get(value.type);
  if (!def) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"], message: `unknown validator type "${value.type}" (known: ${validatorTypes().join(", ")})` });
    return z.NEVER;
  }
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }
  return parsed.data;
});
export type ValidatorSpec = BaseSpec & Record<string, unknown>;

/** One acceptance criterion: free text, or a machine-checkable validator. */
export const acceptanceCriterionSchema = z.union([
  z.string(),
  z.object({ validator: validatorSpecSchema }).strict(),
]);

/**
 * Validator specs inside stored acceptance criteria (JSONB). Stored rows went
 * through acceptanceCriterionSchema on write; anything that no longer parses
 * (e.g. a format later unregistered) is reported, never silently skipped.
 */
export function extractValidatorSpecs(criteria: unknown): { specs: ValidatorSpec[]; invalid: string[] } {
  const specs: ValidatorSpec[] = [];
  const invalid: string[] = [];
  // milestones.acceptance_criteria is written double-encoded by the deal
  // writers (a JSONB *string* holding the array) — accept both shapes.
  let value = criteria;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = []; }
  }
  const list = Array.isArray(value) ? value : [];
  for (const c of list) {
    if (!c || typeof c !== "object" || !("validator" in c)) continue;
    const parsed = validatorSpecSchema.safeParse((c as { validator: unknown }).validator);
    if (parsed.success) specs.push(parsed.data as ValidatorSpec);
    else invalid.push(parsed.error.issues.map((i) => i.message).join("; "));
  }
  return { specs, invalid };
}

export interface RunOptions extends Omit<FetchArtifactOptions, "maxBytes"> {}

/**
 * Options the delivery route passes to the runner. Empty in production (real
 * DNS + the public-address policy). Tests point it at a local TLS server;
 * nothing reachable from a request can change it.
 */
export const validatorRuntime: { options: RunOptions } = { options: {} };

export async function runValidator(
  spec: ValidatorSpec,
  artifacts: Array<{ url?: string }>,
  opts: RunOptions = {},
): Promise<ValidatorVerdict> {
  const def = registry.get(spec.type);
  const base = { type: spec.type, artifactIndex: spec.artifactIndex, bytes: 0, sha256: null as string | null };
  if (!def) return { ...base, url: null, passed: false, reasons: [`unknown validator type "${spec.type}"`] };
  const url = artifacts[spec.artifactIndex]?.url;
  if (!url) return { ...base, url: null, passed: false, reasons: [`no artifact at index ${spec.artifactIndex}`] };

  const hash = createHash("sha256");
  let digest: string | null = null;
  const checker = def.create(spec, () => digest ?? (digest = hash.digest("hex")));
  // A content error (bad UTF-8, runaway field) fails the CONTENT, not the
  // fetch: keep hashing, stop feeding the checker, report it as such.
  let contentError: string | null = null;
  const contentFailed = (e: unknown) => { contentError ??= (e as Error).message; };
  try {
    const { bytes } = await fetchArtifact(url, { ...opts, maxBytes: spec.maxBytes }, (chunk) => {
      hash.update(chunk);
      if (contentError !== null) return;
      try { checker.update(chunk); } catch (e) { contentFailed(e); }
    });
    if (digest === null) digest = hash.digest("hex");
    let outcome: CheckOutcome | null = null;
    if (contentError === null) {
      try { outcome = checker.finish(); } catch (e) { contentFailed(e); }
    }
    if (!outcome) outcome = { passed: false, reasons: [`artifact content rejected: ${contentError}`] };
    return { ...base, url, bytes, sha256: digest, ...outcome };
  } catch (e) {
    const reason = e instanceof ArtifactFetchError ? `artifact fetch refused (${e.code}): ${e.message}` : `artifact rejected: ${(e as Error).message}`;
    return { ...base, url, passed: false, reasons: [reason] };
  }
}

export async function runDeliveryValidators(
  specs: ValidatorSpec[],
  artifacts: Array<{ url?: string }>,
  opts: RunOptions = {},
): Promise<{ passed: boolean; verdicts: ValidatorVerdict[] }> {
  const verdicts: ValidatorVerdict[] = [];
  // Sequential: bounded concurrent outbound fetches per delivery.
  for (const spec of specs) verdicts.push(await runValidator(spec, artifacts, opts));
  return { passed: verdicts.every((v) => v.passed), verdicts };
}
