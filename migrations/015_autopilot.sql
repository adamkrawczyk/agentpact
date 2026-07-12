ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS max_auto_deal_price NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS auto_buy_categories TEXT[];
