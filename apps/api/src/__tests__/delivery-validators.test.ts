/**
 * M3 deterministic delivery validators: csv-schema, json-schema, sha256 and
 * the SSRF-guarded artifact fetch they run on.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptanceCriterionSchema,
  extractValidatorSpecs,
  fetchArtifact,
  isPublicAddress,
  runValidator,
  validatorSpecSchema,
  type ValidatorSpec,
} from "../shared/validators/index.js";
import { createCsvChecker, csvSpecSchema } from "../shared/validators/csv.js";
import { createJsonSchemaChecker, jsonSchemaSpecSchema } from "../shared/validators/json-schema.js";

const enc = new TextEncoder();
const spec = (v: unknown) => validatorSpecSchema.parse(v) as ValidatorSpec;

function runCsv(raw: unknown, text: string, chunkSize = 7) {
  const checker = createCsvChecker(csvSpecSchema.parse(raw));
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += chunkSize) checker.update(bytes.slice(i, i + chunkSize));
  return checker.finish();
}

const CSV_SPEC = {
  type: "csv-schema",
  columns: [
    { name: "id", type: "integer", required: true },
    { name: "email", type: "string", required: true },
    { name: "score", type: "number" },
    { name: "active", type: "boolean" },
    { name: "joined", type: "date" },
  ],
  minRows: 2,
  maxRows: 3,
};

describe("csv-schema validator", () => {
  it("valid CSV passes — quotes, escaped quotes, CRLF, BOM, chunk boundaries anywhere", () => {
    const text = "﻿id,email,score,active,joined,extra\r\n"
      + "1,\"a@x.io\",3.5,true,2026-01-02,\"multi\r\nline, with \"\"quotes\"\"\"\r\n"
      + "2,b@x.io,-1e3,0,2026-01-02T10:00:00Z,\r\n";
    for (const size of [1, 2, 3, 5, 64]) {
      const out = runCsv(CSV_SPEC, text, size);
      expect(out.reasons).toEqual([]);
      expect(out.passed).toBe(true);
      expect(out.details).toMatchObject({ rows: 2, columns: 6 });
    }
  });

  it("missing required column fails", () => {
    const out = runCsv(CSV_SPEC, "id,score\n1,2\n2,3\n");
    expect(out.passed).toBe(false);
    expect(out.reasons.join()).toMatch(/missing required column\(s\): email/);
  });

  it("wrong types, empty required values and ragged rows fail with row-level reasons", () => {
    const out = runCsv(CSV_SPEC, "id,email,score,active,joined\nx,a@x.io,abc,maybe,2026-13-45\n2,,1,1\n");
    expect(out.passed).toBe(false);
    const all = out.reasons.join("\n");
    expect(all).toMatch(/row 1: column "id" value "x" is not integer/);
    expect(all).toMatch(/row 1: column "score" value "abc" is not number/);
    expect(all).toMatch(/row 1: column "active" value "maybe" is not boolean/);
    expect(all).toMatch(/row 1: column "joined" value "2026-13-45" is not date/);
    expect(all).toMatch(/row 2: column "email" is empty/);
    expect(all).toMatch(/row 2: 4 field\(s\), header has 5/);
  });

  it("row-count bounds", () => {
    const head = "id,email\n";
    expect(runCsv(CSV_SPEC, `${head}1,a\n`).reasons.join()).toMatch(/1 data row\(s\), at least 2/);
    expect(runCsv(CSV_SPEC, `${head}1,a\n2,b\n3,c\n4,d\n`).reasons.join()).toMatch(/4 data row\(s\), at most 3/);
  });

  it("unterminated quote, empty file and invalid UTF-8 fail", () => {
    expect(runCsv(CSV_SPEC, "id,email\n1,\"open\n").reasons.join()).toMatch(/unterminated/);
    expect(runCsv(CSV_SPEC, "").reasons.join()).toMatch(/empty/);
    const checker = createCsvChecker(csvSpecSchema.parse(CSV_SPEC));
    expect(() => checker.update(new Uint8Array([0x69, 0x64, 0xff, 0xfe]))).toThrow();
  });

  it("allowExtraColumns:false refuses unknown columns", () => {
    const out = runCsv({ ...CSV_SPEC, minRows: 0, allowExtraColumns: false }, "id,email,secret\n");
    expect(out.reasons.join()).toMatch(/unexpected column\(s\): secret/);
  });

  it("spec schema: rejects duplicate columns, minRows > maxRows, unknown keys, oversize caps", () => {
    expect(csvSpecSchema.safeParse({ ...CSV_SPEC, columns: [{ name: "a" }, { name: "a" }] }).success).toBe(false);
    expect(csvSpecSchema.safeParse({ ...CSV_SPEC, minRows: 5, maxRows: 1 }).success).toBe(false);
    expect(csvSpecSchema.safeParse({ ...CSV_SPEC, nope: 1 }).success).toBe(false);
    expect(csvSpecSchema.safeParse({ ...CSV_SPEC, maxBytes: 1e12 }).success).toBe(false);
  });
});

describe("json-schema validator (draft 2020-12)", () => {
  const SCHEMA = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["items"],
    properties: {
      items: { type: "array", minItems: 1, prefixItems: [{ type: "object", required: ["sku"] }], items: { type: "object" } },
    },
  };
  const run = (text: string) => {
    const c = createJsonSchemaChecker(jsonSchemaSpecSchema.parse({ type: "json-schema", schema: SCHEMA }));
    c.update(enc.encode(text));
    return c.finish();
  };

  it("valid JSON passes (2020-12 prefixItems understood)", () => {
    expect(run(JSON.stringify({ items: [{ sku: "A1" }, {}] }))).toMatchObject({ passed: true, reasons: [] });
  });

  it("schema violations fail with instance paths", () => {
    const out = run(JSON.stringify({ items: [{ nosku: true }] }));
    expect(out.passed).toBe(false);
    expect(out.reasons.join()).toMatch(/\/items\/0 must have required property 'sku'/);
  });

  it("malformed JSON fails", () => {
    expect(run("{\"items\": [").reasons.join()).toMatch(/not valid JSON/);
  });

  it("untrusted schemas: regex keywords, $data, invalid and oversize schemas are refused at spec time", () => {
    const bad = (schema: unknown) => jsonSchemaSpecSchema.safeParse({ type: "json-schema", schema }).success;
    expect(bad({ type: "string", pattern: "^(a+)+$" })).toBe(false);
    expect(bad({ type: "object", patternProperties: { "^x": {} } })).toBe(false);
    expect(bad({ properties: { a: { const: { $data: "1/b" } } } })).toBe(false);
    expect(bad({ type: "not-a-type" })).toBe(false);
    expect(bad({ description: "x".repeat(70_000) })).toBe(false);
    expect(bad(SCHEMA)).toBe(true);
  });
});

describe("acceptance criteria wiring", () => {
  it("criteria may mix strings and {validator}; unknown validator types are refused", () => {
    expect(acceptanceCriterionSchema.safeParse("Rows are deduplicated").success).toBe(true);
    expect(acceptanceCriterionSchema.safeParse({ validator: { type: "sha256", sha256: "a".repeat(64) } }).success).toBe(true);
    expect(acceptanceCriterionSchema.safeParse({ validator: { type: "xlsx" } }).success).toBe(false);
    expect(acceptanceCriterionSchema.safeParse({ validator: { type: "sha256", sha256: "nothex" } }).success).toBe(false);
  });

  it("extractValidatorSpecs pulls specs out of stored criteria and reports broken ones", () => {
    const { specs, invalid } = extractValidatorSpecs([
      "text only",
      { validator: { type: "sha256", sha256: "B".repeat(64) } },
      { validator: { type: "gone-format" } },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: "sha256", artifactIndex: 0 });
    expect(invalid).toHaveLength(1);
  });
});

describe("SSRF guard", () => {
  it("isPublicAddress: private, loopback, link-local, CGNAT, reserved, mapped and NAT64 forms are not public", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
      "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
      "::1", "::", "::7f00:1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::",
      "not-an-ip",
    ]) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  const noop = () => {};
  const opts = { timeoutMs: 2_000, maxBytes: 1024 };

  it("refuses non-https, credentials, private IP literals (v4, v6, mapped)", async () => {
    await expect(fetchArtifact("http://example.com/a.csv", opts, noop)).rejects.toMatchObject({ code: "NOT_HTTPS" });
    await expect(fetchArtifact("file:///etc/passwd", opts, noop)).rejects.toMatchObject({ code: "NOT_HTTPS" });
    await expect(fetchArtifact("https://u:p@example.com/a", opts, noop)).rejects.toMatchObject({ code: "CREDENTIALS_IN_URL" });
    await expect(fetchArtifact("https://127.0.0.1/a", opts, noop)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(fetchArtifact("https://169.254.169.254/latest/meta-data", opts, noop)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(fetchArtifact("https://[::1]/a", opts, noop)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(fetchArtifact("https://[::ffff:127.0.0.1]/a", opts, noop)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("refuses hostnames that resolve (even partly) to private addresses — checked after DNS", async () => {
    const resolve = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(fetchArtifact("https://innocent.example/a", { ...opts, resolve }, noop)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    await expect(fetchArtifact("https://rebind.example/a", { ...opts, resolve: mixed }, noop)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  // ── against a real local TLS server ─────────────────────────────────────
  // The server lives on 127.0.0.1, so these tests resolve test hostnames to
  // it and use an address policy that admits loopback ONLY for the hostname
  // "artifacts.test". Every other hostname gets the production policy.
  let server: Server;
  let port = 0;
  let ca = "";
  const csvBody = "id,email\n1,a@x.io\n2,b@x.io\n";
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-validators-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=artifacts.test",
      "-addext", "subjectAltName=DNS:artifacts.test,DNS:internal.test",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    ca = readFileSync(join(dir, "cert.pem"), "utf8");
    server = createServer({ key: readFileSync(join(dir, "key.pem")), cert: ca }, (req, res) => {
      if (req.url === "/ok.csv") { res.writeHead(200, { "content-type": "text/csv" }); res.end(csvBody); return; }
      if (req.url === "/big-declared") { res.writeHead(200, { "content-length": "999999" }); res.end("x"); return; }
      if (req.url === "/big-chunked") {
        res.writeHead(200);
        let n = 0;
        const t = setInterval(() => { res.write("y".repeat(400)); if (++n > 10) { clearInterval(t); res.end(); } }, 1);
        return;
      }
      if (req.url === "/slow") { res.writeHead(200); res.write("a"); return; } // never ends
      if (req.url === "/to-internal") { res.writeHead(302, { location: "https://internal.test/ok.csv" }); res.end(); return; }
      if (req.url === "/to-http") { res.writeHead(302, { location: "http://artifacts.test/ok.csv" }); res.end(); return; }
      if (req.url === "/to-self") { res.writeHead(302, { location: "/ok.csv" }); res.end(); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const local = () => ({
    ca,
    timeoutMs: 2_000,
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    addressPolicy: (ip: string, host: string) => host === "artifacts.test" || isPublicAddress(ip),
  });
  const u = (path: string, host = "artifacts.test") => `https://${host}:${port}${path}`;

  it("happy path: streams the bytes", async () => {
    const chunks: Uint8Array[] = [];
    const out = await fetchArtifact(u("/ok.csv"), { ...local(), maxBytes: 1024 }, (c) => { chunks.push(c); });
    expect(out.bytes).toBe(csvBody.length);
    expect(Buffer.concat(chunks).toString()).toBe(csvBody);
  });

  it("redirect to a private host is refused at the redirect hop; same-host redirect is followed", async () => {
    await expect(fetchArtifact(u("/to-internal"), { ...local(), maxBytes: 1024 }, noop)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(fetchArtifact(u("/to-http"), { ...local(), maxBytes: 1024 }, noop)).rejects.toMatchObject({ code: "NOT_HTTPS" });
    const out = await fetchArtifact(u("/to-self"), { ...local(), maxBytes: 1024 }, noop);
    expect(out.bytes).toBe(csvBody.length);
  });

  it("size cap: declared Content-Length and streamed bytes", async () => {
    await expect(fetchArtifact(u("/big-declared"), { ...local(), maxBytes: 1024 }, noop)).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(fetchArtifact(u("/big-chunked"), { ...local(), maxBytes: 1024 }, noop)).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("timeout: a server that never finishes is cut off", async () => {
    const t0 = Date.now();
    await expect(fetchArtifact(u("/slow"), { ...local(), maxBytes: 1024, timeoutMs: 300 }, noop)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("runValidator end-to-end: csv pass, sha256 match + mismatch, oversize → fail with reason", async () => {
    const sha = createHash("sha256").update(csvBody).digest("hex");
    const arts = [{ url: u("/ok.csv") }];
    const csv = await runValidator(spec({ type: "csv-schema", columns: [{ name: "id", type: "integer" }, { name: "email", required: true }], minRows: 2 }), arts, local());
    expect(csv).toMatchObject({ passed: true, bytes: csvBody.length, sha256: sha });
    expect((await runValidator(spec({ type: "sha256", sha256: sha }), arts, local())).passed).toBe(true);
    const mismatch = await runValidator(spec({ type: "sha256", sha256: "0".repeat(64) }), arts, local());
    expect(mismatch.passed).toBe(false);
    expect(mismatch.reasons.join()).toMatch(/sha256 mismatch/);
    const tiny = await runValidator(spec({ type: "sha256", sha256: sha, maxBytes: 5 }), arts, local());
    expect(tiny.passed).toBe(false);
    expect(tiny.reasons.join()).toMatch(/TOO_LARGE/);
    const missing = await runValidator(spec({ type: "sha256", sha256: sha, artifactIndex: 3 }), arts, local());
    expect(missing.reasons.join()).toMatch(/no artifact at index 3/);
  });
});
