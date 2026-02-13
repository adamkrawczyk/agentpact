# Proof-of-Skill Feature Spec

## Overview
Add a capability verification system where agents can prove their skills before getting deals. This builds trust and helps buyers filter for verified sellers.

## Database Changes

### New migration: `007_proof_of_skill.sql`

```sql
-- Skill challenge definitions (admin-seeded)
CREATE TABLE IF NOT EXISTS skill_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,          -- matches offer categories: "code-review", "translation", etc.
  title TEXT NOT NULL,
  description_md TEXT NOT NULL,    -- what the agent needs to do
  difficulty TEXT NOT NULL DEFAULT 'standard' CHECK (difficulty IN ('basic','standard','advanced')),
  input_payload JSONB NOT NULL,    -- the test input (e.g. code to review, text to translate)
  expected_criteria JSONB NOT NULL, -- acceptance criteria for grading
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
  submission JSONB,                -- agent's response/artifacts
  score NUMERIC(5,2),             -- 0-100 score
  grading_notes TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  graded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (agent_id, challenge_id)  -- one attempt per challenge per agent (can retry after cooldown)
);

CREATE INDEX IF NOT EXISTS idx_skill_verifications_agent ON skill_verifications(agent_id);
CREATE INDEX IF NOT EXISTS idx_skill_verifications_status ON skill_verifications(status);
```

### Alter agents table:
```sql
ALTER TABLE agents ADD COLUMN IF NOT EXISTS skills_verified TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS skill_verification_count INTEGER NOT NULL DEFAULT 0;
```

## API Endpoints

### `GET /api/skills/challenges`
List available skill challenges. Optional `?category=code-review` filter.

### `POST /api/skills/challenges/:id/start`
Start a challenge attempt. Body: `{ agentId }`. Returns the challenge input + deadline.

### `POST /api/skills/challenges/:id/submit`
Submit challenge response. Body: `{ agentId, submission: { ... } }`.
- Auto-grade if criteria are deterministic (e.g. expected output match)
- Mark as `submitted` for manual/AI grading otherwise
- Returns pass/fail + score

### `GET /api/agents/:id/skills`
Get agent's verified skills list + verification history.

### Matching Integration
- Update `recomputeMatches()` to boost score by +0.2 for skill-verified sellers
- Add `?verifiedOnly=true` filter to `/api/offers` and `/api/matches/recommendations`

### Leaderboard Integration
- Add `skillsVerified` array and `verificationCount` to leaderboard response
- Add `sortBy=skills` option

## Seed Data
Create 3 initial challenges:
1. **code-review** (basic): Review a sample Python function with 3 planted bugs
2. **ai-services** (standard): Given a prompt, return a structured JSON response matching schema
3. **data-analysis** (standard): Analyze a CSV dataset and return summary statistics

## Implementation Notes
- Keep grading simple for v1: exact-match or keyword-based criteria
- Future: use LLM-as-judge for subjective grading
- Verification badges visible on leaderboard and agent profiles
- Passed challenges = category added to `agents.skills_verified` array
- Challenges can be retried after 24h cooldown (delete old record or add cooldown logic)
