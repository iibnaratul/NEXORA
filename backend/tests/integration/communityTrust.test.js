// 005: community hub, transaction flow, trust & verification, hyper-local pickup.
// One shared pg-mem server; fresh anonymous users per test so no test
// depends on another's state. Rate caps raised test-only (limiters
// themselves are covered by rateLimits.test.js with production defaults).
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.DELIVERY_RATE_LIMIT_MAX = '1000';
process.env.UPLOAD_RATE_LIMIT_MAX = '1000';
process.env.MESSAGE_RATE_LIMIT_MAX = '1000';
process.env.API_RATE_LIMIT_MAX = '10000';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { if (srv) await srv.close(); });

async function newUser(name) {
  const s = new Session(srv.baseUrl);
  await s.initCsrf();
  const r = await s.anonymous(name);
  assert.equal(r.status, 200, `anonymous signup for ${name} (got ${r.status}: ${r.text.slice(0, 200)})`);
  return s;
}
async function makeGroup(owner, members) {
  const r = await owner.req('POST', '/api/conversations', {
    type: 'group', name: 'Hub Group', memberNexoraIds: members.map((m) => m.user.nexoraId),
  });
  assert.equal(r.status, 201, `group create (got ${r.status}: ${r.text.slice(0, 200)})`);
  return r.json.data.id;
}
async function makeDM(a, b) {
  const r = await a.req('POST', '/api/conversations', {
    type: 'dm', memberNexoraIds: [b.user.nexoraId],
  });
  assert.equal(r.status, 201);
  return r.json.data.id;
}
async function sendMsg(s, convId, body, extra = {}) {
  const r = await s.req('POST', `/api/conversations/${convId}/messages`, { body, ...extra });
  assert.equal(r.status, 201, `send (got ${r.status}: ${r.text.slice(0, 200)})`);
  return r.json.data;
}
// Full marketplace flow up to a chosen stage. Returns {buyer, seller, convId, deliveryId}.
async function marketplaceTo(stage) {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const convId = await makeDM(buyer, seller);
  const created = await buyer.req('POST', '/api/delivery-requests', {
    conversationId: convId, targetId: seller.user.id, title: 'Notebook',
    description: 'A5 dotted notebook', priceMinor: 50000,
  });
  assert.equal(created.status, 201);
  const accepted = await seller.req('POST', `/api/delivery-requests/${created.json.data.id}/accept`, {});
  assert.equal(accepted.status, 200);
  const deliveryId = accepted.json.data.delivery.id;
  if (stage === 'CREATED') return { buyer, seller, convId, deliveryId };
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/prepare`, {})).status, 200);
  if (stage === 'PREPARED') return { buyer, seller, convId, deliveryId };
  const drop = await seller.req('PATCH', `/api/deliveries/${deliveryId}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41, dropoffArea: 'Savar Bazar', dropoffCoordSource: 'user-supplied',
  });
  assert.equal(drop.status, 200);
  if (stage === 'READY_FOR_PICKUP') return { buyer, seller, convId, deliveryId };
  assert.equal((await buyer.req('POST', `/api/deliveries/${deliveryId}/arrive`, {})).status, 200);
  if (stage === 'ARRIVED') return { buyer, seller, convId, deliveryId };
  const codes = await buyer.req('GET', `/api/deliveries/${deliveryId}/codes`);
  assert.equal(codes.status, 200);
  const hand = await seller.req('POST', `/api/deliveries/${deliveryId}/handover`, { code: codes.json.data.pickup.code });
  assert.equal(hand.status, 200, `handover (got ${hand.status}: ${hand.text.slice(0, 200)})`);
  return { buyer, seller, convId, deliveryId };
}

test('roles: moderator pins/deletes but cannot manage members; admin cannot touch fellow admins; owner can', async () => {
  const owner = await newUser('Owner');
  const bob = await newUser('Bob');
  const carol = await newUser('Carol');
  const dave = await newUser('Dave');
  const gid = await makeGroup(owner, [bob, carol, dave]);
  // Owner promotes Bob to moderator and Carol to admin.
  assert.equal((await owner.req('PATCH', `/api/conversations/${gid}/members/${bob.user.id}/role`, { role: 'moderator' })).status, 200);
  assert.equal((await owner.req('PATCH', `/api/conversations/${gid}/members/${carol.user.id}/role`, { role: 'admin' })).status, 200);
  // Moderator cannot add members, cannot remove members, cannot change roles.
  assert.equal((await bob.req('POST', `/api/conversations/${gid}/members`, { nexoraId: dave.user.nexoraId })).status, 403);
  assert.equal((await bob.req('DELETE', `/api/conversations/${gid}/members/${dave.user.id}`)).status, 403);
  assert.equal((await bob.req('PATCH', `/api/conversations/${gid}/members/${dave.user.id}/role`, { role: 'moderator' })).status, 403);
  // Admin cannot promote to admin, cannot remove a fellow admin (Carol is
  // admin; Dave is member — promote Dave via owner first for the fellow-admin check).
  assert.equal((await owner.req('PATCH', `/api/conversations/${gid}/members/${dave.user.id}/role`, { role: 'admin' })).status, 200);
  assert.equal((await carol.req('DELETE', `/api/conversations/${gid}/members/${dave.user.id}`)).status, 403);
  assert.equal((await carol.req('PATCH', `/api/conversations/${gid}/members/${bob.user.id}/role`, { role: 'admin' })).status, 403);
  // Admin CAN remove a plain member: first demote Dave back via owner.
  assert.equal((await owner.req('PATCH', `/api/conversations/${gid}/members/${dave.user.id}/role`, { role: 'member' })).status, 200);
  assert.equal((await carol.req('DELETE', `/api/conversations/${gid}/members/${dave.user.id}`)).status, 200);
  // Owner CAN remove an admin.
  assert.equal((await owner.req('DELETE', `/api/conversations/${gid}/members/${carol.user.id}`)).status, 200);
  // Moderator CAN pin and delete another member's message.
  const msg = await sendMsg(owner, gid, 'announcement candidate');
  assert.equal((await bob.req('POST', `/api/conversations/${gid}/pins`, { messageId: msg.id })).status, 201);
  assert.equal((await bob.req('POST', `/api/conversations/${gid}/pins`, { messageId: msg.id })).status, 409);
  const pins = await bob.req('GET', `/api/conversations/${gid}/pins`);
  assert.equal(pins.status, 200);
  assert.equal(pins.json.data.length, 1);
  assert.equal((await bob.req('DELETE', `/api/conversations/${gid}/pins/${msg.id}`)).status, 200);
  const victim = await sendMsg(owner, gid, 'delete me');
  assert.equal((await bob.req('DELETE', `/api/messages/${victim.id}`)).status, 200);
});

test('rules + admin log: admin edits rules, member cannot, log records it', async () => {
  const owner = await newUser('Owner');
  const bob = await newUser('Bob');
  const gid = await makeGroup(owner, [bob]);
  assert.equal((await bob.req('PATCH', `/api/conversations/${gid}/rules`, { rules: 'be kind' })).status, 403);
  const set = await owner.req('PATCH', `/api/conversations/${gid}/rules`, { rules: 'Be kind. No spam.' });
  assert.equal(set.status, 200);
  const conv = await owner.req('GET', `/api/conversations/${gid}`);
  assert.equal(conv.json.data.rules, 'Be kind. No spam.');
  assert.equal(conv.json.data.joinMode, 'approval');
  const log = await owner.req('GET', `/api/conversations/${gid}/admin-log`);
  assert.equal(log.status, 200);
  assert.ok(log.json.data.some((e) => e.action === 'rules_changed'));
  assert.equal((await bob.req('GET', `/api/conversations/${gid}/admin-log`)).status, 403);
});

test('ownership transfer: owner-only, confirm required, old owner becomes admin', async () => {
  const owner = await newUser('Owner');
  const bob = await newUser('Bob');
  const carol = await newUser('Carol');
  const gid = await makeGroup(owner, [bob, carol]);
  assert.equal((await bob.req('POST', `/api/conversations/${gid}/transfer`, { newOwnerId: bob.user.id, confirm: true })).status, 403);
  assert.equal((await owner.req('POST', `/api/conversations/${gid}/transfer`, { newOwnerId: bob.user.id })).status, 400);
  assert.equal((await owner.req('POST', `/api/conversations/${gid}/transfer`, { newOwnerId: bob.user.id, confirm: false })).status, 400);
  const outsider = await newUser('Outsider');
  assert.equal((await owner.req('POST', `/api/conversations/${gid}/transfer`, { newOwnerId: outsider.user.id, confirm: true })).status, 400);
  assert.equal((await owner.req('POST', `/api/conversations/${gid}/transfer`, { newOwnerId: bob.user.id, confirm: true })).status, 200);
  const conv = await bob.req('GET', `/api/conversations/${gid}`);
  const roles = Object.fromEntries(conv.json.data.members.map((m) => [m.id, m.role]));
  assert.equal(roles[bob.user.id], 'owner');
  assert.equal(roles[owner.user.id], 'admin');
  const log = await bob.req('GET', `/api/conversations/${gid}/admin-log`);
  assert.ok(log.json.data.some((e) => e.action === 'ownership_transferred'));
});

test('invites: create, join, single-use exhaustion, expiry 410, QR is PNG for members only', async () => {
  const owner = await newUser('Owner');
  const gid = await makeGroup(owner, []);
  const inv = await owner.req('POST', `/api/conversations/${gid}/invites`, { maxUses: 1 });
  assert.equal(inv.status, 201);
  const code = inv.json.data.code;
  assert.ok(code);
  const outsider = await newUser('Outsider');
  assert.equal((await outsider.req('GET', `/api/conversations/${gid}/invites/${code}/qr`)).status, 403);
  const joined = await outsider.req('POST', '/api/conversations/join-by-code', { code });
  assert.equal(joined.status, 200, `join-by-code (got ${joined.status}: ${joined.text.slice(0, 200)})`);
  assert.equal(joined.json.data.conversationId, gid);
  const qr = await outsider.req('GET', `/api/conversations/${gid}/invites/${code}/qr`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /png/);
  const second = await newUser('Second');
  assert.equal((await second.req('POST', '/api/conversations/join-by-code', { code })).status, 403);
  const expired = await owner.req('POST', `/api/conversations/${gid}/invites`, { expiresAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal(expired.status, 201);
  const late = await newUser('Late');
  assert.equal((await late.req('POST', '/api/conversations/join-by-code', { code: expired.json.data.code })).status, 410);
  const nobody = await newUser('Nobody');
  assert.equal((await nobody.req('POST', '/api/conversations/join-by-code', { code: 'INV-NOPE123456' })).status, 404);
});

test('join requests: request, duplicate 409, approve joins, decline keeps out', async () => {
  const owner = await newUser('Owner');
  const gid = await makeGroup(owner, []);
  const asker = await newUser('Asker');
  const req1 = await asker.req('POST', `/api/conversations/${gid}/join-requests`, {});
  assert.equal(req1.status, 201);
  assert.equal((await asker.req('POST', `/api/conversations/${gid}/join-requests`, {})).status, 409);
  assert.equal((await asker.req('GET', `/api/conversations/${gid}/join-requests`)).status, 403);
  const list = await owner.req('GET', `/api/conversations/${gid}/join-requests`);
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 1);
  assert.equal((await owner.req('POST', `/api/conversations/${gid}/join-requests/${req1.json.data.id}/approve`, {})).status, 200);
  assert.equal((await asker.req('GET', `/api/conversations/${gid}/messages`)).status, 200);
  assert.equal((await asker.req('POST', `/api/conversations/${gid}/join-requests`, {})).status, 400);
  const asker2 = await newUser('Asker2');
  const req2 = await asker2.req('POST', `/api/conversations/${gid}/join-requests`, {});
  assert.equal(req2.status, 201);
  assert.equal((await owner.req('POST', `/api/conversations/${gid}/join-requests/${req2.json.data.id}/decline`, {})).status, 200);
  assert.equal((await asker2.req('GET', `/api/conversations/${gid}/messages`)).status, 403);
  const log = await owner.req('GET', `/api/conversations/${gid}/admin-log`);
  assert.ok(log.json.data.some((e) => e.action === 'join_approved'));
  assert.ok(log.json.data.some((e) => e.action === 'join_declined'));
});

test('replies + reactions + edited tag in message reads', async () => {
  const alice = await newUser('Alice');
  const bob = await newUser('Bob');
  const gid = await makeGroup(alice, [bob]);
  const parent = await sendMsg(alice, gid, 'parent message here');
  const reply = await sendMsg(bob, gid, 'a reply', { replyToId: parent.id });
  const thread = await alice.req('GET', `/api/messages/${parent.id}/replies`);
  assert.equal(thread.status, 200);
  assert.equal(thread.json.data.parent.id, parent.id);
  assert.equal(thread.json.data.replies.length, 1);
  assert.equal(thread.json.data.replies[0].id, reply.id);
  const list = await alice.req('GET', `/api/conversations/${gid}/messages`);
  const byId = Object.fromEntries(list.json.data.map((m) => [m.id, m]));
  assert.equal(byId[parent.id].replyCount, 1);
  assert.match(byId[reply.id].parentSnippet, /parent message/);
  // Reactions: add, toggle off, replace.
  const r1 = await bob.req('POST', `/api/messages/${parent.id}/reactions`, { emoji: '👍' });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.data.action, 'added');
  const r2 = await bob.req('POST', `/api/messages/${parent.id}/reactions`, { emoji: '👍' });
  assert.equal(r2.json.data.action, 'removed');
  await bob.req('POST', `/api/messages/${parent.id}/reactions`, { emoji: '👍' });
  const r3 = await bob.req('POST', `/api/messages/${parent.id}/reactions`, { emoji: '❤️' });
  assert.equal(r3.json.data.action, 'replaced');
  assert.deepEqual(r3.json.data.reactions, [{ emoji: '❤️', count: 1, reacted: true }]);
  const list2 = await alice.req('GET', `/api/conversations/${gid}/messages`);
  const p2 = list2.json.data.find((m) => m.id === parent.id);
  assert.deepEqual(p2.reactions, [{ emoji: '❤️', count: 1, reacted: false }]);
  // Edited tag.
  assert.equal((await alice.req('PATCH', `/api/messages/${parent.id}`, { body: 'parent edited' })).status, 200);
  const list3 = await alice.req('GET', `/api/conversations/${gid}/messages`);
  assert.ok(list3.json.data.find((m) => m.id === parent.id).editedAt);
  // Non-participant cannot react or read the thread.
  const carol = await newUser('Carol');
  assert.equal((await carol.req('POST', `/api/messages/${parent.id}/reactions`, { emoji: '👍' })).status, 403);
  assert.equal((await carol.req('GET', `/api/messages/${parent.id}/replies`)).status, 403);
});

test('system messages: arrival + exchange appear, and are not editable/deletable/reactable/repliable', async () => {
  const { buyer, seller, convId, deliveryId } = await marketplaceTo('ARRIVED');
  const msgs = await buyer.req('GET', `/api/conversations/${convId}/messages`);
  const sys = msgs.json.data.find((m) => m.isSystem);
  assert.ok(sys, 'arrival system message exists');
  assert.equal(sys.body, 'Buyer has arrived at the drop-off point');
  assert.equal((await buyer.req('PATCH', `/api/messages/${sys.id}`, { body: 'hacked' })).status, 403);
  assert.equal((await buyer.req('DELETE', `/api/messages/${sys.id}`)).status, 403);
  assert.equal((await buyer.req('POST', `/api/messages/${sys.id}/reactions`, { emoji: '👍' })).status, 400);
  assert.equal((await buyer.req('POST', `/api/conversations/${convId}/messages`, { body: 'reply to sys', replyToId: sys.id })).status, 400);
  const codes = await buyer.req('GET', `/api/deliveries/${deliveryId}/codes`);
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/handover`, { code: codes.json.data.pickup.code })).status, 200);
  const msgs2 = await buyer.req('GET', `/api/conversations/${convId}/messages`);
  assert.ok(msgs2.json.data.some((m) => m.isSystem && m.body === 'Item exchanged'));
});

test('pickup location: state-gated, participant-only, returned once, gone after delivery', async () => {
  const { buyer, seller, deliveryId } = await marketplaceTo('PREPARED');
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/share-location`, { lat: 23.81, lng: 90.41 })).status, 400);
  const outsider = await newUser('Outsider');
  assert.equal((await outsider.req('GET', `/api/deliveries/${deliveryId}/pickup-location`)).status, 403);
  const { deliveryId: d2, buyer: b2, seller: s2 } = await marketplaceTo('READY_FOR_PICKUP');
  void buyer; void seller; void deliveryId;
  const shared = await s2.req('POST', `/api/deliveries/${d2}/share-location`, { lat: 23.82, lng: 90.42 });
  assert.equal(shared.status, 201, `share (got ${shared.status}: ${shared.text.slice(0, 200)})`);
  assert.ok(new Date(shared.json.data.expiresAt).getTime() - Date.now() > 25 * 60_000, 'expiry is ~30 minutes out');
  const got = await b2.req('GET', `/api/deliveries/${d2}/pickup-location`);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.share.lat, 23.82);
  assert.equal(got.json.data.share.sharerId, s2.user.id);
  // Re-share replaces the previous row (only the latest is ever returned).
  await s2.req('POST', `/api/deliveries/${d2}/share-location`, { lat: 23.83, lng: 90.43 });
  const got2 = await b2.req('GET', `/api/deliveries/${d2}/pickup-location`);
  assert.equal(got2.json.data.share.lat, 23.83);
  // After delivery, nothing is returned.
  await b2.req('POST', `/api/deliveries/${d2}/arrive`, {});
  const codes = await b2.req('GET', `/api/deliveries/${d2}/codes`);
  assert.equal((await s2.req('POST', `/api/deliveries/${d2}/handover`, { code: codes.json.data.pickup.code })).status, 200);
  const gone = await b2.req('GET', `/api/deliveries/${d2}/pickup-location`);
  assert.equal(gone.json.data.share, null);
});

test('ratings + reputation: delivered-only, one per rater, live aggregate, null average when none', async () => {
  const { buyer, seller, deliveryId } = await marketplaceTo('DELIVERED');
  const repSeller0 = await seller.req('GET', `/api/users/${seller.user.id}/reputation`);
  assert.equal(repSeller0.status, 200);
  assert.equal(repSeller0.json.data.avgStars, null);
  assert.equal(repSeller0.json.data.ratingsCount, 0);
  assert.equal(repSeller0.json.data.completedDeliveries, 1);
  const rate1 = await buyer.req('POST', `/api/deliveries/${deliveryId}/ratings`, { stars: 5, comment: 'Smooth handoff' });
  assert.equal(rate1.status, 201);
  assert.equal((await buyer.req('POST', `/api/deliveries/${deliveryId}/ratings`, { stars: 3 })).status, 409);
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/ratings`, { stars: 4 })).status, 201);
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/ratings`, { stars: 0 })).status, 400);
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/ratings`, { stars: 6 })).status, 400);
  const repSeller = await buyer.req('GET', `/api/users/${seller.user.id}/reputation`);
  assert.equal(repSeller.json.data.avgStars, 5);
  assert.equal(repSeller.json.data.ratingsCount, 1);
  const repBuyer = await seller.req('GET', `/api/users/${buyer.user.id}/reputation`);
  assert.equal(repBuyer.json.data.avgStars, 4);
  assert.equal(repBuyer.json.data.ratingsCount, 1);
  const byNexora = await buyer.req('GET', `/api/users/by-nexora/${seller.user.nexoraId}`);
  assert.equal(byNexora.json.data.reputation.avgStars, 5);
  // Undelivered delivery cannot be rated; outsiders cannot rate.
  const { deliveryId: d2, buyer: b2, seller: s2 } = await marketplaceTo('READY_FOR_PICKUP');
  assert.equal((await b2.req('POST', `/api/deliveries/${d2}/ratings`, { stars: 5 })).status, 400);
  const { deliveryId: d3 } = await marketplaceTo('DELIVERED');
  void s2;
  const outsider = await newUser('Outsider');
  assert.equal((await outsider.req('POST', `/api/deliveries/${d3}/ratings`, { stars: 5 })).status, 403);
});
