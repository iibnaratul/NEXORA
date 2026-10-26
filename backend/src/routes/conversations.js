// Conversations: public rooms, private DMs, private groups. Every read and
// write enforces membership in SQL (see services/authz.js). Messages are
// persisted, paginated, and broadcast over Socket.IO after insert.
import { Router } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { query, withTransaction } from '../db.js';
import { schemas, validate } from '../validation/schemas.js';
import {
  ok, created, asyncHandler, badRequest, forbidden, notFound, conflict,
  parsePagination, pageMeta,
} from '../utils/helpers.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { messageLimiter } from '../middleware/rateLimit.js';
import {
  getConversationOr404, requireConversationAccess, isBlockedBetween, audit, assertUuid,
} from '../services/authz.js';

// Kick a user's live sockets out of one conversation room (membership loss
// must stop broadcasts, not just future HTTP/socket joins).
async function kickFromConversation(req, userId, conversationId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) s.leave(`conversation:${conversationId}`);
  } catch { /* membership loss already happened; kick failure must not fail it */ }
}
import { signedDownloadUrl } from '../services/storage.js';

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

function serializeMessage(m) {
  return {
    id: m.id, conversationId: m.conversation_id, senderId: m.sender_id,
    senderNexoraId: m.sender_nexora_id, senderName: m.sender_display_name,
    senderAvatar: m.sender_avatar_glyph, body: m.body, replyToId: m.reply_to_id,
    editedAt: m.edited_at, createdAt: m.created_at, isSystem: !!m.is_system,
    reactions: m.reactions || [], replyCount: m.reply_count ?? 0,
    parentSnippet: m.parent_snippet || null,
    attachments: (m.attachments || []).map((a) => ({
      id: a.id, mimeType: a.mime_type, originalName: a.original_name,
      downloadUrl: signedDownloadUrl(a.id),
    })),
  };
}

// Reaction aggregates for a set of messages: [{emoji, count, reacted}]
// per message, where reacted is whether the viewing user reacted at all
// (one reaction per user per message, so it is also "reacted with this").
async function loadReactions(messageIds, viewerId) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT message_id, emoji, COUNT(*)::int AS n,
            BOOL_OR(user_id = $${messageIds.length + 1}) AS reacted
       FROM message_reactions WHERE message_id IN (${placeholders})
      GROUP BY message_id, emoji`,
    [...messageIds, viewerId],
  );
  const map = {};
  for (const r of rows) {
    (map[r.message_id] ||= []).push({ emoji: r.emoji, count: r.n, reacted: !!r.reacted });
  }
  return map;
}

// Reply-thread metadata for a set of messages: reply counts, plus a short
// snippet of the parent message for messages that are themselves replies.
async function loadReplyMeta(messages) {
  const counts = {};
  const snippets = {};
  const ids = messages.map((m) => m.id);
  if (ids.length) {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await query(
      `SELECT reply_to_id, COUNT(*)::int AS n FROM messages
        WHERE reply_to_id IN (${placeholders}) AND deleted_at IS NULL GROUP BY reply_to_id`,
      ids,
    );
    for (const r of rows) counts[r.reply_to_id] = r.n;
  }
  const parentIds = [...new Set(messages.map((m) => m.reply_to_id).filter(Boolean))];
  if (parentIds.length) {
    const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await query(
      `SELECT id, body FROM messages WHERE id IN (${placeholders})`,
      parentIds,
    );
    for (const r of rows) snippets[r.id] = String(r.body || '').slice(0, 80);
  }
  return messages.map((m) => ({
    ...m,
    reply_count: counts[m.id] || 0,
    parent_snippet: m.reply_to_id ? (snippets[m.reply_to_id] || null) : null,
  }));
}

// ---- 005: community-hub helpers ----
// Role tiers for groups. Moderator: pin/unpin + delete messages. Admin:
// moderator powers + members, rules, join decisions, admin log. Owner:
// admin powers + ownership transfer + removing admins. DMs never use these
// (DM behavior is unchanged); rooms keep their existing owner/admin rules
// except where a new endpoint is explicitly group-only.
const GROUP_MOD = ['owner', 'admin', 'moderator'];
const GROUP_ADMIN = ['owner', 'admin'];
function requireGroup(conv) {
  if (conv.type !== 'group') throw forbidden('This feature is for private groups only');
}
async function logGroup(q, conversationId, actorId, action, targetId, detail = {}) {
  const queryFn = typeof q === 'function' ? q : (t, p) => query(t, p);
  await queryFn(
    'INSERT INTO group_admin_log (id, conversation_id, actor_id, action, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [randomUUID(), conversationId, actorId, action, targetId || null, JSON.stringify(detail)],
  );
}
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  let code = 'INV-';
  for (const b of randomBytes(12)) code += INVITE_CHARS[b % INVITE_CHARS.length];
  return code;
}

async function serializeMessagesWithMeta(rows, viewerId) {
  const withMeta = await loadReplyMeta(rows);
  const reactions = await loadReactions(rows.map((r) => r.id), viewerId);
  const attachments = await loadAttachments(rows.map((r) => r.id));
  return withMeta.map((r) => serializeMessage({
    ...r, reactions: reactions[r.id] || [], attachments: attachments[r.id] || [],
  }));
}

async function loadAttachments(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT ma.message_id, f.id, f.mime_type, f.original_name
       FROM message_attachments ma JOIN private_file_metadata f ON f.id = ma.file_id
      WHERE ma.message_id IN (${placeholders})`,
    messageIds,
  );
  const map = {};
  for (const r of rows) (map[r.message_id] ||= []).push(r);
  return map;
}

async function resolveUserByNexora(nexoraId) {
  const { rows } = await query(
    'SELECT id, nexora_id, display_name FROM users WHERE nexora_id = $1 AND deleted_at IS NULL',
    [nexoraId],
  );
  return rows[0] || null;
}

// GET /api/conversations — my memberships plus public rooms, newest first.
// Unread counts and DM partner names are fetched with plain joins (no
// correlated subqueries) and merged in JS.
conversationsRouter.get('/', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  const { rows } = await query(
    `SELECT c.*, cm.role AS my_role, cm.last_read_at
       FROM conversations c
       LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
      WHERE cm.user_id IS NOT NULL OR c.type = 'room'
      ORDER BY c.updated_at DESC LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset],
  );
  const ids = rows.map((r) => r.id);
  const unreadMap = {};
  const partnerMap = {};
  if (ids.length) {
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
    const unread = await query(
      `SELECT m.conversation_id, COUNT(*)::int AS n FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.deleted_at IS NULL AND m.sender_id <> $1 AND m.created_at > cm.last_read_at
          AND m.conversation_id IN (${placeholders})
        GROUP BY m.conversation_id`,
      [req.user.id, ...ids],
    );
    for (const r of unread.rows) unreadMap[r.conversation_id] = r.n;
    const partners = await query(
      `SELECT cm.conversation_id, COALESCE(NULLIF(u.display_name, ''), u.nexora_id) AS partner
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
         JOIN conversations c ON c.id = cm.conversation_id AND c.type = 'dm'
        WHERE cm.user_id <> $1 AND cm.conversation_id IN (${placeholders})`,
      [req.user.id, ...ids],
    );
    for (const r of partners.rows) partnerMap[r.conversation_id] = r.partner;
  }
  const data = rows.map((r) => ({ ...r, unread: unreadMap[r.id] || 0, dm_partner: partnerMap[r.id] || null }));
  const total = await query(
    `SELECT COUNT(*)::int AS n FROM conversations c
       LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
      WHERE cm.user_id IS NOT NULL OR c.type = 'room'`,
    [req.user.id],
  );
  res.json({ ok: true, data, meta: pageMeta(page, limit, total.rows[0].n) });
}));

// GET /api/conversations/unread-count (must precede /:id)
conversationsRouter.get('/unread-count', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
      WHERE m.deleted_at IS NULL AND m.sender_id <> $1 AND m.created_at > cm.last_read_at`,
    [req.user.id],
  );
  res.json({ ok: true, data: { unread: rows[0].total } });
}));

conversationsRouter.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.createConversation, req.body);
  const conv = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    if (body.type === 'dm') {
      const other = await resolveUserByNexora(body.memberNexoraIds[0]);
      if (!other) throw notFound('No user with that NEXORA ID');
      if (other.id === req.user.id) throw badRequest('You cannot DM yourself');
      if (await isBlockedBetween(req.user.id, other.id)) {
        throw forbidden('Cannot start a conversation with this user');
      }
      // Reuse an existing DM instead of duplicating it (join-based, no
      // correlated subquery, then a count check per candidate).
      const candidates = await q(
        `SELECT c.id FROM conversations c
           JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $1
           JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $2
          WHERE c.type = 'dm'`,
        [req.user.id, other.id],
      );
      for (const cand of candidates.rows) {
        const count = await q('SELECT COUNT(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [cand.id]);
        if (count.rows[0].n === 2) return { id: cand.id, reused: true };
      }
      const id = randomUUID();
      await q('INSERT INTO conversations (id, type, created_by) VALUES ($1, \'dm\', $2)', [id, req.user.id]);
      await q('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'member\'), ($1, $3, \'member\')',
        [id, req.user.id, other.id]);
      await audit(q, req.user.id, 'conversation.dm_created', 'conversation', id, { with: other.nexora_id });
      return { id, reused: false };
    }
    const id = randomUUID();
    await q(
      'INSERT INTO conversations (id, type, name, description, created_by) VALUES ($1, $2, $3, $4, $5)',
      [id, body.type, body.name || null, body.description || '', req.user.id],
    );
    await q('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'owner\')',
      [id, req.user.id]);
    if (body.type === 'group') {
      for (const nxr of new Set(body.memberNexoraIds)) {
        const member = await resolveUserByNexora(nxr);
        if (!member) throw notFound(`No user with NEXORA ID ${nxr}`);
        if (member.id === req.user.id) continue;
        if (await isBlockedBetween(req.user.id, member.id)) {
          throw forbidden(`Cannot add ${nxr}: a block exists between you`);
        }
        await q('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'member\')',
          [id, member.id]);
      }
    }
    await audit(q, req.user.id, 'conversation.created', 'conversation', id, { type: body.type });
    return { id, reused: false };
  });
  if (conv.reused) return res.json({ ok: true, data: { id: conv.id, reused: true } });
  res.status(201).json({ ok: true, data: { id: conv.id } });
}));

async function getDeliverySettingsRow(conversationId) {
  const { rows } = await query(
    'SELECT enabled, allow_requests FROM conversation_delivery_settings WHERE conversation_id = $1',
    [conversationId],
  );
  if (!rows.length) return { enabled: true, allowRequests: 'any_member' };
  return { enabled: rows[0].enabled, allowRequests: rows[0].allow_requests };
}

conversationsRouter.get('/:id', asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  await requireConversationAccess(conv, req.user);
  const members = await query(
    `SELECT u.id, u.nexora_id, u.display_name, u.avatar_glyph, cm.role, cm.joined_at
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = $1 ORDER BY cm.joined_at`,
    [conv.id],
  );
  // Frontend alignment: deliverySettings is the canonical field name
  // ({ enabled, allowRequests }); delivery_settings carries the same object.
  // 005: rules/joinMode aliases for the group settings view.
  const deliverySettings = await getDeliverySettingsRow(conv.id);
  res.json({ ok: true, data: { ...conv, members: members.rows, deliverySettings, delivery_settings: deliverySettings, rules: conv.rules || '', joinMode: conv.join_mode || 'approval' } });
}));

// PATCH /api/conversations/:id/delivery-settings — group: owner/admin only;
// DM: either participant; room: owner/admin members only. When enabled is
// false, POST /api/delivery-requests for this conversation returns 403, so
// the frontend can hide/disable the request action from deliverySettings.
conversationsRouter.patch('/:id/delivery-settings', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  const { rows } = await query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conv.id, req.user.id],
  );
  if (!rows.length) throw forbidden('You are not a member of this conversation');
  if (conv.type !== 'dm' && !['owner', 'admin'].includes(rows[0].role)) {
    throw forbidden('Only group owners/admins can change delivery settings');
  }
  const body = validate(schemas.deliverySettings, req.body);
  const current = await getDeliverySettingsRow(conv.id);
  const enabled = body.enabled !== undefined ? body.enabled : current.enabled;
  const allowRequests = body.allowRequests !== undefined ? body.allowRequests : current.allowRequests;
  await query(
    `INSERT INTO conversation_delivery_settings (conversation_id, enabled, allow_requests, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (conversation_id) DO UPDATE SET enabled = $2, allow_requests = $3, updated_at = now()`,
    [conv.id, enabled, allowRequests],
  );
  await audit(query, req.user.id, 'conversation.delivery_settings', 'conversation', conv.id, { enabled, allowRequests });
  // 005: delivery-settings changes are part of the group admin log.
  if (conv.type === 'group') {
    await logGroup(query, conv.id, req.user.id, 'delivery_settings_changed', null, { enabled, allowRequests });
  }
  const deliverySettings = { enabled, allowRequests };
  res.json({ ok: true, data: { deliverySettings, delivery_settings: deliverySettings } });
}));

conversationsRouter.post('/:id/join', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  if (conv.type !== 'room') throw forbidden('Only public rooms can be joined directly');
  await query(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'member\') ON CONFLICT DO NOTHING',
    [conv.id, req.user.id],
  );
  res.json({ ok: true, data: { joined: true } });
}));

conversationsRouter.post('/:id/leave', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  const { role } = await requireConversationAccess(conv, req.user);
  if (role === 'owner') {
    const others = await query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND role = 'owner' AND user_id <> $2 LIMIT 1`,
      [conv.id, req.user.id],
    );
    if (!others.rows.length) throw badRequest('The last owner cannot leave; transfer ownership first');
  }
  await query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conv.id, req.user.id]);
  await kickFromConversation(req, req.user.id, conv.id);
  res.json({ ok: true, data: { left: true } });
}));

conversationsRouter.post('/:id/read', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  await requireConversationAccess(conv, req.user);
  await query(
    'UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2',
    [conv.id, req.user.id],
  );
  res.json({ ok: true, data: { read: true } });
}));

conversationsRouter.get('/:id/messages', asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  await requireConversationAccess(conv, req.user);
  const { page, limit, offset } = parsePagination(req);
  const before = req.query.before ? new Date(req.query.before) : null;
  const params = [conv.id, req.user.id, limit, offset];
  let beforeClause = '';
  if (before && !Number.isNaN(before.getTime())) { beforeClause = 'AND m.created_at < $5'; params.push(before.toISOString()); }
  const { rows } = await query(
    `SELECT m.*, u.nexora_id AS sender_nexora_id, u.display_name AS sender_display_name,
            u.avatar_glyph AS sender_avatar_glyph
       FROM messages m JOIN users u ON u.id = m.sender_id
       LEFT JOIN blocked_users b ON b.blocker_id = $2 AND b.blocked_id = m.sender_id
      WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND b.blocker_id IS NULL
        ${beforeClause}
      ORDER BY m.created_at DESC LIMIT $3 OFFSET $4`,
    params,
  );
  const data = await serializeMessagesWithMeta(rows, req.user.id);
  const total = await query(
    'SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND deleted_at IS NULL', [conv.id],
  );
  res.json({ ok: true, data, meta: pageMeta(page, limit, total.rows[0].n) });
}));

conversationsRouter.post('/:id/messages', requireCsrf, messageLimiter, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  await requireConversationAccess(conv, req.user, { forSend: true });
  const body = validate(schemas.sendMessage, req.body);
  if (conv.type === 'dm') {
    const others = await query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2',
      [conv.id, req.user.id],
    );
    if (others.rows.length && await isBlockedBetween(req.user.id, others.rows[0].user_id)) {
      throw forbidden('Cannot message this user');
    }
  }
  if (body.replyToId) {
    const parent = await query('SELECT id, is_system FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
      [body.replyToId, conv.id]);
    if (!parent.rows.length) throw badRequest('Reply target is not in this conversation');
    // System messages are announcements, not reply targets.
    if (parent.rows[0].is_system) throw badRequest('System messages cannot be replied to');
  }
  if (body.attachmentIds.length) {
    const placeholders = body.attachmentIds.map((_, i) => `$${i + 1}`).join(',');
    const ownerParam = body.attachmentIds.length + 1;
    const scopeParam = body.attachmentIds.length + 2;
    const { rows } = await query(
      `SELECT id FROM private_file_metadata
        WHERE id IN (${placeholders}) AND owner_id = $${ownerParam}
          AND scope_type = 'message' AND scope_id = $${scopeParam}`,
      [...body.attachmentIds, req.user.id, conv.id],
    );
    if (rows.length !== body.attachmentIds.length) throw forbidden('Attachments must be your uploads for this conversation');
  }
  const msg = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    // Idempotent send: a retried clientId returns the original message.
    if (body.clientId) {
      const existing = await q(
        'SELECT id FROM messages WHERE sender_id = $1 AND client_id = $2', [req.user.id, body.clientId],
      );
      if (existing.rows.length) return { id: existing.rows[0].id, duplicate: true };
    }
    const id = randomUUID();
    const { rows } = await q(
      `INSERT INTO messages (id, conversation_id, sender_id, body, reply_to_id, client_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, conv.id, req.user.id, body.body, body.replyToId || null, body.clientId || null],
    );
    for (const fileId of body.attachmentIds) {
      await q('INSERT INTO message_attachments (id, message_id, file_id) VALUES ($1, $2, $3)',
        [randomUUID(), id, fileId]);
    }
    await q('UPDATE conversations SET updated_at = now() WHERE id = $1', [conv.id]);
    const members = await q(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2',
      [conv.id, req.user.id],
    );
    for (const m of members.rows) {
      await q(
        'INSERT INTO notifications (id, user_id, type, payload) VALUES ($1, $2, \'message_new\', $3::jsonb)',
        [randomUUID(), m.user_id, JSON.stringify({ conversationId: conv.id })],
      );
    }
    return { ...rows[0], duplicate: false };
  });
  if (msg.duplicate) {
    const full = await query(
      `SELECT m.*, u.nexora_id AS sender_nexora_id, u.display_name AS sender_display_name,
              u.avatar_glyph AS sender_avatar_glyph FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
      [msg.id],
    );
    return res.json({ ok: true, data: serializeMessage({ ...full.rows[0], attachments: [] }) });
  }
  const full = await query(
    `SELECT m.*, u.nexora_id AS sender_nexora_id, u.display_name AS sender_display_name,
            u.avatar_glyph AS sender_avatar_glyph FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
    [msg.id],
  );
  const attachments = await loadAttachments([msg.id]);
  const serialized = serializeMessage({ ...full.rows[0], attachments: attachments[msg.id] || [] });
  req.app.get('io')?.to(`conversation:${conv.id}`).emit('message:new', serialized);
  res.status(201).json({ ok: true, data: serialized });
}));

conversationsRouter.post('/:id/members', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  const { role } = await requireConversationAccess(conv, req.user);
  if (conv.type !== 'group') throw forbidden('Members can only be added to private groups');
  if (!GROUP_ADMIN.includes(role)) throw forbidden('Only group owners/admins can add members');
  const body = validate(schemas.addMember, req.body);
  const member = await resolveUserByNexora(body.nexoraId);
  if (!member) throw notFound('No user with that NEXORA ID');
  if (await isBlockedBetween(req.user.id, member.id)) throw forbidden('Cannot add this user: a block exists');
  await query(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'member\') ON CONFLICT DO NOTHING',
    [conv.id, member.id],
  );
  await audit(query, req.user.id, 'conversation.member_added', 'conversation', conv.id, { member: body.nexoraId });
  await logGroup(query, conv.id, req.user.id, 'member_added', member.id, { nexoraId: body.nexoraId });
  res.json({ ok: true, data: { added: body.nexoraId } });
}));

conversationsRouter.delete('/:id/members/:userId', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  const { role } = await requireConversationAccess(conv, req.user);
  assertUuid(req.params.userId);
  const targetId = req.params.userId;
  const isSelf = targetId === req.user.id;
  // 005 permission matrix: moderators never remove others; admins never
  // remove the owner or a fellow admin (only the owner may remove admins);
  // the owner may remove anyone except the last owner.
  if (!isSelf && !GROUP_ADMIN.includes(role)) throw forbidden('Only owners/admins can remove members');
  if (!isSelf && conv.type === 'dm') throw forbidden('DM members cannot be removed');
  const target = await query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conv.id, targetId],
  );
  if (!target.rows.length) throw notFound('That user is not a member');
  if (!isSelf && role === 'admin' && ['owner', 'admin'].includes(target.rows[0].role)) {
    throw forbidden('Admins cannot remove the owner or a fellow admin');
  }
  if (target.rows[0].role === 'owner') {
    const others = await query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND role = 'owner' AND user_id <> $2 LIMIT 1`,
      [conv.id, targetId],
    );
    if (!others.rows.length) throw badRequest('Cannot remove the last owner');
  }
  await query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conv.id, targetId]);
  await kickFromConversation(req, targetId, conv.id);
  await audit(query, req.user.id, 'conversation.member_removed', 'conversation', conv.id, {});
  if (conv.type === 'group') await logGroup(query, conv.id, req.user.id, 'member_removed', targetId, {});
  res.json({ ok: true, data: { removed: true } });
}));

// PATCH /api/conversations/:id/members/:userId/role — group only.
// Owner: any member to admin/moderator/member (never own role; use transfer
// for ownership, and an owner's role is never changed directly). Admin: a
// member/moderator to moderator/member only — never to admin, never
// touching an owner or fellow admin. Moderators cannot change roles.
conversationsRouter.patch('/:id/members/:userId/role', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  assertUuid(req.params.userId);
  const body = validate(schemas.memberRole, req.body);
  if (!GROUP_ADMIN.includes(role)) throw forbidden('Only owners/admins can change member roles');
  const targetId = req.params.userId;
  if (targetId === req.user.id) throw badRequest('Use ownership transfer to change your own role');
  const target = await query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conv.id, targetId],
  );
  if (!target.rows.length) throw notFound('That user is not a member');
  if (target.rows[0].role === 'owner') throw badRequest('An owner\'s role cannot be changed directly — transfer ownership instead');
  if (role === 'admin' && (body.role === 'admin' || target.rows[0].role === 'admin')) {
    throw forbidden('Admins cannot promote to admin or change a fellow admin');
  }
  await query(
    'UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2',
    [conv.id, targetId, body.role],
  );
  await audit(query, req.user.id, 'conversation.role_changed', 'conversation', conv.id, { target: targetId, role: body.role });
  await logGroup(query, conv.id, req.user.id, 'role_changed', targetId, { from: target.rows[0].role, to: body.role });
  res.json({ ok: true, data: { userId: targetId, role: body.role } });
}));

// ---- 005: pinned announcements (group only, moderator+) ----
conversationsRouter.get('/:id/pins', asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  await requireConversationAccess(conv, req.user);
  const { rows } = await query(
    `SELECT m.*, u.nexora_id AS sender_nexora_id, u.display_name AS sender_display_name,
            u.avatar_glyph AS sender_avatar_glyph, p.pinned_by, p.pinned_at
       FROM pinned_messages p JOIN messages m ON m.id = p.message_id
       JOIN users u ON u.id = m.sender_id
      WHERE p.conversation_id = $1 AND m.deleted_at IS NULL
      ORDER BY p.pinned_at DESC`,
    [conv.id],
  );
  const data = await serializeMessagesWithMeta(rows, req.user.id);
  res.json({ ok: true, data: data.map((d, i) => ({ ...d, pinnedBy: rows[i].pinned_by, pinnedAt: rows[i].pinned_at })) });
}));

conversationsRouter.post('/:id/pins', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (!GROUP_MOD.includes(role)) throw forbidden('Only moderators and above can pin messages');
  const body = validate(schemas.pinMessage, req.body);
  const msg = await query('SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
    [body.messageId, conv.id]);
  if (!msg.rows.length) throw notFound('Message not found in this conversation');
  const existing = await query('SELECT id FROM pinned_messages WHERE message_id = $1', [body.messageId]);
  if (existing.rows.length) throw conflict('Message is already pinned');
  await query(
    'INSERT INTO pinned_messages (id, conversation_id, message_id, pinned_by) VALUES ($1, $2, $3, $4)',
    [randomUUID(), conv.id, body.messageId, req.user.id],
  );
  await logGroup(query, conv.id, req.user.id, 'message_pinned', body.messageId, {});
  res.status(201).json({ ok: true, data: { pinned: body.messageId } });
}));

conversationsRouter.delete('/:id/pins/:messageId', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (!GROUP_MOD.includes(role)) throw forbidden('Only moderators and above can unpin messages');
  assertUuid(req.params.messageId);
  const del = await query(
    'DELETE FROM pinned_messages WHERE conversation_id = $1 AND message_id = $2 RETURNING id',
    [conv.id, req.params.messageId],
  );
  if (!del.rows.length) throw notFound('That message is not pinned');
  await logGroup(query, conv.id, req.user.id, 'message_unpinned', req.params.messageId, {});
  res.json({ ok: true, data: { unpinned: true } });
}));

// ---- 005: group rules (admin+) ----
conversationsRouter.patch('/:id/rules', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (!GROUP_ADMIN.includes(role)) throw forbidden('Only owners/admins can edit group rules');
  const body = validate(schemas.groupRules, req.body);
  await query('UPDATE conversations SET rules = $2, updated_at = now() WHERE id = $1', [conv.id, body.rules]);
  await logGroup(query, conv.id, req.user.id, 'rules_changed', null, {});
  res.json({ ok: true, data: { rules: body.rules } });
}));

// ---- 005: admin log (admin+) ----
conversationsRouter.get('/:id/admin-log', asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (!GROUP_ADMIN.includes(role)) throw forbidden('Only owners/admins can view the admin log');
  const { page, limit, offset } = parsePagination(req);
  const { rows } = await query(
    `SELECT l.*, u.nexora_id AS actor_nexora_id, u.display_name AS actor_display_name
       FROM group_admin_log l LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.conversation_id = $1 ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`,
    [conv.id, limit, offset],
  );
  const total = await query('SELECT COUNT(*)::int AS n FROM group_admin_log WHERE conversation_id = $1', [conv.id]);
  res.json({ ok: true, data: rows, meta: pageMeta(page, limit, total.rows[0].n) });
}));

// ---- 005: ownership transfer (owner only, explicit confirm) ----
conversationsRouter.post('/:id/transfer', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (role !== 'owner') throw forbidden('Only the owner can transfer ownership');
  const body = validate(schemas.transferOwnership, req.body);
  if (body.newOwnerId === req.user.id) throw badRequest('You already own this group');
  const target = await query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conv.id, body.newOwnerId],
  );
  if (!target.rows.length) throw badRequest('The new owner must be a member of the group');
  await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    await q('UPDATE conversation_members SET role = \'admin\' WHERE conversation_id = $1 AND user_id = $2',
      [conv.id, req.user.id]);
    await q('UPDATE conversation_members SET role = \'owner\' WHERE conversation_id = $1 AND user_id = $2',
      [conv.id, body.newOwnerId]);
    await logGroup(q, conv.id, req.user.id, 'ownership_transferred', body.newOwnerId, { previousRole: target.rows[0].role });
    await audit(q, req.user.id, 'conversation.ownership_transferred', 'conversation', conv.id, {});
  });
  res.json({ ok: true, data: { newOwnerId: body.newOwnerId, previousOwnerNow: 'admin' } });
}));

// ---- 005: invite links (admin+ creates; any member may fetch the QR,
// because the code is meant to be shared — non-members never see it) ----
conversationsRouter.post('/:id/invites', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (!GROUP_ADMIN.includes(role)) throw forbidden('Only owners/admins can create invite links');
  const body = validate(schemas.createInvite, req.body);
  let code = null;
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = newInviteCode();
    const clash = await query('SELECT 1 FROM group_invites WHERE code = $1', [candidate]);
    if (!clash.rows.length) code = candidate;
  }
  if (!code) throw badRequest('Could not generate a unique invite code — try again');
  const { rows } = await query(
    `INSERT INTO group_invites (id, code, conversation_id, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [randomUUID(), code, conv.id, req.user.id,
     body.expiresAt ? new Date(body.expiresAt).toISOString() : null,
     body.maxUses ?? null],
  );
  await logGroup(query, conv.id, req.user.id, 'invite_created', rows[0].id, {});
  res.status(201).json({ ok: true, data: rows[0] });
}));

conversationsRouter.get('/:id/invites', asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (!GROUP_ADMIN.includes(role)) throw forbidden('Only owners/admins can list invite links');
  const { rows } = await query(
    'SELECT * FROM group_invites WHERE conversation_id = $1 ORDER BY created_at DESC', [conv.id],
  );
  res.json({ ok: true, data: rows });
}));

// Invite QR: PNG encoding ONLY the invite code (same qrcode library and
// approach as the delivery order QR). It authorizes nothing by itself —
// joining still runs the expiry/uses checks in /join-by-code.
conversationsRouter.get('/:id/invites/:code/qr', asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  await requireConversationAccess(conv, req.user);
  const { rows } = await query(
    'SELECT code FROM group_invites WHERE conversation_id = $1 AND code = $2', [conv.id, req.params.code],
  );
  if (!rows.length) throw notFound('Invite not found');
  const png = await QRCode.toBuffer(rows[0].code, { type: 'png', margin: 1, width: 240 });
  res.type('png').send(png);
}));

// POST /api/conversations/join-by-code — any authenticated user. Expired
// codes answer 410, exhausted codes 403; neither ever performs a silent join.
conversationsRouter.post('/join-by-code', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.joinByCode, req.body);
  const { rows } = await query('SELECT * FROM group_invites WHERE code = $1', [body.code]);
  if (!rows.length) throw notFound('Invite code not found');
  const invite = rows[0];
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    const err = new Error('This invite link has expired'); err.status = 410; err.code = 'INVITE_EXPIRED'; throw err;
  }
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    throw forbidden('This invite link has reached its maximum uses');
  }
  const member = await query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [invite.conversation_id, req.user.id],
  );
  if (member.rows.length) return res.json({ ok: true, data: { joined: true, alreadyMember: true, conversationId: invite.conversation_id } });
  const claimed = await query(
    `UPDATE group_invites SET uses = uses + 1 WHERE id = $1
       AND (max_uses IS NULL OR uses < max_uses) RETURNING id`,
    [invite.id],
  );
  if (!claimed.rows.length) throw forbidden('This invite link has reached its maximum uses');
  await query(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'member\') ON CONFLICT DO NOTHING',
    [invite.conversation_id, req.user.id],
  );
  await logGroup(query, invite.conversation_id, req.user.id, 'member_joined_via_invite', req.user.id, {});
  res.json({ ok: true, data: { joined: true, conversationId: invite.conversation_id } });
}));

// ---- 005: join requests (groups only; approval by admin+) ----
// Join mode is 'approval' by default (conversations.join_mode); direct-add
// by owner/admin and invite-code joins keep working regardless of mode,
// and rooms keep their existing direct-join behavior untouched.
conversationsRouter.post('/:id/join-requests', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const member = await query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conv.id, req.user.id],
  );
  if (member.rows.length) throw badRequest('You are already a member of this group');
  const pending = await query(
    'SELECT id FROM group_join_requests WHERE conversation_id = $1 AND requester_id = $2 AND status = \'REQUESTED\'',
    [conv.id, req.user.id],
  );
  if (pending.rows.length) throw conflict('You already have a pending join request for this group');
  const { rows } = await query(
    'INSERT INTO group_join_requests (id, conversation_id, requester_id) VALUES ($1, $2, $3) RETURNING *',
    [randomUUID(), conv.id, req.user.id],
  );
  res.status(201).json({ ok: true, data: rows[0] });
}));

conversationsRouter.get('/:id/join-requests', asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (!GROUP_ADMIN.includes(role)) throw forbidden('Only owners/admins can view join requests');
  const { rows } = await query(
    `SELECT r.*, u.nexora_id AS requester_nexora_id, u.display_name AS requester_display_name
       FROM group_join_requests r JOIN users u ON u.id = r.requester_id
      WHERE r.conversation_id = $1 ORDER BY r.created_at DESC`,
    [conv.id],
  );
  res.json({ ok: true, data: rows });
}));

async function decideJoinRequest(req, res, approve) {
  const conv = await getConversationOr404(req.params.id);
  requireGroup(conv);
  const { role } = await requireConversationAccess(conv, req.user);
  if (!GROUP_ADMIN.includes(role)) throw forbidden('Only owners/admins can decide join requests');
  assertUuid(req.params.requestId);
  const { rows } = await query(
    'SELECT * FROM group_join_requests WHERE id = $1 AND conversation_id = $2', [req.params.requestId, conv.id],
  );
  if (!rows.length) throw notFound('Join request not found');
  const jr = rows[0];
  if (jr.status !== 'REQUESTED') throw badRequest(`Join request is already ${jr.status}`);
  const updated = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    if (approve) {
      await q('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'member\') ON CONFLICT DO NOTHING',
        [conv.id, jr.requester_id]);
    }
    const { rows: out } = await q(
      `UPDATE group_join_requests SET status = $3, decided_by = $4, updated_at = now()
        WHERE id = $1 AND conversation_id = $2 RETURNING *`,
      [jr.id, conv.id, approve ? 'APPROVED' : 'DECLINED', req.user.id],
    );
    await logGroup(q, conv.id, req.user.id, approve ? 'join_approved' : 'join_declined', jr.requester_id, {});
    return out[0];
  });
  res.json({ ok: true, data: updated });
}
conversationsRouter.post('/:id/join-requests/:requestId/approve', requireCsrf, asyncHandler((req, res) => decideJoinRequest(req, res, true)));
conversationsRouter.post('/:id/join-requests/:requestId/decline', requireCsrf, asyncHandler((req, res) => decideJoinRequest(req, res, false)));

// ---- messagesRouter: edit / delete (mounted at /api/messages) ----
export const messagesRouter = Router();
messagesRouter.use(requireAuth);

messagesRouter.patch('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.editMessage, req.body);
  assertUuid(req.params.id);
  const { rows } = await query('SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!rows.length) throw notFound('Message not found');
  const msg = rows[0];
  // System messages (arrival/exchange announcements) are never editable.
  if (msg.is_system) throw forbidden('System messages cannot be edited');
  // Membership is checked before authorship: a removed member must not edit
  // even their own messages (previously author-only, membership unchecked).
  const conv = await getConversationOr404(msg.conversation_id);
  await requireConversationAccess(conv, req.user, { forSend: true });
  if (msg.sender_id !== req.user.id) throw forbidden('Only the author can edit a message');
  await query('UPDATE messages SET body = $1, edited_at = now() WHERE id = $2', [body.body, msg.id]);
  res.json({ ok: true, data: { edited: true } });
}));

messagesRouter.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  assertUuid(req.params.id);
  const { rows } = await query('SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!rows.length) throw notFound('Message not found');
  const msg = rows[0];
  // System messages are never deletable by users.
  if (msg.is_system) throw forbidden('System messages cannot be deleted');
  const conv = await getConversationOr404(msg.conversation_id);
  // Membership first (forSend = must currently be a member): a removed
  // author must not delete even their own message, and a removed admin
  // must not delete others' messages either.
  const { role } = await requireConversationAccess(conv, req.user, { forSend: true });
  let allowed = msg.sender_id === req.user.id;
  if (!allowed && conv.type === 'group') {
    // 005: moderators join owners/admins for message deletion in groups.
    allowed = ['owner', 'admin', 'moderator'].includes(role);
  } else if (!allowed && conv.type === 'room') {
    allowed = ['owner', 'admin'].includes(role);
  }
  if (!allowed) throw forbidden('Only the author or a group admin can delete a message');
  await query('UPDATE messages SET deleted_at = now() WHERE id = $1', [msg.id]);
  await audit(query, req.user.id, 'message.deleted', 'message', msg.id, {});
  res.json({ ok: true, data: { deleted: true } });
}));

// ---- 005: reply threads + reactions (mounted at /api/messages) ----
// GET /api/messages/:id/replies — participants only. Returns the parent
// message plus its replies (oldest first), each with reaction aggregates.
messagesRouter.get('/:id/replies', asyncHandler(async (req, res) => {
  assertUuid(req.params.id);
  const { rows } = await query('SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!rows.length) throw notFound('Message not found');
  const parent = rows[0];
  const conv = await getConversationOr404(parent.conversation_id);
  await requireConversationAccess(conv, req.user);
  const { rows: replies } = await query(
    `SELECT m.*, u.nexora_id AS sender_nexora_id, u.display_name AS sender_display_name,
            u.avatar_glyph AS sender_avatar_glyph
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.reply_to_id = $1 AND m.deleted_at IS NULL ORDER BY m.created_at ASC`,
    [parent.id],
  );
  const parentFull = await query(
    `SELECT m.*, u.nexora_id AS sender_nexora_id, u.display_name AS sender_display_name,
            u.avatar_glyph AS sender_avatar_glyph FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
    [parent.id],
  );
  const all = [parentFull.rows[0], ...replies];
  const serialized = await serializeMessagesWithMeta(all, req.user.id);
  res.json({ ok: true, data: { parent: serialized[0], replies: serialized.slice(1) } });
}));

// POST /api/messages/:id/reactions — toggle. Same emoji removes the
// reaction; a different emoji replaces it (one reaction per user per
// message). System messages reject with 400, as specified.
messagesRouter.post('/:id/reactions', requireCsrf, messageLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.messageReaction, req.body);
  assertUuid(req.params.id);
  const { rows } = await query('SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!rows.length) throw notFound('Message not found');
  const msg = rows[0];
  if (msg.is_system) throw badRequest('System messages cannot receive reactions');
  const conv = await getConversationOr404(msg.conversation_id);
  await requireConversationAccess(conv, req.user);
  const existing = await query(
    'SELECT emoji FROM message_reactions WHERE message_id = $1 AND user_id = $2', [msg.id, req.user.id],
  );
  let action;
  if (existing.rows.length && existing.rows[0].emoji === body.emoji) {
    await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [msg.id, req.user.id]);
    action = 'removed';
  } else if (existing.rows.length) {
    await query('UPDATE message_reactions SET emoji = $3 WHERE message_id = $1 AND user_id = $2',
      [msg.id, req.user.id, body.emoji]);
    action = 'replaced';
  } else {
    await query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
      [msg.id, req.user.id, body.emoji]);
    action = 'added';
  }
  const reactions = await loadReactions([msg.id], req.user.id);
  res.json({ ok: true, data: { action, reactions: reactions[msg.id] || [] } });
}));

export default conversationsRouter;
