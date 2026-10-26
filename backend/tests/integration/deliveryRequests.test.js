// Marketplace delivery requests (Phase 1+2): request lifecycle, marketplace
// fulfilment (prepare -> drop-off pin -> arrive -> handover + cash record),
// settings, and authorization. Follows the conventions of delivery.test.js
// and chat.test.js: one shared pg-mem (or real-PG) server, fresh anonymous
// users per test so no test depends on another's state.
// Rate caps are raised test-only (the limiters themselves are covered by
// rateLimits.test.js with production defaults).
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.DELIVERY_RATE_LIMIT_MAX = '1000';
process.env.UPLOAD_RATE_LIMIT_MAX = '1000';
process.env.MESSAGE_RATE_LIMIT_MAX = '1000';
// This file creates ~120 fresh anonymous users; each user's pre-auth
// initCsrf + anonymous calls share one per-IP apiLimiter bucket (300/min
// by default), so the bucket is exhausted before the last tests. The
// limiter itself is covered by rateLimits.test.js with production defaults.
process.env.API_RATE_LIMIT_MAX = '10000';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session, pngBytes } from '../helpers.js';

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

async function makeDM(a, b) {
  const r = await a.req('POST', '/api/conversations', { type: 'dm', memberNexoraIds: [b.user.nexoraId] });
  assert.equal(r.status, 201, `DM create (got ${r.status}: ${r.text.slice(0, 200)})`);
  return r.json.data.id;
}

async function makeGroup(owner, members) {
  const r = await owner.req('POST', '/api/conversations', {
    type: 'group', name: 'Market Group', memberNexoraIds: members.map((m) => m.user.nexoraId),
  });
  assert.equal(r.status, 201, `group create (got ${r.status}: ${r.text.slice(0, 200)})`);
  return r.json.data.id;
}

async function createReq(requester, convId, targetId, over = {}) {
  return requester.req('POST', '/api/delivery-requests', {
    conversationId: convId, targetId, title: 'Handmade notebook',
    description: 'A5 dotted notebook, blue cover', priceMinor: 50000, ...over,
  });
}

// Buyer requests from seller in a fresh DM; seller accepts. Returns the
// accepted request row (with .delivery attached by the accept endpoint).
async function acceptedFlow(over = {}) {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const convId = await makeDM(buyer, seller);
  const created = await createReq(buyer, convId, seller.user.id, over);
  assert.equal(created.status, 201, `request create (got ${created.status}: ${created.text.slice(0, 200)})`);
  const reqRow = created.json.data;
  const accepted = await seller.req('POST', `/api/delivery-requests/${reqRow.id}/accept`, {});
  assert.equal(accepted.status, 200, `accept (got ${accepted.status}: ${accepted.text.slice(0, 200)})`);
  return { buyer, seller, convId, request: accepted.json.data, delivery: accepted.json.data.delivery };
}

async function readyFlow(over = {}, dropoff = {}) {
  const f = await acceptedFlow(over);
  const prep = await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {});
  assert.equal(prep.status, 200, `prepare (got ${prep.status}: ${prep.text.slice(0, 200)})`);
  const drop = await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41, dropoffArea: 'Savar Bazar', ...dropoff,
  });
  assert.equal(drop.status, 200, `dropoff (got ${drop.status}: ${drop.text.slice(0, 200)})`);
  return { ...f, dropoff: drop.json.data };
}

async function buyerPickupCode(buyer, deliveryId) {
  const codes = await buyer.req('GET', `/api/deliveries/${deliveryId}/codes`);
  assert.equal(codes.status, 200, `buyer codes (got ${codes.status}: ${codes.text.slice(0, 200)})`);
  return codes.json.data.pickup.code;
}

async function deliveredFlow(over = {}, dropoff = {}) {
  const f = await readyFlow(over, dropoff);
  const code = await buyerPickupCode(f.buyer, f.delivery.id);
  assert.match(code, /^\d{6}$/);
  const hand = await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/handover`, { code });
  assert.equal(hand.status, 200, `handover (got ${hand.status}: ${hand.text.slice(0, 200)})`);
  return { ...f, handover: hand.json.data, code };
}

function formFile(buffer, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), filename);
  return fd;
}

// ---------- request creation ----------

test('request create in a DM: 201 REQUESTED with the supplied fields', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const convId = await makeDM(buyer, seller);
  const r = await createReq(buyer, convId, seller.user.id);
  assert.equal(r.status, 201);
  const d = r.json.data;
  assert.equal(d.status, 'REQUESTED');
  assert.equal(d.conversation_id, convId);
  assert.equal(d.requester_id, buyer.user.id);
  assert.equal(d.target_id, seller.user.id);
  assert.equal(d.title, 'Handmade notebook');
  assert.equal(d.price_minor, 50000);
  // List + single read agree, for participants.
  const list = await buyer.req('GET', `/api/delivery-requests?conversationId=${convId}`);
  assert.equal(list.status, 200);
  assert.equal(list.json.data.some((x) => x.id === d.id), true);
  const one = await seller.req('GET', `/api/delivery-requests/${d.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.data.id, d.id);
});

test('request create in a group: member target works, non-member target is 403', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const outsider = await newUser('Outsider');
  const convId = await makeGroup(buyer, [seller]);
  const ok = await createReq(buyer, convId, seller.user.id);
  assert.equal(ok.status, 201);
  const bad = await createReq(buyer, convId, outsider.user.id);
  assert.equal(bad.status, 403, 'target must be a conversation member');
});

test('request create validation errors: missing/short/long fields, negative price', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const convId = await makeDM(buyer, seller);
  assert.equal((await createReq(buyer, convId, seller.user.id, { title: '' })).status, 400);
  assert.equal((await createReq(buyer, convId, seller.user.id, { title: 'x'.repeat(61) })).status, 400);
  assert.equal((await createReq(buyer, convId, seller.user.id, { description: '' })).status, 400);
  assert.equal((await createReq(buyer, convId, seller.user.id, { priceMinor: -1 })).status, 400);
  assert.equal((await createReq(buyer, convId, seller.user.id, { priceMinor: 1.5 })).status, 400);
  assert.equal((await buyer.req('POST', '/api/delivery-requests', { targetId: seller.user.id, title: 'T', description: 'D' })).status, 400);
});

test('request create: non-participant 403, unauthenticated 401, self-request rejected', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const outsider = await newUser('Outsider');
  const convId = await makeDM(buyer, seller);
  assert.equal((await createReq(outsider, convId, seller.user.id)).status, 403);
  assert.equal((await outsider.req('GET', `/api/delivery-requests?conversationId=${convId}`)).status, 403);
  assert.equal((await outsider.req('GET', '/api/delivery-requests?conversationId=')).status, 400, 'empty conversationId is a bad request, not a leak');
  const anon = new Session(srv.baseUrl);
  await anon.initCsrf();
  assert.equal((await anon.req('POST', '/api/delivery-requests', {
    conversationId: convId, targetId: seller.user.id, title: 'T', description: 'D',
  })).status, 401);
  assert.equal((await anon.req('GET', `/api/delivery-requests?conversationId=${convId}`)).status, 401);
  // Self-request: the target must differ from the requester.
  const self = await createReq(buyer, convId, buyer.user.id);
  assert.equal(self.status, 400);
});

test('request list without conversationId is 400; request read by non-participant is 403', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const outsider = await newUser('Outsider');
  const convId = await makeDM(buyer, seller);
  const created = await createReq(buyer, convId, seller.user.id);
  assert.equal(created.status, 201);
  assert.equal((await buyer.req('GET', '/api/delivery-requests')).status, 400);
  assert.equal((await outsider.req('GET', `/api/delivery-requests/${created.json.data.id}`)).status, 403);
});

// ---------- accept / decline ----------

test('accept creates a CREATED marketplace delivery with correct sender/recipient/price', async () => {
  const f = await acceptedFlow();
  assert.equal(f.request.status, 'ACCEPTED');
  const d = f.delivery;
  assert.equal(d.status, 'CREATED');
  assert.equal(d.fulfillment, 'marketplace');
  assert.equal(d.sender_id, f.seller.user.id);
  assert.equal(d.price_minor, 50000);
  assert.equal(d.request_id, f.request.id);
  assert.equal(f.request.delivery_id, d.id);
  // Both participants can read the delivery; buyer_id and recipient_id agree.
  const asBuyer = await f.buyer.req('GET', `/api/deliveries/${d.id}`);
  assert.equal(asBuyer.status, 200);
  assert.equal(asBuyer.json.data.recipient_id, f.buyer.user.id);
  assert.equal(asBuyer.json.data.buyer_id, f.buyer.user.id);
  // A marketplace delivery is not in the courier queue.
  const queue = await f.seller.req('GET', '/api/deliveries?view=queue');
  assert.equal(queue.status, 403, 'seller is not a courier, so the queue itself is forbidden');
});

test('accept: requester and outsider are 403; second accept is 400', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const outsider = await newUser('Outsider');
  const convId = await makeDM(buyer, seller);
  const created = await createReq(buyer, convId, seller.user.id);
  const id = created.json.data.id;
  assert.equal((await buyer.req('POST', `/api/delivery-requests/${id}/accept`, {})).status, 403);
  assert.equal((await outsider.req('POST', `/api/delivery-requests/${id}/accept`, {})).status, 403);
  assert.equal((await seller.req('POST', `/api/delivery-requests/${id}/accept`, {})).status, 200);
  assert.equal((await seller.req('POST', `/api/delivery-requests/${id}/accept`, {})).status, 400);
});

test('decline is terminal: post-decline accept and re-decline are rejected', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const convId = await makeDM(buyer, seller);
  const created = await createReq(buyer, convId, seller.user.id);
  const id = created.json.data.id;
  assert.equal((await buyer.req('POST', `/api/delivery-requests/${id}/decline`, {})).status, 403, 'only the seller can decline');
  const declined = await seller.req('POST', `/api/delivery-requests/${id}/decline`, {});
  assert.equal(declined.status, 200);
  assert.equal(declined.json.data.status, 'DECLINED');
  assert.equal((await seller.req('POST', `/api/delivery-requests/${id}/accept`, {})).status, 400);
  assert.equal((await seller.req('POST', `/api/delivery-requests/${id}/decline`, {})).status, 400);
});

// ---------- edit rules ----------

test('edit: requester may edit all fields, seller only price/note, outsider 403', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const outsider = await newUser('Outsider');
  const convId = await makeDM(buyer, seller);
  const created = await createReq(buyer, convId, seller.user.id);
  const id = created.json.data.id;
  const bySellerTitle = await seller.req('PATCH', `/api/delivery-requests/${id}`, { title: 'Hijacked' });
  assert.equal(bySellerTitle.status, 403, 'seller may not retitle');
  const bySellerDesc = await seller.req('PATCH', `/api/delivery-requests/${id}`, { description: 'Hijacked' });
  assert.equal(bySellerDesc.status, 403, 'seller may not rewrite the description');
  const bySellerPrice = await seller.req('PATCH', `/api/delivery-requests/${id}`, { priceMinor: 60000, note: 'seller note' });
  assert.equal(bySellerPrice.status, 200);
  assert.equal(bySellerPrice.json.data.price_minor, 60000);
  assert.equal(bySellerPrice.json.data.note, 'seller note');
  assert.equal((await outsider.req('PATCH', `/api/delivery-requests/${id}`, { note: 'x' })).status, 403);
  const byRequester = await buyer.req('PATCH', `/api/delivery-requests/${id}`, {
    title: 'New title', description: 'New desc', priceMinor: 70000, note: 'buyer note',
  });
  assert.equal(byRequester.status, 200);
  assert.equal(byRequester.json.data.title, 'New title');
  assert.equal(byRequester.json.data.description, 'New desc');
  assert.equal(byRequester.json.data.price_minor, 70000);
  assert.equal((await buyer.req('PATCH', `/api/delivery-requests/${id}`, {})).status, 400, 'empty patch is rejected');
});

test('edit after accept is rejected for both parties', async () => {
  const f = await acceptedFlow();
  assert.equal((await f.buyer.req('PATCH', `/api/delivery-requests/${f.request.id}`, { note: 'too late' })).status, 400);
  assert.equal((await f.seller.req('PATCH', `/api/delivery-requests/${f.request.id}`, { priceMinor: 1 })).status, 400);
});

// ---------- cancel ----------

test('cancel a REQUESTED request: requester or seller, outsider 403', async () => {
  for (const who of ['requester', 'seller']) {
    const buyer = await newUser('Buyer');
    const seller = await newUser('Seller');
    const convId = await makeDM(buyer, seller);
    const created = await createReq(buyer, convId, seller.user.id);
    const id = created.json.data.id;
    const actor = who === 'requester' ? buyer : seller;
    const r = await actor.req('POST', `/api/delivery-requests/${id}/cancel`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, 'CANCELLED');
  }
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const outsider = await newUser('Outsider');
  const convId = await makeDM(buyer, seller);
  const created = await createReq(buyer, convId, seller.user.id);
  assert.equal((await outsider.req('POST', `/api/delivery-requests/${created.json.data.id}/cancel`, {})).status, 403);
});

test('cancel an ACCEPTED request cascades to a pre-pickup delivery (CREATED and READY_FOR_PICKUP)', async () => {
  const f = await acceptedFlow();
  const cancelled = await f.buyer.req('POST', `/api/delivery-requests/${f.request.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.data.status, 'CANCELLED');
  const delivery = await f.seller.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.equal(delivery.json.data.status, 'CANCELLED');

  const g = await readyFlow();
  const cancelled2 = await g.seller.req('POST', `/api/delivery-requests/${g.request.id}/cancel`, {});
  assert.equal(cancelled2.status, 200);
  const delivery2 = await g.seller.req('GET', `/api/deliveries/${g.delivery.id}`);
  assert.equal(delivery2.json.data.status, 'CANCELLED');
});

test('cancel after DELIVERED is rejected, and re-cancel is rejected', async () => {
  const f = await deliveredFlow();
  assert.equal((await f.buyer.req('POST', `/api/delivery-requests/${f.request.id}/cancel`, {})).status, 400);
  const g = await acceptedFlow();
  await g.buyer.req('POST', `/api/delivery-requests/${g.request.id}/cancel`, {});
  assert.equal((await g.buyer.req('POST', `/api/delivery-requests/${g.request.id}/cancel`, {})).status, 400);
});

// ---------- prepare ----------

test('prepare: seller only, CREATED -> PREPARED, wrong states and courier orders rejected', async () => {
  const f = await acceptedFlow();
  assert.equal((await f.buyer.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {})).status, 403, 'buyer cannot prepare');
  const prep = await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {});
  assert.equal(prep.status, 200);
  assert.equal(prep.json.data.status, 'PREPARED');
  const detail = await f.seller.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.equal(detail.json.data.status, 'PREPARED');
  assert.ok(detail.json.data.prepared_at, 'prepared_at is set');
  assert.equal((await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {})).status, 400, 'second prepare rejected');

  // A courier delivery cannot be prepared through the marketplace path.
  const sender = await newUser('Sender');
  const order = await sender.req('POST', '/api/deliveries', {
    name: 'Courier parcel', category: 'Documents', size: 'Small (fits a bag)',
    pickupArea: 'A', dropoffArea: 'B',
  });
  assert.equal(order.status, 201);
  assert.equal((await sender.req('POST', `/api/deliveries/${order.json.data.id}/prepare`, {})).status, 400);
});

// ---------- drop-off ----------

test('dropoff: pin required, lat/lng ranges enforced, seller only, wrong state rejected', async () => {
  const f = await acceptedFlow();
  // Still CREATED: no drop-off yet.
  assert.equal((await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41,
  })).status, 400);
  await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {});
  assert.equal((await f.buyer.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41,
  })).status, 403, 'buyer cannot set the drop-off');
  assert.equal((await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLng: 90.41,
  })).status, 400, 'latitude is required');
  assert.equal((await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 91, dropoffLng: 90.41,
  })).status, 400);
  assert.equal((await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 181,
  })).status, 400);
  assert.equal((await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: -91, dropoffLng: 90.41,
  })).status, 400);
});

test('dropoff first set -> READY_FOR_PICKUP, coord source persisted, pin editable afterwards', async () => {
  const f = await acceptedFlow();
  await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {});
  const first = await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41, dropoffArea: 'Savar Bazar', dropoffCoordSource: 'gps',
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.status, 'READY_FOR_PICKUP');
  const detail = await f.seller.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.equal(detail.json.data.status, 'READY_FOR_PICKUP');
  assert.equal(detail.json.data.dropoffLat, 23.81);
  assert.equal(detail.json.data.dropoffLng, 90.41);
  assert.equal(detail.json.data.dropoff_coord_source, 'gps');
  assert.equal(detail.json.data.dropoffCoordSource, 'gps');
  assert.equal(detail.json.data.dropoffArea, 'Savar Bazar');
  assert.equal(detail.json.data.dropoff_photo_url, null, 'photo is optional for READY_FOR_PICKUP');
  // A later edit keeps the state and moves the pin.
  const edit = await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.75, dropoffLng: 90.38,
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.data.status, 'READY_FOR_PICKUP');
  const detail2 = await f.seller.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.equal(detail2.json.data.dropoffLat, 23.75);
  assert.equal(detail2.json.data.dropoff_coord_source, 'user-supplied', 'omitted source defaults to user-supplied');
});

test('dropoff photo: delivery-photo upload attaches, buyer-visible pickup code issued only at READY', async () => {
  const f = await acceptedFlow();
  await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {});
  const up = await f.seller.req('POST', `/api/files/deliveries/${f.delivery.id}/photo`,
    formFile(pngBytes(), 'dropoff.png'), { form: true });
  assert.equal(up.status, 201, `photo upload (got ${up.status}: ${up.text.slice(0, 200)})`);
  const fileId = up.json.data.id;
  const drop = await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41, dropoffPhotoFileId: fileId,
  });
  assert.equal(drop.status, 200);
  assert.equal(drop.json.data.status, 'READY_FOR_PICKUP');
  const detail = await f.buyer.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.equal(detail.json.data.dropoff_photo_file_id, fileId);
  assert.ok(detail.json.data.dropoff_photo_url, 'signed photo URL is returned');
  assert.equal(detail.json.data.dropoffPhotoUrl, detail.json.data.dropoff_photo_url);
  // Buyer sees ONLY the pickup stage; the code is a fresh 6-digit code.
  const codes = await f.buyer.req('GET', `/api/deliveries/${f.delivery.id}/codes`);
  assert.equal(codes.status, 200);
  assert.deepEqual(Object.keys(codes.json.data), ['pickup']);
  assert.match(codes.json.data.pickup.code, /^\d{6}$/);
});

test('dropoff photo: foreign photo id is 403, unknown id is 404, conversation upload is re-scoped', async () => {
  const f = await acceptedFlow();
  await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {});
  // A photo owned by someone else's delivery.
  const other = await acceptedFlow();
  const foreign = await other.seller.req('POST', `/api/files/deliveries/${other.delivery.id}/photo`,
    formFile(pngBytes(), 'other.png'), { form: true });
  assert.equal(foreign.status, 201);
  assert.equal((await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41, dropoffPhotoFileId: foreign.json.data.id,
  })).status, 403);
  assert.equal((await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41, dropoffPhotoFileId: '11111111-1111-4111-8111-111111111111',
  })).status, 404);
  // A seller upload scoped to the conversation is accepted and re-scoped.
  const convUp = await f.seller.req('POST', `/api/files/conversations/${f.convId}/upload`,
    formFile(pngBytes(), 'conv.png'), { form: true });
  assert.equal(convUp.status, 201);
  const ok = await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, {
    dropoffLat: 23.81, dropoffLng: 90.41, dropoffPhotoFileId: convUp.json.data.id,
  });
  assert.equal(ok.status, 200);
  const detail = await f.buyer.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.equal(detail.json.data.dropoff_photo_file_id, convUp.json.data.id);
  assert.ok(detail.json.data.dropoff_photo_url, 'buyer can use the re-scoped photo URL');
});

// ---------- arrive / handover ----------

test('arrive: buyer only, only from READY_FOR_PICKUP, sets arrived_at without changing state', async () => {
  const f = await acceptedFlow();
  await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/prepare`, {});
  assert.equal((await f.buyer.req('POST', `/api/deliveries/${f.delivery.id}/arrive`, {})).status, 400, 'cannot arrive before READY_FOR_PICKUP');
  await f.seller.req('PATCH', `/api/deliveries/${f.delivery.id}/dropoff`, { dropoffLat: 23.81, dropoffLng: 90.41 });
  assert.equal((await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/arrive`, {})).status, 403, 'seller cannot arrive');
  const arrived = await f.buyer.req('POST', `/api/deliveries/${f.delivery.id}/arrive`, {});
  assert.equal(arrived.status, 200);
  assert.equal(arrived.json.data.arrived, true);
  assert.equal(arrived.json.data.status, 'READY_FOR_PICKUP');
  const detail = await f.buyer.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.ok(detail.json.data.arrived_at, 'arrived_at is set');
  assert.equal(detail.json.data.status, 'READY_FOR_PICKUP');
});

test('handover: wrong code 400, buyer 403, correct code -> DELIVERED + cash record (recordOnly)', async () => {
  const f = await readyFlow();
  const code = await buyerPickupCode(f.buyer, f.delivery.id);
  assert.equal((await f.buyer.req('POST', `/api/deliveries/${f.delivery.id}/handover`, { code })).status, 403, 'buyer cannot hand over');
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/handover`, { code: wrong })).status, 400);
  const still = await f.seller.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.equal(still.json.data.status, 'READY_FOR_PICKUP', 'wrong code must not advance state');
  const hand = await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/handover`, { code });
  assert.equal(hand.status, 200);
  assert.equal(hand.json.data.status, 'DELIVERED');
  assert.equal(hand.json.data.recordOnly, true, 'no money moves in-app');
  const pay = hand.json.data.payment;
  assert.equal(pay.amount_minor, 50000);
  assert.equal(pay.currency, 'BDT');
  assert.equal(pay.method, 'cash');
  assert.equal(pay.payer_id, f.buyer.user.id);
  assert.equal(pay.payee_id, f.seller.user.id);
  assert.equal(hand.json.data.payment_record.id, pay.id);
  assert.equal(hand.json.data.cash_payment.id, pay.id);
  // Detail view carries the same record under all three aliases.
  const detail = await f.buyer.req('GET', `/api/deliveries/${f.delivery.id}`);
  assert.equal(detail.json.data.status, 'DELIVERED');
  assert.equal(detail.json.data.payment.amount_minor, 50000);
  assert.equal(detail.json.data.payment_record.amount_minor, 50000);
  assert.equal(detail.json.data.cash_payment.amount_minor, 50000);
  // Double handover is rejected; the used code now reads null to the buyer.
  assert.equal((await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/handover`, { code })).status, 400);
  const codesAfter = await f.buyer.req('GET', `/api/deliveries/${f.delivery.id}/codes`);
  assert.equal(codesAfter.json.data.pickup.code, null, 'used code is single-use');
  assert.equal((await f.buyer.req('POST', `/api/deliveries/${f.delivery.id}/arrive`, {})).status, 400, 'cannot arrive after DELIVERED');
});

test('handover with a null price records amount_minor 0; handover before READY is rejected', async () => {
  const f = await readyFlow({ priceMinor: null });
  const code = await buyerPickupCode(f.buyer, f.delivery.id);
  const hand = await f.seller.req('POST', `/api/deliveries/${f.delivery.id}/handover`, { code });
  assert.equal(hand.status, 200);
  assert.equal(hand.json.data.payment.amount_minor, 0);

  const g = await acceptedFlow();
  await g.seller.req('POST', `/api/deliveries/${g.delivery.id}/prepare`, {});
  assert.equal((await g.seller.req('POST', `/api/deliveries/${g.delivery.id}/handover`, { code: '000000' })).status, 400);
});

// ---------- settings ----------

test('settings: group non-admin 403, owner can disable, DM either participant allowed', async () => {
  const owner = await newUser('Owner');
  const member = await newUser('Member');
  const groupId = await makeGroup(owner, [member]);
  assert.equal((await member.req('PATCH', `/api/conversations/${groupId}/delivery-settings`, { enabled: false })).status, 403);
  const disabled = await owner.req('PATCH', `/api/conversations/${groupId}/delivery-settings`, { enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.data.deliverySettings.enabled, false);
  assert.equal(disabled.json.data.delivery_settings.enabled, false);
  const detail = await owner.req('GET', `/api/conversations/${groupId}`);
  assert.equal(detail.json.data.deliverySettings.enabled, false);
  assert.equal(detail.json.data.delivery_settings.enabled, false);

  // DM: either participant may change settings.
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const dmId = await makeDM(buyer, seller);
  assert.equal((await buyer.req('PATCH', `/api/conversations/${dmId}/delivery-settings`, { enabled: false })).status, 200);
  assert.equal((await seller.req('PATCH', `/api/conversations/${dmId}/delivery-settings`, { enabled: true })).status, 200);
  const dmDetail = await seller.req('GET', `/api/conversations/${dmId}`);
  assert.equal(dmDetail.json.data.deliverySettings.enabled, true);
  // A fresh conversation defaults to enabled.
  const buyer2 = await newUser('Buyer2');
  const seller2 = await newUser('Seller2');
  const dm2 = await makeDM(buyer2, seller2);
  const dm2Detail = await buyer2.req('GET', `/api/conversations/${dm2}`);
  assert.equal(dm2Detail.json.data.deliverySettings.enabled, true);
});

test('settings: disabled conversation rejects creates with 403; re-enable restores them', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const convId = await makeDM(buyer, seller);
  await buyer.req('PATCH', `/api/conversations/${convId}/delivery-settings`, { enabled: false });
  assert.equal((await createReq(buyer, convId, seller.user.id)).status, 403);
  await seller.req('PATCH', `/api/conversations/${convId}/delivery-settings`, { enabled: true });
  assert.equal((await createReq(buyer, convId, seller.user.id)).status, 201);
});

test('settings: allowRequests is stored but only enabled is enforced; list is NOT enriched', async () => {
  const buyer = await newUser('Buyer');
  const seller = await newUser('Seller');
  const convId = await makeDM(buyer, seller);
  const patched = await buyer.req('PATCH', `/api/conversations/${convId}/delivery-settings`, { allowRequests: 'admins_only' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.deliverySettings.allowRequests, 'admins_only');
  // Still creatable: allowRequests does not gate creation, enabled does.
  assert.equal((await createReq(buyer, convId, seller.user.id)).status, 201);
  const list = await buyer.req('GET', '/api/conversations');
  assert.equal(list.status, 200);
  const mine = list.json.data.find((c) => c.id === convId);
  assert.ok(mine, 'DM appears in the list');
  assert.equal(mine.deliverySettings, undefined, 'list endpoint is not enriched with settings');
  assert.equal(mine.delivery_settings, undefined);
});
