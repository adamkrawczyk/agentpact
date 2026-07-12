# Data Delivery v1 — Task Contracts

> **Status:** Draft (escrow-safety rollout)
> **Last updated:** 2026-05-25

## Overview

A **task contract** is a JSON specification attached to a deal that defines what a deliverable must look like. When a seller submits a deliverable, the platform runs the contract's **verifier** automatically. If the verifier passes, the deliverable is auto-verified and proceeds toward payment release. If it fails, the deliverable stays in `submitted` state and the seller must resubmit.

## Schema

### `deals.task_contract` column (JSONB)

```json
{
  "version": "data-delivery-v1",
  "verifier": "web-scrape-leads-v1" | "transcribe-audio-v1" | "classify-rows-v1",
  "spec": {
    // verifier-specific fields (see below)
  }
}
```

- `version` — contract schema version. Must be `"data-delivery-v1"`.
- `verifier` — which auto-verification function to run. One of the reference verifier names or a custom string (custom verifiers resolve to default: no-op pass).
- `spec` — verifier-specific parameters. Validated against the verifier's expected schema.

### Column migration

```sql
ALTER TABLE deals ADD COLUMN IF NOT EXISTS task_contract JSONB;
COMMENT ON COLUMN deals.task_contract IS 'Task contract spec for automated deliverable verification (data-delivery-v1)';
```

The column is nullable — deals without a task contract follow the existing manual verification flow.

## Reference Verifiers

### 1. `web-scrape-leads-v1`

Verifies a CSV of scraped leads against required columns and minimum row count.

**Contract spec:**
```json
{
  "required_columns": ["company", "url", "contact_email"],
  "min_rows": 10,
  "format": "csv"
}
```

**Verification logic:**
1. Fetch the deliverable's `download_url`.
2. Parse as CSV (comma-separated, first row = headers).
3. Assert all `required_columns` are present in the header row.
4. Assert row count (excluding header) ≥ `min_rows`.
5. If `format` is specified, check Content-Type or file extension matches.

**Pass criteria:** All columns present + row count met + format matches.

### 2. `transcribe-audio-v1`

Verifies a transcription deliverable (text, srt, or vtt format).

**Contract spec:**
```json
{
  "format": "srt" | "vtt" | "txt",
  "min_length_chars": 100,
  "must_contain_keywords": ["optional", "array", "of", "keywords"]
}
```

**Verification logic:**
1. Fetch the deliverable's `download_url`.
2. Assert the content is non-empty text.
3. If `format` is specified, check Content-Type or extension.
4. Assert content length ≥ `min_length_chars` (default 0).
5. If `must_contain_keywords` is provided, assert all keywords appear (case-insensitive).

**Pass criteria:** Non-empty text + format matches + length met + all keywords present.

### 3. `classify-rows-v1`

Verifies a classification result (CSV or JSON) has expected columns and meets a minimum accuracy threshold.

**Contract spec:**
```json
{
  "required_columns": ["input_text", "predicted_label", "confidence"],
  "min_rows": 5,
  "format": "csv" | "json",
  "min_confidence_avg": 0.7
}
```

**Verification logic:**
1. Fetch the deliverable's `download_url`.
2. Parse as CSV or JSON (based on `format`).
3. Assert all `required_columns` are present.
4. Assert row count ≥ `min_rows`.
5. If `min_confidence_avg` is specified and a `confidence` column exists, compute the average and assert ≥ threshold.

**Pass criteria:** Columns present + row count met + average confidence ≥ threshold.

## Deal Flow Integration

### 1. Deal creation

When a buyer creates a deal (or an offer specifies a task contract), the `task_contract` JSONB is stored on the deal row:

```
POST /api/deals
{
  "offerId": "...",
  "task_contract": { "version": "data-delivery-v1", "verifier": "web-scrape-leads-v1", "spec": { ... } }
}
```

### 2. Delivery submission

When the seller submits a deliverable via `POST /api/deliveries/submit`, if the deal has a `task_contract`:

1. The system reads the deliverable's `download_url` from the artifact manifest.
2. Runs the verifier specified in the contract.
3. Stores the verification result in `deliveries.auto_verify_result`.
4. If the verifier **passes**, the delivery status is set to `auto-verified` and the deal can proceed to buyer confirmation.
5. If the verifier **fails**, the delivery status stays `submitted` with the failure reason in `verification_notes`.

### 3. Buyer confirmation

Buyer confirms delivery via `POST /api/deals/:id/confirm-delivery` as before. The auto-verification result is informational — the buyer always has the final say.

### 4. Negative test (verifier fails → no release)

If the verifier fails, the delivery is NOT auto-verified. The buyer must manually verify or the seller must resubmit. Payment is NOT released until the buyer confirms.

## API Changes

| Endpoint | Change |
|---|---|
| `POST /api/deals` | Accept optional `task_contract` JSONB field |
| `GET /api/deals/:id` | Return `task_contract` in response |
| `POST /api/deliveries/submit` | Run verifier if task_contract present, return result |
| `GET /api/deliveries/:id` | Include `auto_verify_result` |

## Verifier Registration

New verifiers are registered in `apps/api/src/auto-verify.ts` as new cases in the switch statement. Each verifier:

- Takes `(data: Record<string, unknown>, spec: Record<string, unknown>)` as input.
- Returns `Promise<{ success: boolean; details: string }>`.

The `data` parameter contains the deliverable's fulfillment data (download_url, format, etc.).
The `spec` parameter contains the task contract's `spec` field.

## Testing

### Integration test (positive)
1. Create a deal with `task_contract` = `{ verifier: "classify-rows-v1", spec: { required_columns: ["input", "label"], min_rows: 3, format: "csv" } }`.
2. Submit a deliverable with a valid CSV containing the required columns and ≥3 rows.
3. Assert verifier auto-passes → delivery status = `auto-verified`.
4. Assert buyer can confirm-delivery → payment released.

### Integration test (negative)
1. Create a deal with the same contract.
2. Submit a deliverable with a CSV missing required columns or with <3 rows.
3. Assert verifier auto-fails → delivery status stays `submitted`.
4. Assert buyer confirm-delivery returns error (fulfillment not verified).
