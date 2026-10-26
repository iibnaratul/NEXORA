// Independent verification additions for 005 (community hub / trust / pickup).
// Covers rules the existing communityTrust.test.js does not pin down:
//   - admin role matrix, positive cases (member<->moderator) + owner self-role guard
//   - pickup-location null after CANCELLED, and share blocked once cancelled
//   - rating ratee is the other participant, never self (by construction)
//   - expired pickup share is deleted on read and never returned
// The last case needs direct DB access, so this file builds its own pg-mem
// server (same migrations as helpers.createTestDb) instead of reusing
// startTestServer, which returns no DB handle. No app code is touched.
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.DELIVERY_RATE_LIMIT_MAX = '1000';
process.env.UPLOAD_RATE_LIMIT_MAX = '1000';
process.env.MESSAGE_RATE_LIMIT_MAX = '1000';
process.env.API_RATE_LIMIT_MAX = '10000';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let srv;
let Session;
let dbQuery;

test.before(async () => {
  const helpers = await import('../helpers.js');
  const { createTestDb } = helpers;
  Session = helpers.Session;
  const db = await createTestDb();
  const { Pool } = db.adapters.createPg();
  const dbMod = await import('../../src/db.js');
  dbMod.setPool(new Pool());
  dbQuery = dbMod.query;
  process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-verify-'));
  const { createApp } = await import('../../src/server.js');
  const { createSocketServer } = await import('../../src/realtime/socket.js');
  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  app.set('io', io);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  srv = {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      io.close();
      await dbMod.closePool();
      fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
    },
  };
});
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
    type: 'group', name: 'Verify Group', memberNexoraIds: members.map((m) => m.user.nexoraId),
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
async function memberRoles(s, gid) {
  const conv = await s.req('GET', `/api/conversations/${gid}`);
  assert.equal(conv.status, 200);
  return Object.fromEntries(conv.json.data.members.map((m) => [m.id, m.role]));
}

test('admin role matrix (positive): admin moves member<->moderator; owner cannot change own role; admin cannot touch owner', async () => {
  const owner = await newUser('Owner');
  const bob = await newUser('Bob');
  const carol = await newUser('Carol');
  const dave = await newUser('Dave');
  const gid = await makeGroup(owner, [bob, carol, dave]);
  assert.equal((await owner.req('PATCH', `/api/conversations/${gid}/members/${carol.user.id}/role`, { role: 'admin' })).status, 200);
  assert.equal((await owner.req('PATCH', `/api/conversations/${gid}/members/${bob.user.id}/role`, { role: 'moderator' })).status, 200);
  // Admin positive cases: member -> moderator, moderator -> member.
  assert.equal((await carol.req('PATCH', `/api/conversations/${gid}/members/${dave.user.id}/role`, { role: 'moderator' })).status, 200);
  assert.equal((await carol.req('PATCH', `/api/conversations/${gid}/members/${bob.user.id}/role`, { role: 'member' })).status, 200);
  const roles = await memberRoles(owner, gid);
  assert.equal(roles[dave.user.id], 'moderator');
  assert.equal(roles[bob.user.id], 'member');
  // Owner never changes own role; admin never touches the owner.
  assert.equal((await owner.req('PATCH', `/api/conversations/${gid}/members/${owner.user.id}/role`, { role: 'admin' })).status, 400);
  assert.equal((await carol.req('PATCH', `/api/conversations/${gid}/members/${owner.user.id}/role`, { role: 'member' })).status, 400);
  assert.equal((await memberRoles(owner, gid))[owner.user.id], 'owner');
});

test('pickup location: null after CANCELLED, and share blocked once cancelled', async () => {
  const { buyer, seller, deliveryId } = await marketplaceTo('READY_FOR_PICKUP');
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/share-location`, { lat: 23.82, lng: 90.42 })).status, 201);
  const before = await buyer.req('GET', `/api/deliveries/${deliveryId}/pickup-location`);
  assert.equal(before.status, 200);
  assert.equal(before.json.data.share.lat, 23.82);
  const cancelled = await seller.req('POST', `/api/deliveries/${deliveryId}/cancel`, {});
  assert.equal(cancelled.status, 200, `cancel (got ${cancelled.status}: ${cancelled.text.slice(0, 200)})`);
  const gone = await buyer.req('GET', `/api/deliveries/${deliveryId}/pickup-location`);
  assert.equal(gone.status, 200);
  assert.equal(gone.json.data.share, null);
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/share-location`, { lat: 23.82, lng: 90.42 })).status, 400);
});

test('ratings: ratee is the other participant, never self', async () => {
  const { buyer, seller, deliveryId } = await marketplaceTo('DELIVERED');
  assert.equal((await buyer.req('POST', `/api/deliveries/${deliveryId}/ratings`, { stars: 5 })).status, 201);
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/ratings`, { stars: 4 })).status, 201);
  const list = await buyer.req('GET', `/api/deliveries/${deliveryId}/ratings`);
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 2);
  for (const row of list.json.data) {
    assert.notEqual(row.rater_id, row.ratee_id, 'no self-rating row');
  }
  const byBuyer = list.json.data.find((r) => r.rater_id === buyer.user.id);
  const bySeller = list.json.data.find((r) => r.rater_id === seller.user.id);
  assert.equal(byBuyer.ratee_id, seller.user.id);
  assert.equal(bySeller.ratee_id, buyer.user.id);
});

test('pickup location: expired share is deleted on read and never returned', async () => {
  const { buyer, seller, deliveryId } = await marketplaceTo('READY_FOR_PICKUP');
  assert.equal((await seller.req('POST', `/api/deliveries/${deliveryId}/share-location`, { lat: 23.82, lng: 90.42 })).status, 201);
  // Backdate the share past expiry directly in the test DB (the API itself
  // always stamps now + 30 min, so expiry-on-read is unreachable via API).
  await dbQuery('UPDATE pickup_location_shares SET expires_at = $1 WHERE delivery_id = $2',
    [new Date(Date.now() - 60_000), deliveryId]);
  const got = await buyer.req('GET', `/api/deliveries/${deliveryId}/pickup-location`);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.share, null, 'expired share must never be returned');
  const remaining = await dbQuery('SELECT COUNT(*)::int AS n FROM pickup_location_shares WHERE delivery_id = $1', [deliveryId]);
  assert.equal(remaining.rows[0].n, 0, 'expired share row must be deleted on read');
});
