-- NEXORA 001 — initial schema.
-- PostgreSQL. All timestamps are timestamptz (UTC). Money is informational only:
-- there is no payment integration, so fees are stored as plain numeric offers.
-- Run with: npm run migrate   (applies every file in database/migrations/ in order)
-- Note: the application generates all UUIDs in Node (crypto.randomUUID) and
-- passes them explicitly, so the gen_random_uuid() defaults below are only a
-- fallback for direct SQL inserts. Emails are lowercased by the application
-- before insert/query (no CITEXT dependency, keeps the schema portable).

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nexora_id         TEXT NOT NULL UNIQUE,            -- server-issued, e.g. NXR-AB12CD34
  email             TEXT UNIQUE,                       -- nullable: anonymous accounts have none; app lowercases it
  password_hash     TEXT,                            -- bcrypt; nullable for anonymous accounts
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','courier','admin')),
  is_anonymous      BOOLEAN NOT NULL DEFAULT TRUE,
  display_name      TEXT NOT NULL DEFAULT '',
  avatar_glyph      TEXT NOT NULL DEFAULT '◈',
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_password_or_anonymous CHECK (password_hash IS NOT NULL OR is_anonymous)
);
CREATE INDEX IF NOT EXISTS idx_users_nexora_id ON users (nexora_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,                       -- SHA-256 of the opaque token; token itself is never stored
  csrf_token    TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions (token_hash);

CREATE TABLE IF NOT EXISTS public_profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL DEFAULT '',
  avatar_glyph  TEXT NOT NULL DEFAULT '◈',
  bio           TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defined early: messages and deliveries both reference it.
CREATE TABLE IF NOT EXISTS private_file_metadata (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id),
  original_name   TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_key     TEXT NOT NULL,                     -- opaque; never a user-supplied path
  scope_type      TEXT NOT NULL CHECK (scope_type IN ('message','delivery_photo','avatar')),
  scope_id        UUID,                              -- conversation_id or delivery_id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON private_file_metadata (owner_id);
CREATE INDEX IF NOT EXISTS idx_files_scope ON private_file_metadata (scope_type, scope_id);

-- Conversations unify DMs, private groups and public rooms.
CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN ('dm','group','room')),
  name          TEXT,                                -- rooms/groups; NULL for DMs
  description   TEXT NOT NULL DEFAULT '',
  created_by    UUID NOT NULL REFERENCES users(id),
  invite_expires_at TIMESTAMPTZ,                     -- groups: invite link expiry (NULL = no link invites)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations (type);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  reply_to_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id         UUID NOT NULL REFERENCES private_file_metadata(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocked_users_not_self CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id     UUID NOT NULL REFERENCES users(id),
  target_type     TEXT NOT NULL CHECK (target_type IN ('message','user','delivery')),
  target_id       UUID NOT NULL,
  reason          TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);

-- NEXORA TRANSIT
CREATE TABLE IF NOT EXISTS courier_profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available     BOOLEAN NOT NULL DEFAULT FALSE,
  vehicle       TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_ref      TEXT NOT NULL UNIQUE,              -- QR payload: order reference only, never a code
  sender_id       UUID NOT NULL REFERENCES users(id),
  courier_id      UUID REFERENCES users(id),
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  category        TEXT NOT NULL CHECK (category IN ('Documents','Small goods','Clothing','Electronics','Other')),
  size            TEXT NOT NULL CHECK (size IN ('Small (fits a bag)','Medium (box)','Large')),
  weight_kg       NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (weight_kg >= 0),
  pickup_area     TEXT NOT NULL CHECK (char_length(pickup_area) BETWEEN 1 AND 60),
  dropoff_area    TEXT NOT NULL CHECK (char_length(dropoff_area) BETWEEN 1 AND 60),
  pickup_lat      DOUBLE PRECISION CHECK (pickup_lat BETWEEN -90 AND 90),
  pickup_lng      DOUBLE PRECISION CHECK (pickup_lng BETWEEN -180 AND 180),
  dropoff_lat     DOUBLE PRECISION CHECK (dropoff_lat BETWEEN -90 AND 90),
  dropoff_lng     DOUBLE PRECISION CHECK (dropoff_lng BETWEEN -180 AND 180),
  instructions    TEXT NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 300),
  fee_offer       NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fee_offer >= 0),
  fragile         BOOLEAN NOT NULL DEFAULT FALSE,
  status          TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN
                    ('CREATED','SEARCHING_FOR_COURIER','ASSIGNED','ACCEPTED','PICKUP_VERIFIED',
                     'IN_TRANSIT','DROPOFF_VERIFIED','DELIVERED','CANCELLED')),
  disputed        BOOLEAN NOT NULL DEFAULT FALSE,
  dispute_reason  TEXT,
  photo_file_id   UUID REFERENCES private_file_metadata(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_sender ON deliveries (sender_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_courier ON deliveries (courier_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status);

CREATE TABLE IF NOT EXISTS delivery_participants (
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('sender','courier','recipient')),
  PRIMARY KEY (delivery_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS courier_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  courier_id  UUID NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, courier_id)
);

CREATE TABLE IF NOT EXISTS delivery_status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_history_delivery ON delivery_status_history (delivery_id, created_at);

-- One-time handover codes. The code itself is NEVER stored in plaintext:
-- it is AES-256-GCM encrypted with a server key so the sender can re-view it,
-- and verification decrypts + constant-time compares. Attempts are counted.
CREATE TABLE IF NOT EXISTS verification_challenges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id     UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL CHECK (stage IN ('pickup','dropoff')),
  code_encrypted  TEXT NOT NULL,                     -- AES-256-GCM, base64(iv|ciphertext|tag)
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, stage)
);

CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,                     -- e.g. auth.login, delivery.transition, admin.role_change
  target_type     TEXT,
  target_id       UUID,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb, -- NEVER passwords, tokens, codes, or message bodies
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
