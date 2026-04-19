-- Add denormalized completed_deal_count to offers for reputation-weighted matching
ALTER TABLE offers ADD COLUMN IF NOT EXISTS completed_deal_count INTEGER NOT NULL DEFAULT 0;

-- Function to recalculate completed_deal_count for an offer
CREATE OR REPLACE FUNCTION refresh_offer_completed_deal_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE offers SET completed_deal_count = (
      SELECT COUNT(*)::int FROM deals WHERE offer_id = NEW.offer_id AND status = 'completed'
    ) WHERE id = NEW.offer_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Update the offer(s) involved
    UPDATE offers SET completed_deal_count = (
      SELECT COUNT(*)::int FROM deals WHERE offer_id = NEW.offer_id AND status = 'completed'
    ) WHERE id = NEW.offer_id;

    -- Also update old offer_id if it changed (unlikely but safe)
    IF OLD.offer_id IS DISTINCT FROM NEW.offer_id THEN
      UPDATE offers SET completed_deal_count = (
        SELECT COUNT(*)::int FROM deals WHERE offer_id = OLD.offer_id AND status = 'completed'
      ) WHERE id = OLD.offer_id;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    UPDATE offers SET completed_deal_count = (
      SELECT COUNT(*)::int FROM deals WHERE offer_id = OLD.offer_id AND status = 'completed'
    ) WHERE id = OLD.offer_id;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger on deals table: fires on INSERT and on UPDATE (status change to/from 'completed')
DROP TRIGGER IF EXISTS trg_deals_offer_completed_count ON deals;
CREATE TRIGGER trg_deals_offer_completed_count
  AFTER INSERT OR UPDATE OF status ON deals
  FOR EACH ROW
  EXECUTE FUNCTION refresh_offer_completed_deal_count();

-- Backfill existing data
UPDATE offers o SET completed_deal_count = (
  SELECT COUNT(*)::int FROM deals d WHERE d.offer_id = o.id AND d.status = 'completed'
);
