// Profiles, blocks, reports. Public profiles expose only the pseudonymous
// fields — never email, never session data, never real identity (none is
// collected for anonymous accounts in the first place).
import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { schemas, validate } from '../validation/schemas.js';
import { ok, asyncHandler, badRequest, notFound } from '../utils/helpers.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { audit } from '../services/authz.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

// Public profile lookup by NEXORA ID (used to start DMs / add group members).
usersRouter.get('/by-nexora/:nexoraId', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT u.nexora_id, u.display_name, u.avatar_glyph, p.bio
       FROM users u LEFT JOIN public_profiles p ON p.user_id = u.id
      WHERE u.nexora_id = $1 AND u.deleted_at IS NULL`,
    [req.params.nexoraId],
  );
  if (!rows.length) throw notFound('No user with that NEXORA ID');
  res.json({ ok: true, data: rows[0] });
}));

usersRouter.patch('/me', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.updateMe, req.body);
  const sets = [];
  const params = [];
  if (body.displayName !== undefined) { params.push(body.displayName); sets.push(`display_name = $${params.length}`); }
  if (body.avatarGlyph !== undefined) { params.push(body.avatarGlyph); sets.push(`avatar_glyph = $${params.length}`); }
  params.push(req.user.id);
  // Bio-only updates leave `sets` empty; running the UPDATE then would be
  // `SET , updated_at` — a Postgres syntax error (42601) surfaced as a 500.
  if (sets.length) {
    await query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  await query(
    `UPDATE public_profiles SET display_name = COALESCE($1, display_name),
       avatar_glyph = COALESCE($2, avatar_glyph), bio = COALESCE($3, bio), updated_at = now()
     WHERE user_id = $4`,
    [body.displayName ?? null, body.avatarGlyph ?? null, body.bio ?? null, req.user.id],
  );
  res.json({ ok: true, data: { updated: true } });
}));

usersRouter.get('/me/blocks', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT u.nexora_id, u.display_name, b.created_at
       FROM blocked_users b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [req.user.id],
  );
  res.json({ ok: true, data: rows });
}));

usersRouter.post('/me/blocks', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.block, req.body);
  const { rows } = await query('SELECT id FROM users WHERE nexora_id = $1 AND deleted_at IS NULL', [body.nexoraId]);
  if (!rows.length) throw notFound('No user with that NEXORA ID');
  const blockedId = rows[0].id;
  if (blockedId === req.user.id) throw badRequest('You cannot block yourself');
  await query(
    'INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.id, blockedId],
  );
  await audit(query, req.user.id, 'user.blocked', 'user', blockedId, {});
  res.json({ ok: true, data: { blocked: body.nexoraId } });
}));

usersRouter.delete('/me/blocks/:nexoraId', requireCsrf, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT id FROM users WHERE nexora_id = $1', [req.params.nexoraId]);
  if (!rows.length) throw notFound('No user with that NEXORA ID');
  await query('DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, rows[0].id]);
  res.json({ ok: true, data: { unblocked: req.params.nexoraId } });
}));

usersRouter.post('/reports', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.report, req.body);
  const { rows } = await query(
    'INSERT INTO reports (id, reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [crypto.randomUUID(), req.user.id, body.targetType, body.targetId, body.reason],
  );
  await audit(query, req.user.id, 'user.reported', body.targetType, body.targetId, {});
  res.status(201).json({ ok: true, data: { id: rows[0].id } });
}));

export default usersRouter;
