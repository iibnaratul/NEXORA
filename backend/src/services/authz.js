// Authorization helpers. Every protected read/write goes through one of these
// (membership/participant checks inside SQL), so a forged ID in the URL can
// never leak another user's data — the IDOR defence.
import { query } from '../db.js';
import { forbidden, notFound } from '../utils/helpers.js';
import { randomUUID } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Malformed UUIDs must 404, never reach PostgreSQL as uuid parameters
// (which raised 22P02 -> 500 and leaked the Postgres error code).
export function assertUuid(id) {
  if (!UUID_RE.test(String(id))) throw notFound('Not found');
}

export async function getConversationOr404(id) {
  assertUuid(id);
  const { rows } = await query('SELECT * FROM conversations WHERE id = $1', [id]);
  if (!rows.length) throw notFound('Conversation not found');
  return rows[0];
}

export async function requireConversationAccess(conversation, user, { forSend = false } = {}) {
  // Public rooms: any authenticated user may read (original behavior).
  // Sending in a room still requires membership (join first), which keeps
  // blocks and moderation enforceable.
  if (conversation.type === 'room' && !forSend) return { role: null };
  const { rows } = await query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversation.id, user.id],
  );
  if (!rows.length) throw forbidden('You are not a member of this conversation');
  return { role: rows[0].role };
}

export async function getDeliveryOr404(id) {
  assertUuid(id);
  const { rows } = await query('SELECT * FROM deliveries WHERE id = $1', [id]);
  if (!rows.length) throw notFound('Delivery not found');
  return rows[0];
}

// Participants: sender, assigned courier, and (future) recipient. Queue items in
// SEARCHING_FOR_COURIER are additionally visible to any registered courier so
// they can claim them — but not their instructions or codes.
export async function requireDeliveryAccess(delivery, user, { courierQueueView = false } = {}) {
  const { rows } = await query(
    'SELECT role FROM delivery_participants WHERE delivery_id = $1 AND user_id = $2',
    [delivery.id, user.id],
  );
  if (rows.length) return { role: rows[0].role };
  if (courierQueueView && delivery.status === 'SEARCHING_FOR_COURIER') {
    const c = await query('SELECT 1 FROM courier_profiles WHERE user_id = $1', [user.id]);
    if (c.rows.length) return { role: 'courier-viewer' };
  }
  if (user.role === 'admin') return { role: 'admin' };
  throw forbidden('You are not a participant in this delivery');
}

export async function isBlockedBetween(a, b) {
  const { rows } = await query(
    `SELECT 1 FROM blocked_users
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}

// File authorization: the file's scope decides who may download it.
export async function requireFileAccess(file, user) {
  if (file.owner_id === user.id || user.role === 'admin') return;
  if (file.scope_type === 'message') {
    const { rows } = await query(
      `SELECT 1 FROM conversation_members cm
         JOIN message_attachments ma ON ma.file_id = $1
         JOIN messages m ON m.id = ma.message_id AND m.conversation_id = cm.conversation_id
        WHERE cm.user_id = $2 LIMIT 1`,
      [file.id, user.id],
    );
    if (rows.length) return;
  }
  if (file.scope_type === 'delivery_photo') {
    const { rows } = await query(
      'SELECT 1 FROM delivery_participants WHERE delivery_id = $1 AND user_id = $2 LIMIT 1',
      [file.scope_id, user.id],
    );
    if (rows.length) return;
  }
  throw forbidden('You may not download this file');
}

export async function audit(clientOrQuery, actorId, action, targetType, targetId, detail = {}) {
  const q = typeof clientOrQuery === 'function' ? clientOrQuery : (t, p) => query(t, p);
  // detail must never contain passwords, tokens, codes or message bodies —
  // callers are responsible; audit() strips obvious keys as a backstop.
  const safe = { ...detail };
  for (const k of ['password', 'token', 'code', 'body', 'csrf']) delete safe[k];
  await q(
    'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), actorId, action, targetType, targetId, JSON.stringify(safe)],
  );
}
