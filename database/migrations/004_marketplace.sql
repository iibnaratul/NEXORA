-- 004 — marketplace fulfilment on top of TRANSIT (Phase 1 + Phase 2 delivery flow).
-- A buyer requests an item from a seller inside a conversation; the seller
-- accepts (creating a marketplace delivery), prepares it, sets a drop-off pin
-- (+ optional photo), and hands it over against a one-time pickup code the
-- buyer shows. Payment is a record only: no money moves in-app.
-- Idempotent IF NOT EXISTS style, picked up by migrate.js in filename order.
-- Note the creation order below: delivery_requests references deliveries
-- (which already exists), and only afterwards does deliveries gain its
-- request_id FK back to delivery_requests, so there is no circular
-- creation problem.

CREATE TABLE IF NOT EXISTS delivery_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  requester_id    UUID NOT NULL REFERENCES users(id),
  target_id       UUID NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  description     TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  price_minor     INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
  note            TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  status          TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','ACCEPTED','DECLINED','CANCELLED')),
  delivery_id     UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_requests_not_self CHECK (requester_id <> target_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_conversation ON delivery_requests (conversation_id);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_requester ON delivery_requests (requester_id);
CREATE INDEX IF NOT EXISTS idx_delivery_requests_target ON delivery_requests (target_id);

CREATE TABLE IF NOT EXISTS conversation_delivery_settings (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  allow_requests  TEXT NOT NULL DEFAULT 'any_member',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id   UUID NOT NULL UNIQUE REFERENCES deliveries(id) ON DELETE CASCADE,
  payer_id      UUID NOT NULL REFERENCES users(id),
  payee_id      UUID NOT NULL REFERENCES users(id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency      TEXT NOT NULL DEFAULT 'BDT',
  method        TEXT NOT NULL DEFAULT 'cash',
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_payments_delivery ON delivery_payments (delivery_id);

CREATE TABLE IF NOT EXISTS delivery_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID REFERENCES delivery_requests(id) ON DELETE SET NULL,
  delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  old_value   JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_value   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_audit_request ON delivery_audit (request_id);
CREATE INDEX IF NOT EXISTS idx_delivery_audit_delivery ON delivery_audit (delivery_id);

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS fulfillment TEXT NOT NULL DEFAULT 'courier' CHECK (fulfillment IN ('courier','marketplace'));
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES delivery_requests(id) ON DELETE SET NULL;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS dropoff_photo_file_id UUID REFERENCES private_file_metadata(id) ON DELETE SET NULL;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS price_minor INTEGER CHECK (price_minor IS NULL OR price_minor >= 0);
-- Explicit IS NULL arm: real PostgreSQL passes a NULL CHECK as unknown, but
-- the pg-mem test emulator rejects NULL against a bare IN list.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS dropoff_coord_source TEXT CHECK (dropoff_coord_source IS NULL OR dropoff_coord_source IN ('user-supplied','gps'));
CREATE INDEX IF NOT EXISTS idx_deliveries_request ON deliveries (request_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_fulfillment ON deliveries (fulfillment);

-- Widen the 001 status CHECK, which lists only courier states, to also
-- admit the marketplace states PREPARED and READY_FOR_PICKUP (without this,
-- prepare/dropoff fail on real PostgreSQL as well as in pg-mem).
-- The 001 column CHECK is auto-named deliveries_status_check on real
-- PostgreSQL and deliveries_constraint_13 in the pg-mem emulator, so drop
-- both names IF EXISTS, then add one explicit replacement constraint.
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_constraint_13;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check CHECK (status IN ('CREATED','SEARCHING_FOR_COURIER','ASSIGNED','ACCEPTED','PICKUP_VERIFIED','IN_TRANSIT','DROPOFF_VERIFIED','DELIVERED','CANCELLED','PREPARED','READY_FOR_PICKUP'));
