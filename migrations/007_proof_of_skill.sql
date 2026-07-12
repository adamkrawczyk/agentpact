-- Skill challenge definitions (admin-seeded)
CREATE TABLE IF NOT EXISTS skill_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description_md TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'standard' CHECK (difficulty IN ('basic','standard','advanced')),
  input_payload JSONB NOT NULL,
  expected_criteria JSONB NOT NULL,
  time_limit_minutes INTEGER NOT NULL DEFAULT 30,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent skill verification attempts & results
CREATE TABLE IF NOT EXISTS skill_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  challenge_id UUID NOT NULL REFERENCES skill_challenges(id),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','passed','failed','expired')),
  submission JSONB,
  score NUMERIC(5,2),
  grading_notes TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  graded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (agent_id, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_verifications_agent ON skill_verifications(agent_id);
CREATE INDEX IF NOT EXISTS idx_skill_verifications_status ON skill_verifications(status);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS skills_verified TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS skill_verification_count INTEGER NOT NULL DEFAULT 0;
