import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';

let srv, alice, bob, carol;
test.before(async () => {
  srv = await startTestServer();
  alice = new Session(srv.baseUrl); await alice.initCsrf();
  bob = new Session(srv.baseUrl); await bob.initCsrf();
  carol = new Session(srv.baseUrl); await carol.initCsrf();
  await alice.anonymous('Alice');
  await bob.anonymous('Bob');
  await carol.anonymous('Carol');
});
test.after(async () => { if (srv) await srv.close(); });

test('public room: create, join, send, read', async () => {
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'Lounge' });
  assert.equal(room.status, 201);
  const id = room.json.data.id;
  // Bob can read the room (public) before joining...
  const read = await bob.req('GET', `/api/conversations/${id}`);
  assert.equal(read.status, 200);
  // ...but cannot send until he joins.
  const denied = await bob.req('POST', `/api/conversations/${id}/messages`, { body: 'hello' });
  assert.equal(denied.status, 403);
  const join = await bob.req('POST', `/api/conversations/${id}/join`, {});
  assert.equal(join.status, 200);
  const sent = await bob.req('POST', `/api/conversations/${id}/messages`, { body: 'hello room' });
  assert.equal(sent.status, 201);
  const msgs = await alice.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.json.data.length, 1);
  assert.equal(msgs.json.data[0].body, 'hello room');
});

test('DM: create, reuse, and cross-user access is denied', async () => {
  const dm = await alice.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [bob.user.nexoraId] });
  assert.equal(dm.status, 201);
  const id = dm.json.data.id;
  const again = await alice.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [bob.user.nexoraId] });
  assert.equal(again.status, 200);
  assert.equal(again.json.data.reused, true);
  assert.equal(again.json.data.id, id, 'duplicate DM must not be created');
  const sent = await alice.req('POST', `/api/conversations/${id}/messages`, { body: 'secret for bob' });
  assert.equal(sent.status, 201);
  // Carol is not a member: every access path must fail.
  assert.equal((await carol.req('GET', `/api/conversations/${id}`)).status, 403);
  assert.equal((await carol.req('GET', `/api/conversations/${id}/messages`)).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${id}/messages`, { body: 'intruder' })).status, 403);
  // Bob can read it.
  const msgs = await bob.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.json.data[0].body, 'secret for bob');
});

test('message edit/delete permissions', async () => {
  const dm = await alice.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [carol.user.nexoraId] });
  const id = dm.json.data.id;
  const sent = await alice.req('POST', `/api/conversations/${id}/messages`, { body: 'original' });
  const msgId = sent.json.data.id;
  // Carol cannot edit Alice's message.
  assert.equal((await carol.req('PATCH', `/api/messages/${msgId}`, { body: 'hacked' })).status, 403);
  const edited = await alice.req('PATCH', `/api/messages/${msgId}`, { body: 'edited text' });
  assert.equal(edited.status, 200);
  // Carol cannot delete Alice's message in a DM (no admin role there).
  assert.equal((await carol.req('DELETE', `/api/messages/${msgId}`)).status, 403);
  const deleted = await alice.req('DELETE', `/api/messages/${msgId}`);
  assert.equal(deleted.status, 200);
  const msgs = await bob.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.status, 403, 'bob is not in this DM at all');
  const carolMsgs = await carol.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(carolMsgs.json.data.length, 0, 'deleted messages disappear from reads');
});

test('duplicate send with the same clientId returns the original', async () => {
  const dm = await alice.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [bob.user.nexoraId] });
  const id = dm.json.data.id;
  const first = await alice.req('POST', `/api/conversations/${id}/messages`, { body: 'once only', clientId: 'retry-1' });
  const second = await alice.req('POST', `/api/conversations/${id}/messages`, { body: 'once only', clientId: 'retry-1' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.data.id, first.json.data.id);
  const msgs = await alice.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.json.data.filter((m) => m.body === 'once only').length, 1);
});

test('group: add/remove members, removed member loses access', async () => {
  const group = await alice.req('POST', '/api/conversations', {
    type: 'group', name: 'Team', memberNexoraIds: [bob.user.nexoraId],
  });
  assert.equal(group.status, 201);
  const id = group.json.data.id;
  // Bob (plain member) cannot add Carol.
  assert.equal((await bob.req('POST', `/api/conversations/${id}/members`, { nexoraId: carol.user.nexoraId })).status, 403);
  const added = await alice.req('POST', `/api/conversations/${id}/members`, { nexoraId: carol.user.nexoraId });
  assert.equal(added.status, 200);
  const sent = await carol.req('POST', `/api/conversations/${id}/messages`, { body: 'hi team' });
  assert.equal(sent.status, 201);
  const removed = await alice.req('DELETE', `/api/conversations/${id}/members/${carol.user.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await carol.req('GET', `/api/conversations/${id}/messages`)).status, 403);
  assert.equal((await carol.req('POST', `/api/conversations/${id}/messages`, { body: 'still here?' })).status, 403);
});

test('blocking filters messages and prevents new DMs', async () => {
  const dm = await alice.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [bob.user.nexoraId] });
  const id = dm.json.data.id;
  await alice.req('POST', `/api/conversations/${id}/messages`, { body: 'before block' });
  const blocked = await bob.req('POST', '/api/users/me/blocks', { nexoraId: alice.user.nexoraId });
  assert.equal(blocked.status, 200);
  // Bob no longer sees Alice's messages.
  const msgs = await bob.req('GET', `/api/conversations/${id}/messages`);
  assert.equal(msgs.json.data.length, 0);
  // And Bob cannot send to Alice in that DM anymore.
  assert.equal((await bob.req('POST', `/api/conversations/${id}/messages`, { body: 'after block' })).status, 403);
  await bob.req('DELETE', `/api/users/me/blocks/${alice.user.nexoraId}`);
});
