-- 003 — deterministic ordering for the delivery status history.
-- created_at ties (two transitions in one transaction, e.g. CREATED followed
-- immediately by SEARCHING_FOR_COURIER) made ORDER BY created_at ambiguous on
-- real PostgreSQL. A monotonic sequence is the tiebreaker. (A plain sequence
-- + DEFAULT is used instead of GENERATED ALWAYS AS IDENTITY so the migration
-- also applies to the pg-mem emulator used by the default test path.)
CREATE SEQUENCE IF NOT EXISTS delivery_history_seq;
ALTER TABLE delivery_status_history
  ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('delivery_history_seq');
