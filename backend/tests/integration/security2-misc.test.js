// Phase 4 (F) — Misc: SQLi, XSS, CSRF, privilege escalation, rate-limit
// bypass via X-Forwarded-For, WebSocket origin/auth, error leakage, headers.
// NOTE: the rate-limit test MUST run first in this file: it spends the
// default 10/min auth budget, after which AUTH_RATE_LIMIT_MAX is raised
// (the limiter reads it per request) so later tests are not flaked by it.
// npm audit is reported in the final report, not here: the sandbox registry
// policy blocks the audit endpoint (403 policy_denied) in this environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { startTestServer, Session } from '../helpers.js';

process.env.MESSAGE_RATE_LIMIT_MAX = '1000';
process.env.UPLOAD_RATE_LIMIT_MAX = '1000';
process.env.DELIVERY_RATE_LIMIT_MAX = '1000';
process.env.API_RATE_LIMIT_MAX = '10000';
let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { if (srv) await srv.close(); });

const uniq = (p) => `sec2f-${p}-${Math.random().toString(36).slice(2, 10)}@nexora.local`;
async function freshAnon(name = 'Misc') {
  const s = new Session(srv.baseUrl); await s.initCsrf(); await s.anonymous(name);
  return s;
}
function leakCheck(text) {
  assert.ok(!/node_modules/.test(text), 'no module paths in error body');
  assert.ok(!/\/home\/\w+/.test(text), 'no absolute home paths in error body');
  assert.ok(!/at [A-Za-z_$]+\s*\(.*\.js:/.test(text), 'no stack frames in error body');
  assert.ok(!/SELECT .* FROM/i.test(text), 'no SQL in error body');
  assert.ok(!/22P02|42601|23505/.test(text), 'no Postgres error codes in error body');
}

test('rate-limit bypass via X-Forwarded-For spoofing does NOT work (TRUST_PROXY=false)', async () => {
  const s = new Session(srv.baseUrl); await s.initCsrf();
  let limited = false;
  for (let i = 0; i < 15; i++) {
    const res = await fetch(srv.baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: s.cookieHeader(),
        'X-CSRF-Token': s.csrf, 'X-Forwarded-For': `203.0.113.${i + 1}`,
      },
      body: JSON.stringify({ email: 'nobody@nexora.local', password: 'wrongpassword' }),
    });
    if (res.status === 429) { limited = true; break; }
    assert.equal(res.status, 401, 'pre-limit login attempts are plain 401s');
  }
  assert.equal(limited, true, 'rotating X-Forwarded-For must not reset the IP-keyed auth limiter');
  // Raise the cap for the rest of this file (limiter reads env per request).
  process.env.AUTH_RATE_LIMIT_MAX = '1000';
});

test('SQL injection payloads in login, filters, and IDs are neutralized, tables intact', async () => {
  const alice = await freshAnon('SqlAlice');
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'SqlRoom' });
  const id = room.json.data.id;
  await alice.req('POST', `/api/conversations/${id}/join`, {});
  const s = new Session(srv.baseUrl); await s.initCsrf();
  const evilLogin = await s.req('POST', '/api/auth/login', { email: `' OR '1'='1`, password: `x' OR '1'='1` });
  assert.ok([400, 401].includes(evilLogin.status), 'injection login must not authenticate');
  assert.ok(!evilLogin.json?.data?.user, 'no user returned for injection login');
  const evilFilter = await alice.req('GET', `/api/deliveries?status=' OR '1'='1`);
  assert.equal(evilFilter.status, 200, 'filter payload must not error the query');
  assert.ok(Array.isArray(evilFilter.json.data) && evilFilter.json.data.length === 0, 'filter payload matches nothing, leaks nothing');
  for (const badId of [`' OR '1'='1`, `1; DROP TABLE messages; --`, `00000000-0000-0000-0000-000000000000' OR '1'='1`]) {
    const enc = encodeURIComponent(badId);
    assert.equal((await alice.req('GET', `/api/conversations/${enc}`)).status, 404, 'malformed/injection ID -> 404, never 500');
    assert.equal((await alice.req('GET', `/api/deliveries/${enc}`)).status, 404);
    assert.equal((await alice.req('GET', `/api/files/${enc}/url`)).status, 404);
  }
  // Table intact: normal writes still work.
  const sent = await alice.req('POST', `/api/conversations/${id}/messages`, { body: 'still alive' });
  assert.equal(sent.status, 201);
  const stored = await alice.req('POST', `/api/conversations/${id}/messages`, { body: `'; DROP TABLE messages; --` });
  assert.equal(stored.status, 201);
  const msgs = await alice.req('GET', `/api/conversations/${id}/messages`);
  assert.ok(msgs.json.data.some((m) => m.body === `'; DROP TABLE messages; --`), 'payload stored literally, never executed');
});

test('stored and reflected XSS: server returns JSON only, never renders HTML', async () => {
  const alice = await freshAnon('XssAlice');
  const bob = await freshAnon('XssBob');
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'XssRoom' });
  const id = room.json.data.id;
  await bob.req('POST', `/api/conversations/${id}/join`, {});
  const xss = `<script>alert('xss')</script><img src=x onerror=alert(1)>`;
  const sent = await bob.req('POST', `/api/conversations/${id}/messages`, { body: xss });
  assert.equal(sent.status, 201);
  const msgs = await alice.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.json.data[0].body, xss, 'server stores raw; escaping is the frontend esc() job');
  assert.match(msgs.headers.get('content-type'), /application\/json/, 'message reads are JSON, not HTML');
  // Display-name payload is likewise JSON-only.
  const evilName = new Session(srv.baseUrl); await evilName.initCsrf();
  await evilName.anonymous(xss.slice(0, 24));
  const me = await evilName.req('GET', '/api/auth/me');
  assert.match(me.headers.get('content-type'), /application\/json/);
  // Reflected input in a lookup path stays a JSON 404, not an HTML reflection.
  const refl = await alice.req('GET', `/api/users/by-nexora/${encodeURIComponent(xss)}`);
  assert.equal(refl.status, 404);
  assert.match(refl.headers.get('content-type'), /application\/json/);
  assert.equal(refl.json.error.code, 'NOT_FOUND');
});

test('CSRF: missing/wrong tokens rejected on mutations, GETs unaffected', async () => {
  const alice = await freshAnon('CsrfAlice');
  const noToken = new Session(srv.baseUrl);
  noToken.cookies = { ...alice.cookies }; // session cookie, but no CSRF header sent
  noToken.csrf = null;
  const missing = await noToken.req('POST', '/api/conversations', { type: 'room', name: 'NoCsrf' });
  assert.equal(missing.status, 403);
  assert.equal(missing.json.error.code, 'CSRF_MISSING');
  const wrong = new Session(srv.baseUrl);
  wrong.cookies = { ...alice.cookies }; wrong.csrf = 'totally-wrong-token';
  const bad = await wrong.req('POST', '/api/conversations', { type: 'room', name: 'WrongCsrf' });
  assert.equal(bad.status, 403);
  assert.equal(bad.json.error.code, 'CSRF_INVALID');
  // Pre-auth mutation without a token is also rejected.
  const pre = new Session(srv.baseUrl);
  const preAnon = await pre.req('POST', '/api/auth/anonymous', { displayName: 'NoCsrf' });
  assert.equal(preAnon.status, 403);
  // GETs do not need a CSRF token.
  const me = await noToken.req('GET', '/api/auth/me');
  assert.equal(me.status, 200, 'GET with a valid session but no CSRF header must succeed');
});

test('privilege escalation: regular users cannot reach admin or courier-only powers', async () => {
  const alice = await freshAnon('EscAlice');
  const bob = await freshAnon('EscBob');
  assert.equal((await alice.req('GET', '/api/admin/reports')).status, 403);
  assert.equal((await alice.req('GET', '/api/admin/audit')).status, 403);
  assert.equal((await alice.req('POST', `/api/admin/users/${bob.user.id}/role`, { role: 'admin' })).status, 403);
  assert.equal((await alice.req('PATCH', '/api/admin/reports/00000000-0000-0000-0000-000000000000', { status: 'dismissed' })).status, 403);
  assert.equal((await alice.req('PATCH', '/api/couriers/me/availability', { available: true })).status, 403,
    'availability without a courier profile is forbidden');
  const order = await bob.req('POST', '/api/deliveries', {
    name: 'Claim test', category: 'Documents', size: 'Small (fits a bag)', pickupArea: 'A', dropoffArea: 'B',
  });
  assert.equal((await alice.req('POST', `/api/deliveries/${order.json.data.id}/claim`, {})).status, 403,
    'non-courier cannot claim a delivery');
  // Role cannot be smuggled through the profile update.
  const patched = await alice.req('PATCH', '/api/users/me', { displayName: 'StillUser', role: 'admin' });
  assert.equal(patched.status, 200);
  const me = await alice.req('GET', '/api/auth/me');
  assert.equal(me.json.data.user.role, 'user', 'PATCH /users/me must not change role');
  // Courier self-registration grants courier, never admin.
  assert.equal((await alice.req('POST', '/api/couriers/register', {})).status, 200);
  const me2 = await alice.req('GET', '/api/auth/me');
  assert.equal(me2.json.data.user.role, 'courier');
  assert.equal((await alice.req('GET', '/api/admin/audit')).status, 403, 'courier is not admin');
});

test('profile update with bio only must not 500 (empty SET clause bug)', async () => {
  const alice = await freshAnon('BioOnly');
  const r = await alice.req('PATCH', '/api/users/me', { bio: 'just a bio' });
  assert.equal(r.status, 200, 'bio-only update must succeed, not crash on an empty users UPDATE');
  const profile = await alice.req('GET', `/api/users/by-nexora/${alice.user.nexoraId}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.json.data.bio, 'just a bio');
});

test('error responses leak no stacks, paths, SQL, or Postgres codes', async () => {
  const alice = await freshAnon('ErrAlice');
  const cases = [
    await alice.req('GET', '/api/definitely-not-a-route'),
    await alice.req('POST', '/api/conversations', { type: 'bogus' }),
    await alice.req('GET', '/api/conversations/not-a-uuid'),
    await alice.req('GET', '/api/conversations/00000000-0000-0000-0000-000000000000'),
  ];
  for (const r of cases) {
    assert.equal(r.json.ok, false);
    leakCheck(JSON.stringify(r.json));
    assert.ok(!r.json.error.code || !/22P02|42601/.test(r.json.error.code));
  }
  // Malformed JSON body.
  const raw = await fetch(srv.baseUrl + '/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: alice.cookieHeader(), 'X-CSRF-Token': alice.csrf },
    body: '{not json',
  });
  assert.ok(raw.status >= 400 && raw.status < 500, `malformed JSON -> client error, got ${raw.status}`);
  leakCheck(await raw.text());
});

test('WebSocket: no-cookie and evil-origin-no-cookie connects rejected; auth is the gate, not origin', async () => {
  const naked = io(srv.baseUrl, { reconnection: false });
  const nakedRejected = await new Promise((resolve) => {
    naked.on('connect', () => resolve(false));
    naked.on('connect_error', () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  assert.equal(nakedRejected, true, 'socket without a session cookie must be rejected');
  const evilNaked = io(srv.baseUrl, { extraHeaders: { Origin: 'https://evil.example' }, reconnection: false });
  const evilRejected = await new Promise((resolve) => {
    evilNaked.on('connect', () => resolve(false));
    evilNaked.on('connect_error', () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  assert.equal(evilRejected, true, 'evil origin without a cookie is still rejected');
  // Documented observation (not a pass/fail on origin): with CORS_ORIGINS
  // unset, the server reflects any origin, and a valid cookie still connects.
  // Cookie SameSite=Lax is what blocks real cross-site browser abuse; see report.
  const alice = await freshAnon('OriginAlice');
  const evilAuthed = await new Promise((resolve) => {
    const s = io(srv.baseUrl, { extraHeaders: { Cookie: alice.cookieHeader(), Origin: 'https://evil.example' }, reconnection: false });
    s.on('connect', () => { s.disconnect(); resolve(true); });
    s.on('connect_error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  assert.equal(evilAuthed, true, 'valid cookie connects even from a non-listed origin (CORS_ORIGINS unset default)');
});

test('security headers: strict CSP and nosniff are present', async () => {
  const r = await fetch(srv.baseUrl + '/api/health');
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});
