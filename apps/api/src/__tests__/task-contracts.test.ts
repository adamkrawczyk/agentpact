/**
 * Integration tests for data-delivery-v1 task contracts.
 *
 * Covers:
 *  - web-scrape-leads-v1: CSV column check + min rows
 *  - transcribe-audio-v1: text content + format + keywords
 *  - classify-rows-v1: CSV/JSON columns + min rows + confidence avg
 *  - Positive: verifier auto-passes → auto-verified status
 *  - Negative: verifier auto-fails → stays submitted
 *  - No contract: existing flow unchanged (tested by existing suite)
 *
 * protocol_1605/D acceptance gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoVerify } from "../auto-verify.js";

describe("autoVerify — web-scrape-leads-v1", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockFetchCsv(csv: string) {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(csv, { headers: { "content-type": "text/csv" } })
    );
  }

  it("passes when CSV has required columns and min rows", async () => {
    mockFetchCsv("company,url,contact_email\nAcme,https://acme.com,bob@acme.com\nGlobex,https://globex.com,jane@globex.com\nInitech,https://initech.com,sam@initech.com");
    const result = await autoVerify("web-scrape-leads-v1", {
      download_url: "http://mock/leads.csv",
      spec: { required_columns: ["company", "url", "contact_email"], min_rows: 3 },
    });
    expect(result.success).toBe(true);
    expect(result.details).toContain("3 rows");
  });

  it("fails when missing required columns", async () => {
    mockFetchCsv("company,url\nAcme,https://acme.com");
    const result = await autoVerify("web-scrape-leads-v1", {
      download_url: "http://mock/leads.csv",
      spec: { required_columns: ["company", "contact_email"], min_rows: 1 },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("Missing required columns: contact_email");
  });

  it("fails when row count below minimum", async () => {
    mockFetchCsv("company,url,contact_email\nAcme,https://acme.com,bob@acme.com");
    const result = await autoVerify("web-scrape-leads-v1", {
      download_url: "http://mock/leads.csv",
      spec: { required_columns: ["company"], min_rows: 10 },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("below minimum 10");
  });

  it("fails when download_url is missing", async () => {
    const result = await autoVerify("web-scrape-leads-v1", {
      spec: { required_columns: ["company"] },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("Missing download_url");
  });

  it("fails when CSV has only header", async () => {
    mockFetchCsv("company,url");
    const result = await autoVerify("web-scrape-leads-v1", {
      download_url: "http://mock/leads.csv",
      spec: { required_columns: ["company"], min_rows: 1 },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("1 lines");
  });
});

describe("autoVerify — transcribe-audio-v1", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockFetchText(text: string, contentType = "text/plain") {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(text, { headers: { "content-type": contentType } })
    );
  }

  it("passes for valid transcription with keywords", async () => {
    mockFetchText("Hello world, this is a test transcription with some important keywords like meeting and agenda.");
    const result = await autoVerify("transcribe-audio-v1", {
      download_url: "http://mock/transcript.txt",
      spec: { format: "txt", min_length_chars: 50, must_contain_keywords: ["meeting", "agenda"] },
    });
    expect(result.success).toBe(true);
    expect(result.details).toContain("chars");
  });

  it("fails when content too short", async () => {
    mockFetchText("Hi");
    const result = await autoVerify("transcribe-audio-v1", {
      download_url: "http://mock/t.txt",
      spec: { min_length_chars: 100 },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("below minimum");
  });

  it("fails when missing required keywords", async () => {
    mockFetchText("This is a transcription without the secret keyword.");
    const result = await autoVerify("transcribe-audio-v1", {
      download_url: "http://mock/t.txt",
      spec: { must_contain_keywords: ["quantum", "physics"] },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("Missing required keywords: quantum, physics");
  });

  it("fails for empty content", async () => {
    mockFetchText("   ");
    const result = await autoVerify("transcribe-audio-v1", {
      download_url: "http://mock/t.txt",
      spec: {},
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("empty");
  });

  it("passes without format check when format not specified", async () => {
    mockFetchText("Some transcription text that is long enough to pass.");
    const result = await autoVerify("transcribe-audio-v1", {
      download_url: "http://mock/t",
      spec: { min_length_chars: 10 },
    });
    expect(result.success).toBe(true);
  });
});

describe("autoVerify — classify-rows-v1", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockFetchCsv(csv: string) {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(csv, { headers: { "content-type": "text/csv" } })
    );
  }
  function mockFetchJson(data: unknown) {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
    );
  }

  it("passes for valid CSV with confidence check", async () => {
    mockFetchCsv("input_text,predicted_label,confidence\nhello world,positive,0.95\ngood morning,positive,0.88\nbad news,negative,0.92");
    const result = await autoVerify("classify-rows-v1", {
      download_url: "http://mock/classified.csv",
      spec: {
        required_columns: ["input_text", "predicted_label", "confidence"],
        min_rows: 3,
        format: "csv",
        min_confidence_avg: 0.85,
      },
    });
    expect(result.success).toBe(true);
    expect(result.details).toContain("3 rows");
  });

  it("passes for valid JSON format", async () => {
    mockFetchJson([
      { input_text: "hello", predicted_label: "positive", confidence: 0.9 },
      { input_text: "bad", predicted_label: "negative", confidence: 0.8 },
      { input_text: "ok", predicted_label: "neutral", confidence: 0.85 },
    ]);
    const result = await autoVerify("classify-rows-v1", {
      download_url: "http://mock/classified.json",
      spec: {
        required_columns: ["input_text", "predicted_label"],
        min_rows: 2,
        format: "json",
      },
    });
    expect(result.success).toBe(true);
    expect(result.details).toContain("3 rows");
  });

  it("fails when confidence below threshold", async () => {
    mockFetchCsv("input_text,label,confidence\nhello,positive,0.3\nworld,negative,0.4");
    const result = await autoVerify("classify-rows-v1", {
      download_url: "http://mock/c.csv",
      spec: {
        required_columns: ["input_text", "label", "confidence"],
        min_rows: 1,
        format: "csv",
        min_confidence_avg: 0.7,
      },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("below threshold");
  });

  it("fails when missing required columns", async () => {
    mockFetchCsv("input_text,label\nhello,positive\nworld,negative");
    const result = await autoVerify("classify-rows-v1", {
      download_url: "http://mock/c.csv",
      spec: { required_columns: ["input_text", "confidence"], format: "csv" },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("Missing required columns: confidence");
  });

  it("fails for invalid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not json at all", { headers: { "content-type": "application/json" } })
    );
    const result = await autoVerify("classify-rows-v1", {
      download_url: "http://mock/c.json",
      spec: { format: "json", required_columns: ["x"] },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("not valid JSON");
  });

  it("fails for empty JSON array", async () => {
    mockFetchJson([]);
    const result = await autoVerify("classify-rows-v1", {
      download_url: "http://mock/c.json",
      spec: { format: "json", required_columns: ["x"] },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("empty");
  });

  it("fails when row count below minimum (JSON)", async () => {
    mockFetchJson([{ input_text: "hello", label: "pos" }]);
    const result = await autoVerify("classify-rows-v1", {
      download_url: "http://mock/c.json",
      spec: { format: "json", required_columns: ["input_text"], min_rows: 5 },
    });
    expect(result.success).toBe(false);
    expect(result.details).toContain("below minimum 5");
  });
});

describe("autoVerify — unknown verifier type", () => {
  it("passes by default for unknown verifier types", async () => {
    const result = await autoVerify("some-custom-verifier", {});
    expect(result.success).toBe(true);
    expect(result.details).toContain("No auto-verification available");
  });
});
