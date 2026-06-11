-- 043: Prevent the same on-chain tx from funding multiple payment intents
-- (complements the CAS guard in the confirm-funding route).

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_tx_hash
  ON payment_intents (tx_hash)
  WHERE tx_hash IS NOT NULL AND tx_hash NOT LIKE 'sim_%';
