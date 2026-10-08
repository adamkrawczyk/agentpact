import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import type { Checker } from "./types.js";

// JSON Schema draft 2020-12 via ajv. Buyer-authored schemas are untrusted:
//  - size-capped;
//  - regex keywords (`pattern`, `patternProperties`) and `$data` are refused,
//    because ajv runs them with the native RegExp engine on the API's event
//    loop and a catastrophic-backtracking pattern would be a cheap DoS;
//  - remote `$ref`s are never loaded (no loadSchema is configured).
const MAX_SCHEMA_CHARS = 64 * 1024;
const FORBIDDEN_KEYWORDS = new Set(["pattern", "patternProperties", "$data"]);

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const compiled = new Map<string, ValidateFunction>();

function findForbidden(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findForbidden(node[i], `${path}/${i}`);
      if (hit) return hit;
    }
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYWORDS.has(k)) return `${path}/${k}`;
      const hit = findForbidden(v, `${path}/${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = compiled.get(key);
  if (!fn) {
    fn = ajv.compile(schema);
    if (compiled.size > 500) compiled.clear();
    compiled.set(key, fn);
  }
  return fn;
}

export const jsonSchemaSpecSchema = z.object({
  type: z.literal("json-schema"),
  schema: z.record(z.unknown()),
  maxBytes: z.number().int().positive().max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  artifactIndex: z.number().int().min(0).max(49).default(0),
}).strict().superRefine((spec, ctx) => {
  if (JSON.stringify(spec.schema).length > MAX_SCHEMA_CHARS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schema"], message: `schema larger than ${MAX_SCHEMA_CHARS} chars` });
    return;
  }
  const forbidden = findForbidden(spec.schema, "");
  if (forbidden) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schema"], message: `keyword at ${forbidden} is not allowed in validator schemas (regex keywords and $data are refused)` });
    return;
  }
  try {
    compile(spec.schema);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schema"], message: `invalid JSON Schema: ${(e as Error).message}` });
  }
});
export type JsonSchemaSpec = z.infer<typeof jsonSchemaSpecSchema>;

const describe = (e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`;

export function createJsonSchemaChecker(spec: JsonSchemaSpec): Checker {
  const chunks: Uint8Array[] = [];
  return {
    update(chunk) { chunks.push(chunk); },
    finish() {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return { passed: false, reasons: ["artifact is not valid UTF-8"] };
      }
      let data: unknown;
      try {
        data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      } catch (e) {
        return { passed: false, reasons: [`artifact is not valid JSON: ${(e as Error).message.slice(0, 200)}`] };
      }
      const validate = compile(spec.schema);
      if (validate(data)) return { passed: true, reasons: [] };
      return { passed: false, reasons: (validate.errors ?? []).slice(0, 20).map(describe) };
    },
  };
}
