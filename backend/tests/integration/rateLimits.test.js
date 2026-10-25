// Rate-limit tests live in their own file (and therefore their own server
// instance) so the shared per-IP counters cannot flake other suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { if (srv) await srv.close(); });

// NOTE: this test runs FIRST on purpose — it spends 1 IP-keyed auth call
// (anonymous), leaving exactly enough budget for the login test below to
// still hit the 10/minute cap. Order matters; do not reorder.
test('message sending is rate-limited per user', async () => {
  const alice = new Session(srv.baseUrl); await alice.initCsrf();
  await alice.anonymous('Spammer');
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'Spam Room' });
  const id = room.json.data.id;
  let limited = false;
  for (let i = 0; i < 35; i++) {
    const r = await alice.req('POST', `/api/conversations/${id}/messages`, { body: `spam ${i}` });
    if (r.status === 429) { limited = true; break; }
    assert.equal(r.status, 201);
  }
  assert.equal(limited, true, 'the 31st message in a minute must be rate-limited');
});

test('login is rate-limited after 10 attempts per minute', async () => {
  const s = new Session(srv.baseUrl);
  await s.initCsrf();
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await s.req('POST', '/api/auth/login', { email: 'nobody@nexora.local', password: 'wrong' });
    if (r.status === 429) { limited = true; break; }
    assert.equal(r.status, 401);
  }
  assert.equal(limited, true, 'the 11th login attempt in a minute must be rate-limited');
});
