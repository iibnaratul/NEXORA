// Authentication: anonymous (server-issued NEXORA ID), password register/login,
// claim (anonymous → password account), logout, self, account deletion.
// Passwords are bcrypt-hashed. Sessions are server-side rows (see middleware).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { schemas, validate } from '../validation/schemas.js';
import {
  ok, created, asyncHandler, badRequest, unauthorized, conflict, notConfigured,
  newNexoraId, randomToken, sha256,
} from '../utils/helpers.js';
import { createSession, loadSession, requireAuth, requireCsrf, revokeSession, sessionCookieOptions } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { audit } from '../services/authz.js';

export const authRouter = Router();

function publicUser(u) {
  return {
    id: u.id, nexoraId: u.nexora_id, displayName: u.display_name,
    avatarGlyph: u.avatar_glyph, role: u.role, isAnonymous: u.is_anonymous,
    email: u.email || null,
  };
}

async function insertUser({ email, passwordHash, isAnonymous, displayName, avatarGlyph }) {
  const id = randomUUID();
  let nexoraId = newNexoraId();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await query(
        `INSERT INTO users (id, nexora_id, email, password_hash, is_anonymous, display_name, avatar_glyph)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, nexoraId, email || null, passwordHash || null, isAnonymous, displayName || '', avatarGlyph || '◈'],
      );
      const user = rows[0];
      await query(
        'INSERT INTO public_profiles (user_id, display_name, avatar_glyph) VALUES ($1, $2, $3)',
        [user.id, user.display_name, user.avatar_glyph],
      );
      return user;
    } catch (e) {
      if (e.code === '23505') { nexoraId = newNexoraId(); continue; } // NEXORA ID collision: retry
      throw e;
    }
  }
  throw new Error('Could not allocate a unique NEXORA ID');
}

// GET /api/auth/csrf — sets the double-submit cookie and returns the token.
// The frontend calls this once on load and sends X-CSRF-Token on mutations.
// Authenticated callers get their SESSION's stored token: requireCsrf()
// matches the header against that token, so minting a fresh random token
// here (the old behavior) broke every authenticated mutation after a page
// reload. Unauthenticated callers still get a fresh pre-auth token, which
// requireCsrf() matches against the cookie for login/register/anonymous.
authRouter.get('/csrf', asyncHandler(async (req, res) => {
  const session = await loadSession(req).catch(() => null);
  const token = session ? session.csrfToken : randomToken(16);
  res.cookie(config.csrfCookie, token, {
    httpOnly: false, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/',
    maxAge: config.sessionTtlDays * 24 * 3600 * 1000,
  });
  res.json({ ok: true, data: { csrfToken: token } });
}));

// POST /api/auth/anonymous — server-issued pseudonymous identity. No email,
// no password, no real identity collected. The NEXORA ID is the public handle.
authRouter.post('/anonymous', authLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.anonymous, req.body);
  const user = await insertUser({ isAnonymous: true, displayName: body.displayName, avatarGlyph: body.avatarGlyph });
  const csrf = await createSession(res, user, req.headers['user-agent']);
  await audit(query, user.id, 'auth.anonymous_created', 'user', user.id, {});
  res.json({ ok: true, data: { user: publicUser(user), csrfToken: csrf } });
}));

authRouter.post('/register', authLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.register, req.body);
  const existing = await query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [body.email]);
  if (existing.rows.length) throw conflict('An account with this email already exists');
  const hash = await bcrypt.hash(body.password, config.bcryptRounds);
  const user = await insertUser({
    email: body.email, passwordHash: hash, isAnonymous: false,
    displayName: body.displayName, avatarGlyph: body.avatarGlyph,
  });
  const csrf = await createSession(res, user, req.headers['user-agent']);
  await audit(query, user.id, 'auth.registered', 'user', user.id, {});
  res.json({ ok: true, data: { user: publicUser(user), csrfToken: csrf } });
}));

authRouter.post('/login', authLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.login, req.body);
  const { rows } = await query('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [body.email]);
  const user = rows[0];
  // Same response for unknown email and wrong password: no account enumeration.
  if (!user || !user.password_hash || !(await bcrypt.compare(body.password, user.password_hash))) {
    throw unauthorized('Invalid email or password');
  }
  const csrf = await createSession(res, user, req.headers['user-agent']);
  await audit(query, user.id, 'auth.login', 'user', user.id, {});
  res.json({ ok: true, data: { user: publicUser(user), csrfToken: csrf } });
}));

// Best-effort socket kill: revocation must also end live connections, not
// just future handshakes (a socket's user snapshot otherwise outlives logout).
async function disconnectUserSockets(req, userId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) s.disconnect(true);
  } catch { /* revocation itself already happened; kick failure must not fail it */ }
}

// POST /api/auth/claim — turn an anonymous account into a password account.
authRouter.post('/claim', requireAuth, requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.claim, req.body);
  if (!req.user.isAnonymous) throw badRequest('Account already has credentials');
  const existing = await query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [body.email]);
  if (existing.rows.length) throw conflict('An account with this email already exists');
  const hash = await bcrypt.hash(body.password, config.bcryptRounds);
  const { rows } = await query(
    'UPDATE users SET email = $1, password_hash = $2, is_anonymous = FALSE, updated_at = now() WHERE id = $3 RETURNING *',
    [body.email, hash, req.user.id],
  );
  // Session-fixation defence: claiming is a privilege escalation
  // (anonymous -> credentialed), so the pre-claim token is revoked and a
  // fresh session is issued. Callers must adopt the returned csrfToken.
  await query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [req.session.sessionId]);
  const csrf = await createSession(res, rows[0], req.headers['user-agent']);
  await audit(query, req.user.id, 'auth.claimed', 'user', req.user.id, {});
  res.json({ ok: true, data: { user: publicUser(rows[0]), csrfToken: csrf } });
}));

authRouter.post('/logout', requireAuth, requireCsrf, revokeSession, asyncHandler(async (req, res) => {
  await disconnectUserSockets(req, req.user.id);
  res.json({ ok: true, data: { loggedOut: true } });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  res.json({ ok: true, data: { user: req.user } });
}));

// Password recovery: no email provider is configured in this deployment, so
// this honestly reports that instead of pretending to send a reset email.
authRouter.post('/forgot', authLimiter, requireCsrf, asyncHandler(async () => {
  throw notConfigured('Password recovery email is not configured. Contact an administrator to reset your account.');
}));

// DELETE /api/auth/me — soft-delete + revoke every session. Content keeps its
// NEXORA ID attribution (messages/deliveries are records other people rely
// on); the profile is cleared. A hard purge is an admin operation, documented
// in docs/SECURITY.md.
authRouter.delete('/me', requireAuth, requireCsrf, asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    await q('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1', [req.user.id]);
    await q(
      `UPDATE users SET deleted_at = now(), display_name = '', email = NULL, password_hash = NULL,
              is_anonymous = TRUE, updated_at = now() WHERE id = $1`,
      [req.user.id],
    );
    await q('UPDATE public_profiles SET display_name = \'\', bio = \'\' WHERE user_id = $1', [req.user.id]);
    await audit(q, req.user.id, 'auth.account_deleted', 'user', req.user.id, {});
  });
  await disconnectUserSockets(req, req.user.id);
  res.clearCookie(config.sessionCookie, { path: '/' });
  res.clearCookie(config.csrfCookie, { path: '/' });
  res.json({ ok: true, data: { deleted: true } });
}));

export default authRouter;
