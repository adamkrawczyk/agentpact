// The demo's product: validate a CSV against a small column schema.
// Inputs are bounded by the server's body limit, so this parses in memory.

export interface CsvSchema {
  columns: Array<{ name: string; type?: "string" | "integer" | "number" | "boolean"; required?: boolean }>;
  minRows?: number;
  maxRows?: number;
}

export interface CsvReport { valid: boolean; rows: number; errors: string[] }

const CHECKS = {
  string: () => true,
  integer: (v: string) => /^[+-]?\d+$/.test(v),
  number: (v: string) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v),
  boolean: (v: string) => /^(?:true|false|1|0)$/i.test(v),
};

function parse(text: string): string[][] | string {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) return "unterminated quoted field";
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function validateCsv(text: string, schema: CsvSchema): CsvReport {
  const parsed = parse(text);
  if (typeof parsed === "string") return { valid: false, rows: 0, errors: [parsed] };
  const [header, ...data] = parsed;
  if (!header) return { valid: false, rows: 0, errors: ["empty file"] };
  const names = header.map((h) => h.trim());
  const errors: string[] = [];
  const missing = schema.columns.filter((c) => !names.includes(c.name)).map((c) => c.name);
  if (missing.length) errors.push(`missing column(s): ${missing.join(", ")}`);
  data.forEach((r, i) => {
    for (const c of schema.columns) {
      const idx = names.indexOf(c.name);
      if (idx < 0) continue;
      const v = (r[idx] ?? "").trim();
      if (!v) { if (c.required) errors.push(`row ${i + 1}: "${c.name}" is empty`); continue; }
      if (!CHECKS[c.type ?? "string"](v)) errors.push(`row ${i + 1}: "${c.name}" is not ${c.type}`);
    }
  });
  if (schema.minRows !== undefined && data.length < schema.minRows) errors.push(`${data.length} rows, at least ${schema.minRows} required`);
  if (schema.maxRows !== undefined && data.length > schema.maxRows) errors.push(`${data.length} rows, at most ${schema.maxRows} allowed`);
  return { valid: errors.length === 0, rows: data.length, errors: errors.slice(0, 50) };
}
