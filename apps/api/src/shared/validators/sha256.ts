import { z } from "zod";
import type { Checker } from "./types.js";

export const sha256SpecSchema = z.object({
  type: z.literal("sha256"),
  /** Expected SHA-256 of the artifact bytes, hex (64 chars). */
  sha256: z.string().regex(/^(?:sha256:)?[0-9a-fA-F]{64}$/, "sha256 must be 64 hex chars"),
  maxBytes: z.number().int().positive().max(100 * 1024 * 1024).default(50 * 1024 * 1024),
  artifactIndex: z.number().int().min(0).max(49).default(0),
}).strict();
export type Sha256Spec = z.infer<typeof sha256SpecSchema>;

/**
 * The digest itself is computed by the runner for every validator; this
 * checker only compares, so it needs the runner's final digest.
 */
export function createSha256Checker(spec: Sha256Spec, digest: () => string): Checker {
  const expected = spec.sha256.replace(/^sha256:/, "").toLowerCase();
  return {
    update() { /* hashing happens in the runner */ },
    finish() {
      const actual = digest();
      return actual === expected
        ? { passed: true, reasons: [] }
        : { passed: false, reasons: [`sha256 mismatch: expected ${expected}, got ${actual}`] };
    },
  };
}
