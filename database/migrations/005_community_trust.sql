-- 005 — community hub, transaction flow, trust & verification, hyper-local pickup.
-- Builds on 004 (marketplace). Idempotent IF NOT EXISTS style, picked up by
-- migrate.js in filename order. No stored reputation score anywhere: ratings
-- are raw rows and the aggregate is computed on read. No location history:
-- pickup shares hold only the latest one-shot reading per delivery and are
-- deleted on expiry (cleanup on read) and replaced on re-share.
-- The 001 member-role CHECK lists only owner/admin/member; it is widened
-- below (Area 1) to also admit moderator.

-- Area 1: group rules + join mode on conversations.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS rules TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS join_mode TEXT NOT NULL DEFAULT 'approval' CHECK (join_mode IN ('approval'));
-- Widen the 001 member-role CHECK to admit moderator: drop the real-PostgreSQL
-- auto-name and the pg-mem emulator's name for the same inline CHECK, then
-- add one explicit replacement (precedent: 004 did the same for deliveries).
ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS conversation_members_role_check;
ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS conversation_members_constraint_1;
ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_role_check CHECK (role IN ('owner', 'admin', 'moderator', 'member'));

-- Area 1: pinned announcements (one pin per message).
CREATE TABLE IF NOT EXISTS pinned_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by       UUID NOT NULL REFERENCES users(id),
  pinned_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pinned_conversation ON pinned_messages (conversation_id);

-- Area 1: admin log (group moderation audit trail; detail never holds codes
-- or message bodies — callers pass only ids, roles and short labels).
CREATE TABLE IF NOT EXISTS group_admin_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  target_id       UUID,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_admin_log_conversation ON group_admin_log (conversation_id, created_at DESC);

-- Area 1: invite links (code is the only secret; the QR encodes the code only).
CREATE TABLE IF NOT EXISTS group_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES users(id),
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER CHECK (max_uses IS NULL OR max_uses >= 1),
  uses            INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_invites_conversation ON group_invites (conversation_id);

-- Area 1: join requests (approval path for groups; direct-add and
-- invite-code joins keep working regardless of join_mode).
CREATE TABLE IF NOT EXISTS group_join_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  requester_id    UUID NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'DECLINED')),
  decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_conversation ON group_join_requests (conversation_id);

-- Area 2: reactions (one reaction per user per message, enforced by UNIQUE).
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions (message_id);

-- Area 4: system-message marker (messages.edited_at already exists since 001
-- and the existing PATCH /api/messages/:id already sets it — no change here).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

-- Area 2: time-limited pickup-only live location. Only the latest share per
-- delivery is ever kept: re-sharing replaces the row, and expired rows are
-- deleted by a cleanup on read, so no history accumulates.
CREATE TABLE IF NOT EXISTS pickup_location_shares (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  sharer_id   UUID NOT NULL REFERENCES users(id),
  lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_pickup_shares_delivery ON pickup_location_shares (delivery_id);

-- Area 3: ratings (raw rows only; avg/count are SQL aggregates on read).
-- One rating per rater per delivery, enforced by UNIQUE.
CREATE TABLE IF NOT EXISTS delivery_ratings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  rater_id    UUID NOT NULL REFERENCES users(id),
  ratee_id    UUID NOT NULL REFERENCES users(id),
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment     TEXT CHECK (comment IS NULL OR char_length(comment) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, rater_id),
  CONSTRAINT delivery_ratings_not_self CHECK (rater_id <> ratee_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_ratings_ratee ON delivery_ratings (ratee_id);
CREATE INDEX IF NOT EXISTS idx_delivery_ratings_delivery ON delivery_ratings (delivery_id);
