import { z } from "zod";
import type { Checker } from "./types.js";

export const CSV_COLUMN_TYPES = ["string", "integer", "number", "boolean", "date"] as const;

export const csvSpecSchema = z.object({
  type: z.literal("csv-schema"),
  columns: z.array(z.object({
    name: z.string().min(1).max(200),
    type: z.enum(CSV_COLUMN_TYPES).default("string"),
    /** Every row must have a non-empty value. */
    required: z.boolean().default(false),
  }).strict()).min(1).max(200),
  minRows: z.number().int().min(0).optional(),
  maxRows: z.number().int().min(1).optional(),
  maxBytes: z.number().int().positive().max(50 * 1024 * 1024).default(10 * 1024 * 1024),
  delimiter: z.enum([",", ";", "\t", "|"]).default(","),
  /** Columns not listed in `columns` are allowed unless false. */
  allowExtraColumns: z.boolean().default(true),
  artifactIndex: z.number().int().min(0).max(49).default(0),
}).strict().refine((s) => s.minRows === undefined || s.maxRows === undefined || s.minRows <= s.maxRows, {
  message: "minRows must be ≤ maxRows",
}).refine((s) => new Set(s.columns.map((c) => c.name)).size === s.columns.length, {
  message: "column names must be unique",
});
export type CsvSpec = z.infer<typeof csvSpecSchema>;

const TYPE_CHECKS: Record<(typeof CSV_COLUMN_TYPES)[number], (v: string) => boolean> = {
  string: () => true,
  integer: (v) => /^[+-]?\d+$/.test(v),
  number: (v) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v),
  boolean: (v) => /^(?:true|false|1|0)$/i.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v.replace(" ", "T"))),
};

const MAX_REASONS = 20;
/** A single field longer than this is treated as malformed (unterminated quote swallowing the file). */
const MAX_FIELD_CHARS = 1_000_000;

/**
 * Streaming RFC 4180 parser: quoted fields, "" escapes, CRLF/LF, a leading
 * BOM. Memory stays O(one row) regardless of file size.
 */
export function createCsvChecker(spec: CsvSpec): Checker {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reasons: string[] = [];
  const fail = (r: string) => { if (reasons.length < MAX_REASONS) reasons.push(r); };

  let header: string[] | null = null;
  let colIndex: Array<{ idx: number; type: (typeof CSV_COLUMN_TYPES)[number]; required: boolean; name: string }> = [];
  let rows = 0;
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteJustClosed = false;
  let pendingCR = false;
  let first = true;
  let fatal = false;

  function endRow() {
    row.push(field);
    field = "";
    const r = row;
    row = [];
    if (r.length === 1 && r[0] === "") return; // blank line
    if (!header) {
      header = r.map((h) => h.trim());
      const missing = spec.columns.filter((c) => !header!.includes(c.name)).map((c) => c.name);
      if (missing.length) { fail(`missing required column(s): ${missing.join(", ")}`); fatal = true; }
      if (!spec.allowExtraColumns) {
        const extra = header.filter((h) => !spec.columns.some((c) => c.name === h));
        if (extra.length) fail(`unexpected column(s): ${extra.join(", ")}`);
      }
      colIndex = spec.columns.map((c) => ({ idx: header!.indexOf(c.name), type: c.type, required: c.required, name: c.name }));
      return;
    }
    rows++;
    if (fatal) return;
    if (r.length !== header.length) fail(`row ${rows}: ${r.length} field(s), header has ${header.length}`);
    for (const c of colIndex) {
      if (c.idx < 0) continue;
      const v = (r[c.idx] ?? "").trim();
      if (v === "") {
        if (c.required) fail(`row ${rows}: column "${c.name}" is empty`);
        continue;
      }
      if (!TYPE_CHECKS[c.type](v)) fail(`row ${rows}: column "${c.name}" value ${JSON.stringify(v.slice(0, 40))} is not ${c.type}`);
    }
  }

  function consume(text: string) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (pendingCR) {
        pendingCR = false;
        if (ch === "\n") continue;
      }
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; continue; }
          if (i + 1 === text.length) { inQuotes = false; quoteJustClosed = true; continue; } // may be "" split across chunks
          inQuotes = false;
          continue;
        }
        field += ch;
        if (field.length > MAX_FIELD_CHARS) throw new Error("field too long (unterminated quote?)");
        continue;
      }
      if (quoteJustClosed) {
        quoteJustClosed = false;
        if (ch === '"') { field += '"'; inQuotes = true; continue; } // "" escape spanning a chunk boundary
      }
      if (ch === '"' && field === "") { inQuotes = true; continue; }
      if (ch === spec.delimiter) { row.push(field); field = ""; continue; }
      if (ch === "\n") { endRow(); continue; }
      if (ch === "\r") { endRow(); pendingCR = true; continue; }
      field += ch;
      if (field.length > MAX_FIELD_CHARS) throw new Error("field too long");
    }
  }

  return {
    update(chunk: Uint8Array) {
      let text = decoder.decode(chunk, { stream: true });
      if (first) { first = false; if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); }
      consume(text);
    },
    finish() {
      consume(decoder.decode());
      if (inQuotes) fail("unterminated quoted field at end of file");
      else if (field !== "" || row.length > 0) endRow();
      if (!header) fail("file is empty (no header row)");
      if (spec.minRows !== undefined && rows < spec.minRows) fail(`${rows} data row(s), at least ${spec.minRows} required`);
      if (spec.maxRows !== undefined && rows > spec.maxRows) fail(`${rows} data row(s), at most ${spec.maxRows} allowed`);
      return { passed: reasons.length === 0, reasons, details: { rows, columns: header ? (header as string[]).length : 0 } };
    },
  };
}
