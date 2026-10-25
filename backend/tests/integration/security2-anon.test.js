// Phase 4 (A) — Anonymous ID claim security.
// Covers: server-issued IDs, invalid inputs, impersonation fields, repeated /
// conflicting / concurrent claims, session binding & rotation on claim, and
// that public responses leak no private account fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';

process.env.AUTH_RATE_LIMIT_MAX = '1000';
let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { if (srv) await srv.close(); });

const uniq = (p) => `sec2a-${p}-${Math.random().toString(36).slice(2, 10)}@nexora.local`;
function collectKeys(obj, out = []) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) { out.push(k); collectKeys(v, out); }
  }
  return out;
}
async function freshAnon(name = 'Anon') {
  const s = new Session(srv.baseUrl); await s.initCsrf();
  const r = await s.anonymous(name);
  assert.equal(r.status, 200);
  return s;
}

test('anonymous identity is server-issued and public responses leak no private fields', async () => {
  const s = await freshAnon('LeakCheck');
  const body = JSON.stringify(s.user);
  assert.match(s.user.nexoraId, /^NXR-[2-9A-HJ-NP-Z]{8}$/);
  assert.equal(s.user.isAnonymous, true);
  assert.equal(s.user.email, null);
  const keys = collectKeys(s.user);
  for (const banned of ['password_hash', 'passwordHash', 'password', 'token_hash', 'tokenHash', 'session_token', 'csrf_token']) {
    assert.ok(!keys.includes(banned), `response must not contain ${banned}`);
  }
  assert.ok(!body.includes('password_hash') && !body.includes('token_hash'));
  const me = await s.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  const meKeys = collectKeys(me.json.data.user);
  for (const banned of ['password_hash', 'passwordHash', 'token_hash', 'tokenHash']) assert.ok(!meKeys.includes(banned));
});

test('invalid anonymous inputs are rejected', async () => {
  const s = new Session(srv.baseUrl); await s.initCsrf();
  assert.equal((await s.req('POST', '/api/auth/anonymous', { displayName: 'x'.repeat(25) })).status, 400);
  assert.equal((await s.req('POST', '/api/auth/anonymous', { avatarGlyph: 'x'.repeat(11) })).status, 400);
  assert.equal((await s.req('POST', '/api/auth/anonymous', { displayName: 123 })).status, 400);
});

test('impersonation fields on anonymous creation are ignored, never bound', async () => {
  const victim = await freshAnon('Victim');
  const s = new Session(srv.baseUrl); await s.initCsrf();
  const r = await s.req('POST', '/api/auth/anonymous', {
    displayName: 'Impostor', nexoraId: victim.user.nexoraId, id: victim.user.id,
    email: 'victim@nexora.local', role: 'admin',
  });
  assert.equal(r.status, 200);
  assert.notEqual(r.json.data.user.nexoraId, victim.user.nexoraId, 'supplied NXR ID must not be adopted');
  assert.notEqual(r.json.data.user.id, victim.user.id, 'supplied user id must not be adopted');
  assert.equal(r.json.data.user.role, 'user', 'supplied role must not be adopted');
  assert.equal(r.json.data.user.email, null, 'supplied email must not be adopted');
  assert.match(r.json.data.user.nexoraId, /^NXR-[2-9A-HJ-NP-Z]{8}$/);
});

test('claim keeps the NEXORA ID but rotates the session; the old token dies', async () => {
  const s = await freshAnon('Claimer');
  const oldCookie = s.cookies.nx_session;
  const oldNx = s.user.nexoraId;
  const email = uniq('claim');
  const claim = await s.req('POST', '/api/auth/claim', { email, password: 'Password123!x' });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.data.user.nexoraId, oldNx, 'NEXORA ID survives claiming');
  assert.equal(claim.json.data.user.isAnonymous, false);
  assert.notEqual(s.cookies.nx_session, oldCookie, 'session token must rotate on claim (privilege escalation)');
  if (claim.json.data.csrfToken) s.csrf = claim.json.data.csrfToken;
  const me = await s.req('GET', '/api/auth/me');
  assert.equal(me.status, 200, 'rotated session must work');
  // The pre-claim token must no longer authenticate anything.
  const stale = new Session(srv.baseUrl);
  stale.cookies = { nx_session: oldCookie };
  stale.csrf = 'stale';
  assert.equal((await stale.req('GET', '/api/auth/me')).status, 401, 'pre-claim session must be dead');
  // And the claimed credentials work from a fresh login.
  const s2 = new Session(srv.baseUrl); await s2.initCsrf();
  assert.equal((await s2.login(email, 'Password123!x')).status, 200);
});

test('repeated claim is rejected and the account keeps working', async () => {
  const s = await freshAnon('Twice');
  const email = uniq('twice');
  const first = await s.req('POST', '/api/auth/claim', { email, password: 'Password123!x' });
  assert.equal(first.status, 200);
  // Post-fix, claim rotates the session: adopt the new CSRF token (as any
  // correct client must) before making the second claim.
  if (first.json.data.csrfToken) s.csrf = first.json.data.csrfToken;
  const again = await s.req('POST', '/api/auth/claim', { email: uniq('twice2'), password: 'Password123!x' });
  assert.equal(again.status, 400, 'second claim must fail: account already has credentials');
  const me = await s.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.data.user.email, email, 'failed repeat claim must not change the account');
});

test('claim to an already-registered email conflicts and leaves the account anonymous', async () => {
  const owner = new Session(srv.baseUrl); await owner.initCsrf();
  const taken = uniq('taken');
  assert.equal((await owner.register(taken, 'Password123!x', 'Owner')).status, 200);
  const s = await freshAnon('Squatter');
  const r = await s.req('POST', '/api/auth/claim', { email: taken, password: 'Password123!x' });
  assert.equal(r.status, 409);
  const me = await s.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.data.user.isAnonymous, true, 'failed claim must not de-anonymize');
  assert.equal(me.json.data.user.email, null);
});

test('concurrent duplicate claims (same email) produce one account, no 500, no duplicates', async () => {
  const s = await freshAnon('Racer');
  const email = uniq('race');
  const nx = s.user.nexoraId;
  const [a, b] = await Promise.all([
    s.req('POST', '/api/auth/claim', { email, password: 'Password123!x' }),
    s.req('POST', '/api/auth/claim', { email, password: 'Password123!x' }),
  ]);
  // 401 is also a safe outcome: the loser's request can arrive after the
  // winner revoked the shared pre-claim session. Anything but a 500 is safe.
  for (const r of [a, b]) assert.ok([200, 400, 401, 409].includes(r.status), `no 500 from concurrent claims, got ${r.status}`);
  assert.ok([a, b].some((r) => r.status === 200), 'at least one concurrent claim must succeed');
  const s2 = new Session(srv.baseUrl); await s2.initCsrf();
  assert.equal((await s2.login(email, 'Password123!x')).status, 200);
  assert.equal(s2.user.nexoraId, nx, 'exactly one account ends up owning the email');
  const lookup = await s2.req('GET', `/api/users/by-nexora/${nx}`);
  assert.equal(lookup.status, 200, 'single profile still resolves by NEXORA ID');
});

test('concurrent claims with different emails end in one consistent account', async () => {
  const s = await freshAnon('Racer2');
  const e1 = uniq('race1'), e2 = uniq('race2');
  const [a, b] = await Promise.all([
    s.req('POST', '/api/auth/claim', { email: e1, password: 'Password123!x' }),
    s.req('POST', '/api/auth/claim', { email: e2, password: 'Password123!x' }),
  ]);
  for (const r of [a, b]) assert.ok([200, 400, 409].includes(r.status), `no 500, got ${r.status}`);
  // Whichever write won, the loser email must not authenticate anywhere.
  const probe = new Session(srv.baseUrl); await probe.initCsrf();
  const l1 = await probe.login(e1, 'Password123!x');
  const probe2 = new Session(srv.baseUrl); await probe2.initCsrf();
  const l2 = await probe2.login(e2, 'Password123!x');
  assert.equal([l1.status, l2.status].filter((x) => x === 200).length, 1,
    'exactly one of the two raced emails may authenticate');
});

test('distinct anonymous accounts get distinct IDs and distinct sessions', async () => {
  const a = await freshAnon('One');
  const b = await freshAnon('Two');
  assert.notEqual(a.user.nexoraId, b.user.nexoraId);
  assert.notEqual(a.cookies.nx_session, b.cookies.nx_session);
  assert.notEqual(a.user.id, b.user.id);
});
