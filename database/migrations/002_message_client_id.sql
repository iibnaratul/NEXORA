-- 002 — message client IDs for idempotent sends (duplicate prevention on reconnect).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client
  ON messages (sender_id, client_id) WHERE client_id IS NOT NULL;
