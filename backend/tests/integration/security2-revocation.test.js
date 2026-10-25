// Phase 4 (C) — Session revocation.
// Two sessions per user, logout vs other session, expiry (real PG only),
// fixation across login/register/claim boundaries, cookie attributes,
// revocation isolation between users, and live-socket kill on logout.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { io } from 'socket.io-client';
import { startTestServer, Session } from '../helpers.js';

process.env.AUTH_RATE_LIMIT_MAX = '1000';
let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { if (srv) await srv.close(); });

const uniq = (p) => `sec2c-${p}-${Math.random().toString(36).slice(2, 10)}@nexora.local`;
const HAS_DB = !!process.env.NEXORA_TEST_DATABASE_URL;
function connectSocket(session) {
  return new Promise((resolve, reject) => {
    const s = io(srv.baseUrl, { extraHeaders: { Cookie: session.cookieHeader() }, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
function socketRejected(session) {
  return new Promise((resolve) => {
    const s = io(srv.baseUrl, { extraHeaders: { Cookie: session.cookieHeader() }, reconnection: false });
    s.on('connect', () => resolve(false));
    s.on('connect_error', () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
}
function waitDisconnect(socket, ms = 3000) {
  return new Promise((resolve) => {
    if (!socket.connected) return resolve(true);
    socket.once('disconnect', () => resolve(true));
    setTimeout(() => resolve(false), ms);
  });
}
async function registered(name) {
  const s = new Session(srv.baseUrl); await s.initCsrf();
  const email = uniq(name);
  assert.equal((await s.register(email, 'Password123!x', name)).status, 200);
  return { s, email };
}

test('revoking one session leaves the other session fully working (HTTP + socket)', async () => {
  const { s, email } = await registered('TwoSess');
  const s2 = new Session(srv.baseUrl); await s2.initCsrf();
  assert.equal((await s2.login(email, 'Password123!x')).status, 200);
  assert.notEqual(s.cookies.nx_session, s2.cookies.nx_session, 'distinct logins get distinct tokens');
  const s2Sock = await connectSocket(s2);
  try {
    const sOld = { ...s.cookies }; const sOldCsrf = s.csrf;
    const stale = new Session(srv.baseUrl); stale.cookies = { ...sOld }; stale.csrf = sOldCsrf;
    const out = await s.req('POST', '/api/auth/logout', {});
    assert.equal(out.status, 200);
    assert.equal(out.json.data.loggedOut, true);
    assert.equal((await stale.req('GET', '/api/auth/me')).status, 401, 'logged-out session dead');
    assert.equal((await s2.req('GET', '/api/auth/me')).status, 200, 'other session unaffected');
    const stillOk = await connectSocket(s2);
    stillOk.disconnect();
  } finally { s2Sock.disconnect(); }
});

test('logout kills a live socket connection, not just future connects', async () => {
  const { s } = await registered('LiveSock');
  const sock = await connectSocket(s);
  try {
    assert.equal(sock.connected, true);
    const oldCookies = { ...s.cookies };
    const stale = new Session(srv.baseUrl); stale.cookies = { ...oldCookies };
    assert.equal((await s.req('POST', '/api/auth/logout', {})).status, 200);
    assert.equal(await waitDisconnect(sock), true, 'existing socket must be disconnected on logout');
    assert.equal(await socketRejected(stale), true, 'reconnect with the revoked token is rejected');
  } finally { sock.disconnect(); }
});

test('expired session is rejected on HTTP and socket, and spares other users (real PG only)', { skip: !HAS_DB }, async () => {
  const { s } = await registered('Expiring');
  const other = await registered('Spared');
  const pool = new pg.Pool({ connectionString: process.env.NEXORA_TEST_DATABASE_URL });
  try {
    await pool.query("UPDATE user_sessions SET expires_at = now() - interval '1 hour' WHERE user_id = $1", [s.user.id]);
  } finally { await pool.end(); }
  assert.equal((await s.req('GET', '/api/auth/me')).status, 401, 'expired session rejected');
  assert.equal(await socketRejected(s), true, 'expired session cannot open a socket');
  assert.equal((await other.s.req('GET', '/api/auth/me')).status, 200, 'expiry is per-session, not global');
});

test('login rotates the token: the pre-login token never becomes the authed session', async () => {
  const anon = new Session(srv.baseUrl); await anon.initCsrf();
  await anon.anonymous('PreLogin');
  const preCookie = anon.cookies.nx_session;
  const { email } = await registered('logintarget');
  const login = await anon.login(email, 'Password123!x');
  assert.equal(login.status, 200);
  assert.notEqual(anon.cookies.nx_session, preCookie, 'login must issue a fresh token');
  assert.equal((await anon.req('GET', '/api/auth/me')).json.data.user.email, email);
  // The pre-login token still only authenticates the anonymous account.
  const stale = new Session(srv.baseUrl); stale.cookies = { nx_session: preCookie };
  const me = await stale.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.data.user.isAnonymous, true, 'old token was not fixated onto the new account');
});

test('register issues a fresh session from a CSRF-only client', async () => {
  const s = new Session(srv.baseUrl); await s.initCsrf();
  assert.equal(s.cookies.nx_session, undefined, 'no session before register');
  assert.equal((await s.register(uniq('fresh'), 'Password123!x', 'Fresh')).status, 200);
  assert.ok(s.cookies.nx_session, 'register sets a session cookie');
  assert.equal((await s.req('GET', '/api/auth/me')).status, 200);
});

test('session cookie attributes: HttpOnly + SameSite=Lax, Secure only in production', async () => {
  const s = new Session(srv.baseUrl);
  const r = await s.req('GET', '/api/auth/csrf');
  assert.equal(r.status, 200);
  s.csrf = r.json.data.csrfToken;
  const anon = await s.anonymous('CookieCheck');
  assert.equal(anon.status, 200);
  // Re-read Set-Cookie from a fresh anonymous call to inspect attributes.
  const probe = new Session(srv.baseUrl); await probe.initCsrf();
  const raw = await fetch(srv.baseUrl + '/api/auth/anonymous', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: probe.cookieHeader(), 'X-CSRF-Token': probe.csrf },
    body: JSON.stringify({ displayName: 'Attrs' }),
  });
  const setCookies = raw.headers.getSetCookie();
  const sess = setCookies.find((c) => c.startsWith('nx_session='));
  assert.ok(sess, 'nx_session Set-Cookie present');
  assert.match(sess, /HttpOnly/i, 'session cookie must be HttpOnly');
  assert.match(sess, /SameSite=Lax/i, 'session cookie must be SameSite=Lax');
  if (process.env.NODE_ENV !== 'production') {
    assert.ok(!/;\s*Secure/i.test(sess), 'Secure is off in dev (code enables it only in production)');
  }
  const csrfCookie = setCookies.find((c) => c.startsWith('nx_csrf='));
  assert.ok(csrfCookie && !/HttpOnly/i.test(csrfCookie), 'CSRF cookie is intentionally JS-readable (double-submit)');
});

test('revoking user A never touches user B', async () => {
  const a = await registered('UserA');
  const b = await registered('UserB');
  const aOld = { ...a.s.cookies };
  const aStale = new Session(srv.baseUrl); aStale.cookies = { ...aOld };
  assert.equal((await a.s.req('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await aStale.req('GET', '/api/auth/me')).status, 401);
  assert.equal((await b.s.req('GET', '/api/auth/me')).status, 200);
});

test('there is no blanket revoke-all endpoint besides logout (per-session) and delete (all)', async () => {
  const { s } = await registered('NoRevokeAll');
  assert.equal((await s.req('POST', '/api/auth/revoke-all', {})).status, 404);
  assert.equal((await s.req('POST', '/api/auth/revoke', {})).status, 404);
});
