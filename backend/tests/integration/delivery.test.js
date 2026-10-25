import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';

let srv, sender, courier1, courier2, outsider;
test.before(async () => {
  srv = await startTestServer();
  sender = new Session(srv.baseUrl); await sender.initCsrf();
  courier1 = new Session(srv.baseUrl); await courier1.initCsrf();
  courier2 = new Session(srv.baseUrl); await courier2.initCsrf();
  outsider = new Session(srv.baseUrl); await outsider.initCsrf();
  await sender.anonymous('Sender');
  await courier1.anonymous('Courier One');
  await courier2.anonymous('Courier Two');
  await outsider.anonymous('Outsider');
  for (const c of [courier1, courier2]) {
    const reg = await c.req('POST', '/api/couriers/register', {});
    assert.equal(reg.status, 200);
  }
});
test.after(async () => { if (srv) await srv.close(); });

async function makeOrder() {
  const r = await sender.req('POST', '/api/deliveries', {
    name: 'Test parcel', category: 'Documents', size: 'Small (fits a bag)',
    pickupArea: 'Savar Bazar', dropoffArea: 'Dhanmondi',
  });
  assert.equal(r.status, 201);
  return r.json.data;
}

test('full delivery lifecycle with verified handover codes', async () => {
  const order = await makeOrder();
  assert.equal(order.status, 'SEARCHING_FOR_COURIER');
  const id = order.id;
  // Outsider (not a courier, not a participant) cannot see it.
  assert.equal((await outsider.req('GET', `/api/deliveries/${id}`)).status, 403);
  // Only the sender can view the codes.
  assert.equal((await courier1.req('GET', `/api/deliveries/${id}/codes`)).status, 403);
  const codes = await sender.req('GET', `/api/deliveries/${id}/codes`);
  assert.equal(codes.status, 200);
  const pickupCode = codes.json.data.pickup.code;
  const dropoffCode = codes.json.data.dropoff.code;
  assert.match(pickupCode, /^\d{6}$/);
  assert.notEqual(pickupCode, dropoffCode);
  // Claim, then a second courier loses the race.
  const claim = await courier1.req('POST', `/api/deliveries/${id}/claim`, {});
  assert.equal(claim.status, 200);
  assert.equal(claim.json.data.status, 'ASSIGNED');
  const lost = await courier2.req('POST', `/api/deliveries/${id}/claim`, {});
  assert.equal(lost.status, 409, 'exactly one courier may claim');
  // Accept.
  assert.equal((await courier1.req('POST', `/api/deliveries/${id}/step`, { to: 'ACCEPTED' })).status, 200);
  // Wrong pickup code fails and consumes an attempt.
  const wrong = await courier1.req('POST', `/api/deliveries/${id}/verify`, { stage: 'pickup', code: '000000' });
  assert.equal(wrong.status, 400);
  // Skipping ahead is rejected.
  assert.equal((await courier1.req('POST', `/api/deliveries/${id}/step`, { to: 'DELIVERED' })).status, 400);
  // Correct code verifies pickup; replay fails.
  const ok = await courier1.req('POST', `/api/deliveries/${id}/verify`, { stage: 'pickup', code: pickupCode });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.status, 'PICKUP_VERIFIED');
  const replay = await courier1.req('POST', `/api/deliveries/${id}/verify`, { stage: 'pickup', code: pickupCode });
  assert.equal(replay.status, 400, 'codes are single-use');
  // Transit, dropoff, delivered.
  assert.equal((await courier1.req('POST', `/api/deliveries/${id}/step`, { to: 'IN_TRANSIT' })).status, 200);
  const drop = await courier1.req('POST', `/api/deliveries/${id}/verify`, { stage: 'dropoff', code: dropoffCode });
  assert.equal(drop.status, 200);
  assert.equal(drop.json.data.status, 'DROPOFF_VERIFIED');
  assert.equal((await courier1.req('POST', `/api/deliveries/${id}/step`, { to: 'DELIVERED' })).status, 200);
  // History shows the full chain.
  const hist = await sender.req('GET', `/api/deliveries/${id}/history`);
  const states = hist.json.data.map((h) => h.to_status);
  assert.deepEqual(states, ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED', 'PICKUP_VERIFIED', 'IN_TRANSIT', 'DROPOFF_VERIFIED', 'DELIVERED']);
  // Terminal: no cancel, no dispute.
  assert.equal((await sender.req('POST', `/api/deliveries/${id}/cancel`, {})).status, 400);
});

test('cancel rules and disputes', async () => {
  const order = await makeOrder();
  const id = order.id;
  // Courier cannot cancel someone else's order.
  assert.equal((await courier1.req('POST', `/api/deliveries/${id}/cancel`, {})).status, 403);
  const dispute = await sender.req('POST', `/api/deliveries/${id}/dispute`, { reason: 'Wrong address listed' });
  assert.equal(dispute.status, 200);
  const cancelled = await sender.req('POST', `/api/deliveries/${id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.data.status, 'CANCELLED');
});

test('QR endpoint returns a PNG of the order reference only', async () => {
  const order = await makeOrder();
  const r = await sender.req('GET', `/api/deliveries/${order.id}/qr`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /png/);
  // Outsider cannot fetch the QR.
  assert.equal((await outsider.req('GET', `/api/deliveries/${order.id}/qr`)).status, 403);
});

test('route endpoint honestly reports no maps provider', async () => {
  const order = await makeOrder();
  const r = await sender.req('GET', `/api/deliveries/${order.id}/route`);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'MAPS_NOT_CONFIGURED');
});

test('unpublished order stays CREATED and invisible to the queue', async () => {
  const r = await sender.req('POST', '/api/deliveries', {
    name: 'Draft parcel', category: 'Other', size: 'Large',
    pickupArea: 'A', dropoffArea: 'B', publish: false,
  });
  assert.equal(r.json.data.status, 'CREATED');
  const queue = await courier1.req('GET', '/api/deliveries?view=queue');
  assert.equal(queue.json.data.some((d) => d.id === r.json.data.id), false);
});
