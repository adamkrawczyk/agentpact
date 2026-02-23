-- Release stuck 'funded' milestones on completed deals
-- These got stuck because the deal completed but completeDealMilestones
-- was not triggered properly (e.g., payment_intents never funded on-chain)
UPDATE milestones
SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
WHERE status = 'funded'
  AND deal_id IN (SELECT id FROM deals WHERE status = 'completed');
