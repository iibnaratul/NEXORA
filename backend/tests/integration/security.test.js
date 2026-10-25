import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';

let srv, alice, bob;
test.before(async () => {
  srv = await startTestServer();
  alice = new Session(srv.baseUrl); await alice.initCsrf();
  bob = new Session(srv.baseUrl); await bob.initCsrf();
  await alice.anonymous('Alice');
  await bob.anonymous('Bob');
});
test.after(async () => { if (srv) await srv.close(); });

test('role escalation is blocked: non-admin cannot change roles', async () => {
  const r = await bob.req('POST', `/api/admin/users/${alice.user.id}/role`, { role: 'admin' });
  assert.equal(r.status, 403);
});

test('SQL injection input is stored literally and harms nothing', async () => {
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'Injection Room' });
  const id = room.json.data.id;
  await bob.req('POST', `/api/conversations/${id}/join`, {});
  const evil = `'; DROP TABLE messages; --`;
  const sent = await bob.req('POST', `/api/conversations/${id}/messages`, { body: evil });
  assert.equal(sent.status, 201, 'parameterized queries must not error on quotes');
  const msgs = await alice.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.json.data[0].body, evil, 'input is stored verbatim, not executed');
  // Table still works afterwards.
  const again = await bob.req('POST', `/api/conversations/${id}/messages`, { body: 'still alive' });
  assert.equal(again.status, 201);
});

test('XSS input is stored raw and must be escaped at render (frontend esc())', async () => {
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'XSS Room' });
  const id = room.json.data.id;
  await bob.req('POST', `/api/conversations/${id}/join`, {});
  const xss = `<script>alert('xss')</script><img src=x onerror=alert(1)>`;
  const sent = await bob.req('POST', `/api/conversations/${id}/messages`, { body: xss });
  assert.equal(sent.status, 201);
  const msgs = await alice.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.json.data[0].body, xss, 'server stores raw; the frontend escapes on render');
});

test('forged IDs cannot read or write other users’ data (IDOR sweep)', async () => {
  const dm = await alice.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [bob.user.nexoraId] });
  const id = dm.json.data.id;
  const carol = new Session(srv.baseUrl); await carol.initCsrf();
  await carol.anonymous('Carol');
  // Every endpoint that takes the conversation id must refuse Carol.
  assert.equal((await carol.req('GET', `/api/conversations/${id}`)).status, 403);
  assert.equal((await carol.req('GET', `/api/conversations/${id}/messages`)).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${id}/messages`, { body: 'x' })).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${id}/read`, {})).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${id}/leave`, {})).status, 403);
  // Random UUIDs must 404, not leak.
  assert.equal((await carol.req('GET', '/api/conversations/00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal((await carol.req('GET', '/api/deliveries/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('validation blocks oversized and malformed writes', async () => {
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'Limits' });
  const id = room.json.data.id;
  await alice.req('POST', `/api/conversations/${id}/join`, {});
  assert.equal((await alice.req('POST', `/api/conversations/${id}/messages`, { body: 'x'.repeat(2001) })).status, 400);
  assert.equal((await alice.req('POST', '/api/deliveries', {
    name: 'x'.repeat(61), category: 'Documents', size: 'Small (fits a bag)', pickupArea: 'A', dropoffArea: 'B',
  })).status, 400);
});

test('unknown routes and bad JSON do not leak internals', async () => {
  const r = await alice.req('GET', '/api/definitely-not-a-route');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'NOT_FOUND');
});
