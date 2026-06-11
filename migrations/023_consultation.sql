ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS max_respondents INTEGER,
  ADD COLUMN IF NOT EXISTS time_limit_minutes INTEGER;

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_consultation_max_respondents_check;

ALTER TABLE offers
  ADD CONSTRAINT offers_consultation_max_respondents_check
  CHECK (max_respondents IS NULL OR max_respondents > 0);

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_consultation_time_limit_check;

ALTER TABLE offers
  ADD CONSTRAINT offers_consultation_time_limit_check
  CHECK (time_limit_minutes IS NULL OR time_limit_minutes > 0);

CREATE TABLE IF NOT EXISTS consultation_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  respondent_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  response_md TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, respondent_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_consultation_responses_deal
  ON consultation_responses (deal_id, created_at DESC);
