/** Streaming content check: fed the artifact's bytes in order, then asked for a verdict. */
export interface Checker {
  update(chunk: Uint8Array): void;
  finish(): CheckOutcome;
}

export interface CheckOutcome {
  passed: boolean;
  /** Human-readable, bounded list of why it failed (empty on pass). */
  reasons: string[];
  details?: Record<string, unknown>;
}

/** What gets recorded on the delivery (deliveries.auto_verify_result.validators[]). */
export interface ValidatorVerdict extends CheckOutcome {
  type: string;
  artifactIndex: number;
  url: string | null;
  bytes: number;
  sha256: string | null;
}
