// End-to-end: one full user journey through HTTP + realtime sockets,
// including a "reload" (fresh client, same session) proving persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { startTestServer, Session } from '../backend/tests/helpers.js';

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { if (srv) await srv.close(); });

function connectSocket(session) {
  return new Promise((resolve, reject) => {
    const socket = io(srv.baseUrl, {
      extraHeaders: { Cookie: session.cookieHeader() },
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

test('full journey: register, chat over socket, delivery lifecycle, reload persists', async () => {
  // 1. Accounts.
  const alice = new Session(srv.baseUrl); await alice.initCsrf();
  const bob = new Session(srv.baseUrl); await bob.initCsrf();
  assert.equal((await alice.register('e2e-alice@nexora.local', 'Password123!x', 'E2E Alice')).status, 200);
  assert.equal((await bob.register('e2e-bob@nexora.local', 'Password123!x', 'E2E Bob')).status, 200);
  assert.equal((await bob.req('POST', '/api/couriers/register', {})).status, 200);

  // 2. DM + realtime: Bob connects, Alice sends, Bob receives over the socket.
  const dm = await alice.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [bob.user.nexoraId] });
  const dmId = dm.json.data.id;
  const bobSocket = await connectSocket(bob);
  await new Promise((resolve) => bobSocket.emit('conversation:join', dmId, resolve));
  const received = new Promise((resolve) => bobSocket.once('message:new', resolve));
  const sent = await alice.req('POST', `/api/conversations/${dmId}/messages`, { body: 'hello from e2e' });
  assert.equal(sent.status, 201);
  const evt = await received;
  assert.equal(evt.body, 'hello from e2e');
  assert.equal(evt.senderNexoraId, alice.user.nexoraId);

  // 3. Unauthenticated socket cannot join or send.
  const anonSocket = io(srv.baseUrl, { reconnection: false });
  await new Promise((resolve) => anonSocket.on('connect_error', resolve));
  assert.equal(anonSocket.connected, false, 'socket without a session must be rejected');

  // 4. Delivery lifecycle.
  const order = await alice.req('POST', '/api/deliveries', {
    name: 'E2E parcel', category: 'Documents', size: 'Small (fits a bag)',
    pickupArea: 'Savar', dropoffArea: 'Dhanmondi',
  });
  assert.equal(order.status, 201);
  const id = order.json.data.id;
  assert.equal((await bob.req('POST', `/api/deliveries/${id}/claim`, {})).status, 200);
  assert.equal((await bob.req('POST', `/api/deliveries/${id}/step`, { to: 'ACCEPTED' })).status, 200);
  const codes = await alice.req('GET', `/api/deliveries/${id}/codes`);
  assert.equal((await bob.req('POST', `/api/deliveries/${id}/verify`, { stage: 'pickup', code: codes.json.data.pickup.code })).status, 200);
  assert.equal((await bob.req('POST', `/api/deliveries/${id}/step`, { to: 'IN_TRANSIT' })).status, 200);
  assert.equal((await bob.req('POST', `/api/deliveries/${id}/verify`, { stage: 'dropoff', code: codes.json.data.dropoff.code })).status, 200);
  assert.equal((await bob.req('POST', `/api/deliveries/${id}/step`, { to: 'DELIVERED' })).status, 200);

  // 5. "Reload": a fresh client with the same session still sees everything.
  const alice2 = new Session(srv.baseUrl);
  alice2.cookies = { ...alice.cookies };
  alice2.csrf = alice.csrf;
  const me = await alice2.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  const delivered = await alice2.req('GET', `/api/deliveries/${id}`);
  assert.equal(delivered.json.data.status, 'DELIVERED');
  const history = await alice2.req('GET', `/api/deliveries/${id}/history`);
  assert.equal(history.json.data.at(-1).to_status, 'DELIVERED');
  const msgs = await alice2.req('GET', `/api/conversations/${dmId}/messages`);
  assert.equal(msgs.json.data[0].body, 'hello from e2e');

  bobSocket.disconnect();
});
