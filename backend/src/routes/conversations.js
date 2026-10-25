// Conversations: public rooms, private DMs, private groups. Every read and
// write enforces membership in SQL (see services/authz.js). Messages are
// persisted, paginated, and broadcast over Socket.IO after insert.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
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
    editedAt: m.edited_at, createdAt: m.created_at,
    attachments: (m.attachments || []).map((a) => ({
      id: a.id, mimeType: a.mime_type, originalName: a.original_name,
      downloadUrl: signedDownloadUrl(a.id),
    })),
  };
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

conversationsRouter.get('/:id', asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  await requireConversationAccess(conv, req.user);
  const members = await query(
    `SELECT u.id, u.nexora_id, u.display_name, u.avatar_glyph, cm.role, cm.joined_at
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = $1 ORDER BY cm.joined_at`,
    [conv.id],
  );
  res.json({ ok: true, data: { ...conv, members: members.rows } });
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
  const attachments = await loadAttachments(rows.map((r) => r.id));
  const data = rows.map((r) => serializeMessage({ ...r, attachments: attachments[r.id] || [] }));
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
    const parent = await query('SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
      [body.replyToId, conv.id]);
    if (!parent.rows.length) throw badRequest('Reply target is not in this conversation');
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
  if (!['owner', 'admin'].includes(role)) throw forbidden('Only group owners/admins can add members');
  const body = validate(schemas.addMember, req.body);
  const member = await resolveUserByNexora(body.nexoraId);
  if (!member) throw notFound('No user with that NEXORA ID');
  if (await isBlockedBetween(req.user.id, member.id)) throw forbidden('Cannot add this user: a block exists');
  await query(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'member\') ON CONFLICT DO NOTHING',
    [conv.id, member.id],
  );
  await audit(query, req.user.id, 'conversation.member_added', 'conversation', conv.id, { member: body.nexoraId });
  res.json({ ok: true, data: { added: body.nexoraId } });
}));

conversationsRouter.delete('/:id/members/:userId', requireCsrf, asyncHandler(async (req, res) => {
  const conv = await getConversationOr404(req.params.id);
  const { role } = await requireConversationAccess(conv, req.user);
  assertUuid(req.params.userId);
  const targetId = req.params.userId;
  const isSelf = targetId === req.user.id;
  if (!isSelf && !['owner', 'admin'].includes(role)) throw forbidden('Only owners/admins can remove members');
  if (!isSelf && conv.type === 'dm') throw forbidden('DM members cannot be removed');
  const target = await query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conv.id, targetId],
  );
  if (!target.rows.length) throw notFound('That user is not a member');
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
  res.json({ ok: true, data: { removed: true } });
}));

// ---- messagesRouter: edit / delete (mounted at /api/messages) ----
export const messagesRouter = Router();
messagesRouter.use(requireAuth);

messagesRouter.patch('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.editMessage, req.body);
  assertUuid(req.params.id);
  const { rows } = await query('SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!rows.length) throw notFound('Message not found');
  const msg = rows[0];
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
  const conv = await getConversationOr404(msg.conversation_id);
  // Membership first (forSend = must currently be a member): a removed
  // author must not delete even their own message, and a removed admin
  // must not delete others' messages either.
  const { role } = await requireConversationAccess(conv, req.user, { forSend: true });
  let allowed = msg.sender_id === req.user.id;
  if (!allowed && ['group', 'room'].includes(conv.type)) {
    allowed = ['owner', 'admin'].includes(role);
  }
  if (!allowed) throw forbidden('Only the author or a group admin can delete a message');
  await query('UPDATE messages SET deleted_at = now() WHERE id = $1', [msg.id]);
  await audit(query, req.user.id, 'message.deleted', 'message', msg.id, {});
  res.json({ ok: true, data: { deleted: true } });
}));

export default conversationsRouter;
