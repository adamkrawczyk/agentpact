-- 023: Add task_contract column for automated deliverable verification (data-delivery-v1)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS task_contract JSONB;
COMMENT ON COLUMN deals.task_contract IS 'Task contract spec for automated deliverable verification. Schema: { version: "data-delivery-v1", verifier: string, spec: object }. Nullable — deals without a contract use manual verification.';

-- Add auto-verified status and auto_verify_result column to deliveries
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS auto_verify_result JSONB;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check CHECK (status IN ('submitted','verified','auto-verified','rejected'));
COMMENT ON COLUMN deliveries.auto_verify_result IS 'Auto-verification result from task contract verifier. Schema: { success: boolean, details: string, verifier: string }';
