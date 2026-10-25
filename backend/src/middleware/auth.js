// Session authentication + CSRF double-submit.
// Sessions are server-side rows; the cookie holds only an opaque token, and
// only its SHA-256 hash is stored. Sessions expire and can be revoked.
import { randomUUID as cryptoRandomUuid } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { parseCookies, sha256, randomToken, unauthorized, forbidden } from '../utils/helpers.js';

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 3600 * 1000,
  };
}

export async function createSession(res, user, userAgent) {
  const token = randomToken();
  const csrf = randomToken(16);
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 3600 * 1000);
  await query(
    `INSERT INTO user_sessions (id, user_id, token_hash, csrf_token, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [cryptoRandomUuid(), user.id, sha256(token), csrf, expiresAt, userAgent || null],
  );
  res.cookie(config.sessionCookie, token, sessionCookieOptions());
  res.cookie(config.csrfCookie, csrf, {
    httpOnly: false, sameSite: 'lax', secure: sessionCookieOptions().secure, path: '/',
    maxAge: sessionCookieOptions().maxAge,
  });
  return csrf;
}

export async function loadSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[config.sessionCookie];
  if (!token) return null;
  const { rows } = await query(
    `SELECT s.*, u.id AS user_id, u.nexora_id, u.email, u.role, u.is_anonymous,
            u.display_name, u.avatar_glyph, u.deleted_at
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!rows.length) return null;
  const s = rows[0];
  if (s.deleted_at) return null;
  return {
    sessionId: s.id,
    csrfToken: s.csrf_token,
    user: {
      id: s.user_id, nexoraId: s.nexora_id, email: s.email, role: s.role,
      isAnonymous: s.is_anonymous, displayName: s.display_name, avatarGlyph: s.avatar_glyph,
    },
  };
}

export async function requireAuth(req, res, next) {
  try {
    const session = await loadSession(req);
    if (!session) throw unauthorized();
    req.session = session;
    req.user = session.user;
    next();
  } catch (e) { next(e); }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role !== role) return next(forbidden('Admin only'));
    next();
  };
}

// CSRF: state-changing requests must carry X-CSRF-Token matching either the
// session's stored token (authenticated) or the csrf cookie (pre-auth flows
// such as login/register/anonymous, after GET /api/auth/csrf sets the cookie).
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookies = parseCookies(req.headers.cookie || '');
  const header = req.headers['x-csrf-token'];
  if (!header) return next(forbidden('Missing CSRF token', 'CSRF_MISSING'));
  if (req.session && header === req.session.csrfToken) return next();
  if (!req.session && cookies[config.csrfCookie] && header === cookies[config.csrfCookie]) return next();
  return next(forbidden('Invalid CSRF token', 'CSRF_INVALID'));
}

export async function revokeSession(req, res, next) {
  try {
    if (req.session) {
      await query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [req.session.sessionId]);
    }
    res.clearCookie(config.sessionCookie, { path: '/' });
    res.clearCookie(config.csrfCookie, { path: '/' });
    next();
  } catch (e) { next(e); }
}
