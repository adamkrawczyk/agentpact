// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// A receipt is signed over BYTES, so every issuer and every verifier must turn
// the same payload into the same bytes. JCS pins that: object keys sorted by
// UTF-16 code units, no insignificant whitespace, strings escaped exactly as
// ECMAScript JSON.stringify does, numbers in ECMAScript shortest form.
//
// Receipt payloads deliberately carry money and probabilities as STRINGS, so
// the number branch only ever sees small integers in practice — but it is
// still implemented to spec (Number.prototype.toString is the JCS number
// serialisation for finite doubles) rather than assumed away.

import { createHash } from "node:crypto";

export function canonicalize(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalize: non-finite number at ${path}`);
      // -0 serialises as 0 (JSON.stringify agrees).
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError(`canonicalize: bigint at ${path} — encode base units as a decimal string`);
    case "undefined":
      throw new TypeError(`canonicalize: undefined at ${path}`);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => serialize(v, `${path}[${i}]`)).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units — exactly what RFC 8785 §3.2.3 requires.
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported ${typeof value} at ${path}`);
  }
}

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The receipt's content address: sha256(JCS(payload)), lowercase hex. */
export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalize(payload));
}
