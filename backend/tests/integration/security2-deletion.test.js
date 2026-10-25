// Phase 4 (B) — Account deletion, tested against docs/SECURITY.md:
// soft delete (sessions revoked, email/password cleared, profile blanked),
// messages/delivery records keep NEXORA ID attribution, audit preserved,
// no ownership transfer or elevation, repeat delete is safe (no 500).
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { io } from 'socket.io-client';
import { startTestServer, Session } from '../helpers.js';

process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.MESSAGE_RATE_LIMIT_MAX = '1000';
let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { if (srv) await srv.close(); });

const uniq = (p) => `sec2d-${p}-${Math.random().toString(36).slice(2, 10)}@nexora.local`;
const HAS_DB = !!process.env.NEXORA_TEST_DATABASE_URL;
async function db() {
  const pool = new pg.Pool({ connectionString: process.env.NEXORA_TEST_DATABASE_URL });
  return pool;
}
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
async function registered(name) {
  const s = new Session(srv.baseUrl); await s.initCsrf();
  const email = uniq(name);
  const r = await s.register(email, 'Password123!x', name);
  assert.equal(r.status, 200);
  return { s, email };
}

test('delete an isolated account: sessions die, login fails, profile vanishes', async () => {
  const { s, email } = await registered('Doomed');
  const observer = await registered('Observer');
  const nx = s.user.nexoraId;
  const sock = await connectSocket(s);
  try {
  // Preserve the pre-delete credentials: the delete response clears the
  // caller's cookies, so testing with the live Session would prove nothing.
  const oldCookies = { ...s.cookies }; const oldCsrf = s.csrf;
  const stale = new Session(srv.baseUrl); stale.cookies = { ...oldCookies }; stale.csrf = oldCsrf;
  const del = await s.req('DELETE', '/api/auth/me');
  assert.equal(del.status, 200);
  assert.equal(del.json.data.deleted, true);
  assert.equal((await stale.req('GET', '/api/auth/me')).status, 401, 'old cookie + CSRF rejected after delete');
  assert.equal(await socketRejected(stale), true, 'socket connect rejected after delete');
  const again = new Session(srv.baseUrl); await again.initCsrf();
  assert.equal((await again.login(email, 'Password123!x')).status, 401, 'deleted user cannot log in');
  const lookup = await observer.s.req('GET', `/api/users/by-nexora/${nx}`);
  assert.equal(lookup.status, 404, 'blanked profile must not resolve by NEXORA ID');
  } finally { sock.disconnect(); }
});

test('deletion revokes ALL sessions of the user, not just the deleting one', async () => {
  const { s, email } = await registered('Multi');
  const s2 = new Session(srv.baseUrl); await s2.initCsrf();
  assert.equal((await s2.login(email, 'Password123!x')).status, 200);
  const s2Old = { ...s2.cookies }; const s2Csrf = s2.csrf;
  const s2Stale = new Session(srv.baseUrl); s2Stale.cookies = { ...s2Old }; s2Stale.csrf = s2Csrf;
  assert.equal((await s.req('DELETE', '/api/auth/me')).status, 200);
  assert.equal((await s2Stale.req('GET', '/api/auth/me')).status, 401, 'second session also revoked');
  assert.equal(await socketRejected(s2Stale), true);
});

test('second delete of the same account is safe and consistent, never a 500', async () => {
  const { s } = await registered('Repeat');
  const oldCookies = { ...s.cookies }; const oldCsrf = s.csrf;
  assert.equal((await s.req('DELETE', '/api/auth/me')).status, 200);
  const stale = new Session(srv.baseUrl); stale.cookies = { ...oldCookies }; stale.csrf = oldCsrf;
  const second = await stale.req('DELETE', '/api/auth/me');
  assert.equal(second.status, 401, 'session is gone, so a repeat delete is unauthorized — not a crash');
  assert.ok(!JSON.stringify(second.json).match(/node_modules|at .*\.js:|SELECT|stack/i), 'no internals in the response');
  const fresh = new Session(srv.baseUrl);
  assert.equal((await fresh.req('DELETE', '/api/auth/me')).status, 401);
});

test('deletion keeps messages attributed, transfers no ownership, elevates nobody', async () => {
  const victim = await registered('Victim');
  const other = await registered('Other');
  const group = await victim.s.req('POST', '/api/conversations', {
    type: 'group', name: 'Shared', memberNexoraIds: [other.s.user.nexoraId],
  });
  assert.equal(group.status, 201);
  const gid = group.json.data.id;
  const sent = await victim.s.req('POST', `/api/conversations/${gid}/messages`, { body: 'kept message' });
  assert.equal(sent.status, 201);
  const beforeRole = (await other.s.req('GET', `/api/conversations/${gid}`)).json.data.members
    .find((m) => m.id === other.s.user.id).role;
  assert.equal(beforeRole, 'member');
  assert.equal((await victim.s.req('DELETE', '/api/auth/me')).status, 200);
  // Other participant still reads the history, with the victim's NEXORA ID intact.
  const msgs = await other.s.req('GET', `/api/conversations/${gid}/messages`);
  assert.equal(msgs.status, 200);
  assert.equal(msgs.json.data.length, 1);
  assert.equal(msgs.json.data[0].body, 'kept message');
  assert.equal(msgs.json.data[0].senderNexoraId, victim.s.user.nexoraId, 'NEXORA ID attribution retained per doc');
  const members = (await other.s.req('GET', `/api/conversations/${gid}`)).json.data.members;
  const otherAfter = members.find((m) => m.id === other.s.user.id);
  assert.equal(otherAfter.role, 'member', 'deletion must not promote the survivor');
  assert.ok(!members.some((m) => m.id === other.s.user.id && m.role === 'owner'), 'no ownership transfer to survivor');
  const me = await other.s.req('GET', '/api/auth/me');
  assert.equal(me.json.data.user.role, 'user', 'deletion must not elevate another user');
});

test('audit record for the deletion survives (real PostgreSQL only)', { skip: !HAS_DB }, async () => {
  const { s } = await registered('Audited');
  const uid = s.user.id;
  assert.equal((await s.req('DELETE', '/api/auth/me')).status, 200);
  const pool = await db();
  try {
    const { rows } = await pool.query(
      "SELECT action, actor_id FROM audit_logs WHERE action = 'auth.account_deleted' AND actor_id = $1", [uid]);
    assert.equal(rows.length, 1, 'auth.account_deleted audit row must survive soft delete');
  } finally { await pool.end(); }
});

test('a deleted email is freed for a new registration (documented side effect of clearing it)', async () => {
  const { s, email } = await registered('Freed');
  const oldId = s.user.id;
  assert.equal((await s.req('DELETE', '/api/auth/me')).status, 200);
  const fresh = new Session(srv.baseUrl); await fresh.initCsrf();
  const r = await fresh.register(email, 'Password123!x', 'Reborn');
  assert.equal(r.status, 200, 'cleared email may be registered again as a new account');
  assert.notEqual(r.json.data.user.id, oldId, 're-registration creates a distinct account, not a resurrection');
});
