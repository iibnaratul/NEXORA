// Phase 4 (D) — Group / private-conversation access (IDOR sweep).
// Enforcement must be server-side: HTTP and Socket.IO, before and after
// membership loss, including stale sockets (send AND broadcast receipt).
import test from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { startTestServer, Session, pngBytes } from '../helpers.js';

process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.MESSAGE_RATE_LIMIT_MAX = '1000';
process.env.DELIVERY_RATE_LIMIT_MAX = '1000';
let srv;
let alice, bob, carol, dmId, groupId, msgId, bobMsgId;
test.after(async () => { if (srv) await srv.close(); });
// bobFileUrl (setup group) is intentionally not asserted here; removal-group URLs are used instead.
test.before(async () => {
  srv = await startTestServer();
  alice = new Session(srv.baseUrl); await alice.initCsrf(); await alice.anonymous('Alice');
  bob = new Session(srv.baseUrl); await bob.initCsrf(); await bob.anonymous('Bob');
  carol = new Session(srv.baseUrl); await carol.initCsrf(); await carol.anonymous('Carol');
  const dm = await alice.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [bob.user.nexoraId] });
  dmId = dm.json.data.id;
  const group = await alice.req('POST', '/api/conversations', {
    type: 'group', name: 'AccessGroup', memberNexoraIds: [bob.user.nexoraId],
  });
  groupId = group.json.data.id;
  const sent = await alice.req('POST', `/api/conversations/${groupId}/messages`, { body: 'alice group msg' });
  msgId = sent.json.data.id;
  const bsent = await bob.req('POST', `/api/conversations/${groupId}/messages`, { body: 'bob group msg' });
  bobMsgId = bsent.json.data.id;
  // Bob's attached file, signed URL captured while he is still a member.
  const fd = new FormData(); fd.append('file', new Blob([pngBytes()]), 'bob.png');
  const up = await bob.req('POST', `/api/files/conversations/${groupId}/upload`, fd, { form: true });
  assert.equal(up.status, 201);
  const attached = await bob.req('POST', `/api/conversations/${groupId}/messages`, {
    body: 'with file', attachmentIds: [up.json.data.id],
  });
  assert.equal(attached.status, 201);
  assert.equal(attached.json.data.attachments.length, 1);
});

function connectSocket(session) {
  return new Promise((resolve, reject) => {
    const s = io(srv.baseUrl, { extraHeaders: { Cookie: session.cookieHeader() }, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
async function noBroadcast(socket, ms = 800) {
  return new Promise((resolve) => {
    socket.once('message:new', (m) => resolve(m));
    setTimeout(() => resolve(null), ms);
  });
}

test('IDOR sweep: outsider cannot read, send, edit, delete, or administer a private DM/group', async () => {
  assert.equal((await carol.req('GET', `/api/conversations/${dmId}`)).status, 403);
  assert.equal((await carol.req('GET', `/api/conversations/${dmId}/messages`)).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${dmId}/messages`, { body: 'intrude' })).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${dmId}/read`, {})).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${dmId}/leave`, {})).status, 403);
  assert.equal((await carol.req('GET', `/api/conversations/${groupId}`)).status, 403);
  assert.equal((await carol.req('GET', `/api/conversations/${groupId}/messages`)).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${groupId}/messages`, { body: 'intrude' })).status, 403);
  assert.equal((await carol.req('PATCH', `/api/messages/${msgId}`, { body: 'hacked' })).status, 403);
  assert.equal((await carol.req('DELETE', `/api/messages/${msgId}`)).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${groupId}/members`, { nexoraId: carol.user.nexoraId })).status, 403);
  assert.equal((await carol.req('DELETE', `/api/conversations/${groupId}/members/${bob.user.id}`)).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${groupId}/join`, {})).status, 403, 'private groups cannot be joined directly');
});

test('non-author member cannot edit or delete another member\'s message', async () => {
  assert.equal((await bob.req('PATCH', `/api/messages/${msgId}`, { body: 'bob edit' })).status, 403);
  assert.equal((await bob.req('DELETE', `/api/messages/${msgId}`)).status, 403);
});

test('delivery IDOR: non-participant cannot read, view codes, or fetch the QR', async () => {
  const order = await alice.req('POST', '/api/deliveries', {
    name: 'Secret parcel', category: 'Documents', size: 'Small (fits a bag)', pickupArea: 'A', dropoffArea: 'B',
  });
  assert.equal(order.status, 201);
  const id = order.json.data.id;
  assert.equal((await carol.req('GET', `/api/deliveries/${id}`)).status, 403);
  assert.equal((await carol.req('GET', `/api/deliveries/${id}/codes`)).status, 403);
  assert.equal((await carol.req('GET', `/api/deliveries/${id}/qr`)).status, 403);
  assert.equal((await carol.req('GET', `/api/deliveries/${id}/history`)).status, 403);
});

test('socket join and send without membership are denied server-side', async () => {
  const sock = await connectSocket(carol);
  try {
    const join = await emitAck(sock, 'conversation:join', groupId);
    assert.equal(join.ok, false, 'outsider socket join must fail');
    const send = await emitAck(sock, 'message:send', { conversationId: groupId, body: 'socket intrude' });
    assert.equal(send.ok, false, 'outsider socket send must fail');
    const msgs = await alice.req('GET', `/api/conversations/${groupId}/messages`);
    assert.ok(!msgs.json.data.some((m) => m.body === 'socket intrude'), 'failed socket send must not persist');
  } finally { sock.disconnect(); }
});

test('after group removal: HTTP read/send/edit/delete/download all denied', async () => {
  // Fresh group so this test's removal does not disturb other tests.
  const g = await alice.req('POST', '/api/conversations', {
    type: 'group', name: 'RemovalGroup', memberNexoraIds: [bob.user.nexoraId],
  });
  const gid = g.json.data.id;
  const sent = await bob.req('POST', `/api/conversations/${gid}/messages`, { body: 'before removal' });
  const mid = sent.json.data.id;
  // Alice's attached file in THIS group: Bob can download it while a
  // member (control), and must lose access after removal. (Bob's OWN uploads
  // stay downloadable to him — owner access is intended, not a leak.)
  const fd = new FormData(); fd.append('file', new Blob([pngBytes()]), 'removal.png');
  const up = await alice.req('POST', `/api/files/conversations/${gid}/upload`, fd, { form: true });
  assert.equal(up.status, 201);
  const attached = await alice.req('POST', `/api/conversations/${gid}/messages`, {
    body: 'removal file', attachmentIds: [up.json.data.id],
  });
  assert.equal(attached.status, 201);
  const removalFileUrl = attached.json.data.attachments[0].downloadUrl;
  assert.equal((await bob.req('GET', removalFileUrl)).status, 200, 'member can download before removal');
  assert.equal((await alice.req('DELETE', `/api/conversations/${gid}/members/${bob.user.id}`)).status, 200);
  assert.equal((await bob.req('GET', `/api/conversations/${gid}`)).status, 403);
  assert.equal((await bob.req('GET', `/api/conversations/${gid}/messages`)).status, 403);
  assert.equal((await bob.req('POST', `/api/conversations/${gid}/messages`, { body: 'still here?' })).status, 403);
  assert.equal((await bob.req('POST', `/api/conversations/${gid}/read`, {})).status, 403);
  assert.equal((await bob.req('PATCH', `/api/messages/${mid}`, { body: 'edited after removal' })).status, 403,
    'removed author must not edit even their own message');
  assert.equal((await bob.req('DELETE', `/api/messages/${mid}`)).status, 403,
    'removed author must not delete even their own message');
  assert.equal((await bob.req('POST', `/api/conversations/${gid}/join`, {})).status, 403, 'removed member cannot rejoin a group');
  // Pre-removal signed file URL is also dead for the removed member.
  assert.equal((await bob.req('GET', removalFileUrl)).status, 403, 'removed member loses file downloads too');
});

test('stale socket: send after removal is denied and broadcasts stop reaching the removed member', async () => {
  const g = await alice.req('POST', '/api/conversations', {
    type: 'group', name: 'StaleGroup', memberNexoraIds: [bob.user.nexoraId],
  });
  const gid = g.json.data.id;
  const sock = await connectSocket(bob);
  try {
    const joined = await emitAck(sock, 'conversation:join', gid);
    assert.equal(joined.ok, true, 'member socket join works before removal');
    assert.equal((await alice.req('DELETE', `/api/conversations/${gid}/members/${bob.user.id}`)).status, 200);
    const send = await emitAck(sock, 'message:send', { conversationId: gid, body: 'stale send' });
    assert.equal(send.ok, false, 'stale socket send must be denied server-side after removal');
    const listening = noBroadcast(sock);
    await alice.req('POST', `/api/conversations/${gid}/messages`, { body: 'after removal broadcast' });
    assert.equal(await listening, null, 'removed member must not receive broadcasts on the stale socket');
  } finally { sock.disconnect(); }
});

test('public rooms keep their intended semantics (readable, but send requires joining)', async () => {
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'OpenRoom' });
  const id = room.json.data.id;
  assert.equal((await carol.req('GET', `/api/conversations/${id}`)).status, 200, 'rooms are public to read');
  assert.equal((await carol.req('POST', `/api/conversations/${id}/messages`, { body: 'too early' })).status, 403);
  const sock = await connectSocket(carol);
  try {
    const joined = await emitAck(sock, 'conversation:join', id);
    assert.equal(joined.ok, true, 'room socket join is public, matching HTTP read semantics');
  } finally { sock.disconnect(); }
});
