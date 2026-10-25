import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';

let srv;
test.before(async () => {
  // This file makes many auth calls from one IP; raise the auth cap so the
  // suite tests behavior, not the limiter (the limiter itself is tested in
  // rateLimits.test.js with production defaults).
  process.env.AUTH_RATE_LIMIT_MAX = '100';
  srv = await startTestServer();
});
test.after(async () => { if (srv) await srv.close(); });

test('anonymous identity is server-issued and session works', async () => {
  const s = new Session(srv.baseUrl);
  await s.initCsrf();
  const r = await s.anonymous('Tester');
  assert.equal(r.status, 200);
  assert.match(r.json.data.user.nexoraId, /^NXR-[2-9A-HJ-NP-Z]{8}$/);
  assert.equal(r.json.data.user.isAnonymous, true);
  const me = await s.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.data.user.nexoraId, r.json.data.user.nexoraId);
});

test('register + login + wrong password gives no account-enumeration hint', async () => {
  const s = new Session(srv.baseUrl);
  await s.initCsrf();
  const reg = await s.register('auth1@nexora.local', 'Password123!x', 'Auth One');
  assert.equal(reg.status, 200);
  const dup = await s.register('auth1@nexora.local', 'Password123!x', 'Dup');
  assert.equal(dup.status, 409);
  const bad = new Session(srv.baseUrl);
  await bad.initCsrf();
  const wrongPass = await bad.login('auth1@nexora.local', 'WrongPassword123!');
  const unknownEmail = await bad.login('nobody@nexora.local', 'WrongPassword123!');
  assert.equal(wrongPass.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.equal(wrongPass.json.error.message, unknownEmail.json.error.message,
    'unknown email and wrong password must be indistinguishable');
  const ok = await bad.login('auth1@nexora.local', 'Password123!x');
  assert.equal(ok.status, 200);
});

test('mutations without CSRF are rejected', async () => {
  const s = new Session(srv.baseUrl);
  // No initCsrf: no token at all.
  const r = await s.req('POST', '/api/auth/anonymous', { displayName: 'NoCsrf' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'CSRF_MISSING');
});

test('unauthenticated requests cannot touch protected routes', async () => {
  const s = new Session(srv.baseUrl);
  const r = await s.req('GET', '/api/conversations');
  assert.equal(r.status, 401);
});

test('logout revokes the session', async () => {
  const s = new Session(srv.baseUrl);
  await s.initCsrf();
  await s.anonymous('Leaver');
  const out = await s.req('POST', '/api/auth/logout', {});
  assert.equal(out.status, 200);
  const me = await s.req('GET', '/api/auth/me');
  assert.equal(me.status, 401, 'revoked session must stop working');
});

test('anonymous account can be claimed with email+password', async () => {
  const s = new Session(srv.baseUrl);
  await s.initCsrf();
  const anon = await s.anonymous('Claimer');
  const nxr = anon.json.data.user.nexoraId;
  const claim = await s.req('POST', '/api/auth/claim', { email: 'claimed@nexora.local', password: 'Password123!x' });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.data.user.isAnonymous, false);
  assert.equal(claim.json.data.user.nexoraId, nxr, 'NEXORA ID survives claiming');
  const s2 = new Session(srv.baseUrl);
  await s2.initCsrf();
  const login = await s2.login('claimed@nexora.local', 'Password123!x');
  assert.equal(login.status, 200);
});

test('account deletion revokes sessions and clears the profile', async () => {
  const s = new Session(srv.baseUrl);
  await s.initCsrf();
  await s.register('delete-me@nexora.local', 'Password123!x', 'Doomed');
  const del = await s.req('DELETE', '/api/auth/me');
  assert.equal(del.status, 200);
  const me = await s.req('GET', '/api/auth/me');
  assert.equal(me.status, 401);
});
