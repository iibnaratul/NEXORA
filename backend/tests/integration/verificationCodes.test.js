// Phase 7 — verification-code expiration and replay tests, pickup and
// drop-off separately. Every check drives the real backend (no mocks of the
// verification logic); the only direct-DB steps are test setup/teardown
// (expiring a challenge, inspecting stored-row shape), never a substitute
// for a verify call. Code values are held in local variables only and are
// never logged or printed by this file.
//
// Deterministic expiry: the ciphertext payload does NOT embed an expiry
// (helpers.encryptCode is base64(iv[12] | tag[16] | ciphertext) only), so
// crafting an "expired artifact" via the encrypt helper is impossible —
// expiry lives in verification_challenges.expires_at. The deterministic
// method used here (real-PostgreSQL runs only) is therefore to move that
// column into the past with a direct UPDATE and then submit the still-
// correct code through the real /verify endpoint. A tiny-TTL second server
// is not possible in-process because config is loaded once per process, so
// it is not used. Under pg-mem (no NEXORA_TEST_DATABASE_URL) the expiry
// and stored-row tests skip, and all API-only tests still run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';

// Auth rate limiting is per-IP for unauthenticated callers (10/min default),
// and this file creates many anonymous courier accounts; raise only the auth
// allowance (read per request by the limiter) so account setup is not the
// thing under test. The delivery limiter under test in 6b is left at default.
process.env.AUTH_RATE_LIMIT_MAX = '1000';

let srv, sender, dbPool;
const REAL_DB = !!process.env.NEXORA_TEST_DATABASE_URL;

test.before(async () => {
  srv = await startTestServer();
  if (REAL_DB) {
    const pg = await import('pg');
    dbPool = new pg.Pool({ connectionString: process.env.NEXORA_TEST_DATABASE_URL });
  }
  sender = new Session(srv.baseUrl);
  await sender.initCsrf();
  await sender.anonymous('Phase7 Sender');
});

test.after(async () => {
  if (dbPool) await dbPool.end();
  if (srv) await srv.close();
});

// A fresh courier per delivery: isolates per-user delivery rate limiting
// (60/hr) and per-challenge attempt counting between tests.
async function makeCourier(name) {
  const c = new Session(srv.baseUrl);
  await c.initCsrf();
  await c.anonymous(name);
  const reg = await c.req('POST', '/api/couriers/register', {});
  assert.equal(reg.status, 200);
  return c;
}

async function makeOrder() {
  const r = await sender.req('POST', '/api/deliveries', {
    name: 'Phase7 parcel', category: 'Documents', size: 'Small (fits a bag)',
    pickupArea: 'Savar Bazar', dropoffArea: 'Dhanmondi',
  });
  assert.equal(r.status, 201);
  return r.json.data;
}

async function getCodes(id) {
  const r = await sender.req('GET', `/api/deliveries/${id}/codes`);
  assert.equal(r.status, 200);
  return r.json.data;
}

async function getStatus(id, session = sender) {
  const r = await session.req('GET', `/api/deliveries/${id}`);
  assert.equal(r.status, 200);
  return r.json.data.status;
}

async function historyToStates(id) {
  const r = await sender.req('GET', `/api/deliveries/${id}/history`);
  assert.equal(r.status, 200);
  return r.json.data.map((h) => h.to_status);
}

// Drive a fresh order to ACCEPTED and return its (sender-visible) codes.
async function driveToAccepted() {
  const courier = await makeCourier('Phase7 Courier');
  const order = await makeOrder();
  const id = order.id;
  assert.equal((await courier.req('POST', `/api/deliveries/${id}/claim`, {})).status, 200);
  assert.equal((await courier.req('POST', `/api/deliveries/${id}/step`, { to: 'ACCEPTED' })).status, 200);
  const codes = await getCodes(id);
  assert.match(codes.pickup.code, /^\d{6}$/);
  assert.match(codes.dropoff.code, /^\d{6}$/);
  assert.notEqual(codes.pickup.code, codes.dropoff.code);
  return { courier, id, publicRef: order.public_ref, codes };
}

async function driveToInTransit() {
  const d = await driveToAccepted();
  const ok = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.status, 'PICKUP_VERIFIED');
  assert.equal((await d.courier.req('POST', `/api/deliveries/${d.id}/step`, { to: 'IN_TRANSIT' })).status, 200);
  return d;
}

// A wrong 6-digit code guaranteed different from the given real one.
function wrongCode(real) {
  return real === '000000' ? '111111' : '000000';
}

async function expireChallenge(deliveryId, stage) {
  assert.ok(dbPool, 'expiry setup needs real PostgreSQL');
  const r = await dbPool.query(
    "UPDATE verification_challenges SET expires_at = now() - interval '1 hour' WHERE delivery_id = $1 AND stage = $2",
    [deliveryId, stage],
  );
  assert.equal(r.rowCount, 1);
}

// Raw fetch for the QR endpoint so PNG bytes are not mangled by text().
async function fetchQr(session, id) {
  const res = await fetch(`${srv.baseUrl}/api/deliveries/${id}/qr`, {
    headers: { Cookie: session.cookieHeader() },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type'), buf };
}

// --- 1. Stage binding: a code succeeds only for its intended delivery+stage.
test('1a pickup code succeeds at pickup, fails at dropoff; dropoff code fails at pickup', async () => {
  const d = await driveToAccepted();
  // Dropoff code presented at the pickup stage: rejected, state unchanged.
  const cross1 = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.dropoff.code });
  assert.equal(cross1.status, 400);
  assert.equal(await getStatus(d.id), 'ACCEPTED');
  // Pickup code at its own stage: success.
  const ok = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.status, 'PICKUP_VERIFIED');
  assert.equal((await d.courier.req('POST', `/api/deliveries/${d.id}/step`, { to: 'IN_TRANSIT' })).status, 200);
  // The (now consumed) pickup code presented at the dropoff stage: rejected.
  const cross2 = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'dropoff', code: d.codes.pickup.code });
  assert.equal(cross2.status, 400);
  assert.equal(await getStatus(d.id), 'IN_TRANSIT');
  // Dropoff code at its own stage: success.
  const drop = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'dropoff', code: d.codes.dropoff.code });
  assert.equal(drop.status, 200);
  assert.equal(drop.json.data.status, 'DROPOFF_VERIFIED');
});

// --- 2. Wrong code rejected and an attempt is registered.
// VERIFIED BUG (see final report): the wrong-code UPDATE runs inside the
// verify transaction, and the thrown CODE_WRONG error rolls that transaction
// back, so attempts never persist and lockout (6a) can never trigger via the
// API. These assertions state the documented behavior and fail on the
// current code; they are kept as-is, not weakened to match the bug.
test('2 wrong code is rejected and consumes one attempt (via attemptsLeft)', async () => {
  const d = await driveToAccepted();
  const before = await getCodes(d.id);
  const bad = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: wrongCode(d.codes.pickup.code) });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'CODE_WRONG');
  assert.equal(await getStatus(d.id), 'ACCEPTED');
  const after = await getCodes(d.id);
  assert.equal(after.pickup.attemptsLeft, before.pickup.attemptsLeft - 1);
  assert.equal(after.dropoff.attemptsLeft, before.dropoff.attemptsLeft, 'dropoff attempts untouched by a pickup failure');
  // The real code still works after one wrong attempt (not yet locked).
  const ok = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code });
  assert.equal(ok.status, 200);
});

// --- 3. Expiry, pickup and dropoff separately (real PostgreSQL only).
test('3a expired pickup code is rejected with CODE_EXPIRED and no state change', async (t) => {
  if (!REAL_DB) { t.skip('expiry setup needs direct DB access (real PostgreSQL)'); return; }
  const d = await driveToAccepted();
  const before = await getCodes(d.id);
  await expireChallenge(d.id, 'pickup');
  const r = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'CODE_EXPIRED');
  assert.equal(await getStatus(d.id), 'ACCEPTED');
  assert.deepEqual((await historyToStates(d.id)).filter((s) => s === 'PICKUP_VERIFIED'), []);
  // Expiry is checked before attempt counting: attempts are not consumed.
  const after = await getCodes(d.id);
  assert.equal(after.pickup.attemptsLeft, before.pickup.attemptsLeft);
});

test('3b expired dropoff code is rejected with CODE_EXPIRED and no state change', async (t) => {
  if (!REAL_DB) { t.skip('expiry setup needs direct DB access (real PostgreSQL)'); return; }
  const d = await driveToInTransit();
  const before = await getCodes(d.id);
  await expireChallenge(d.id, 'dropoff');
  const r = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'dropoff', code: d.codes.dropoff.code });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'CODE_EXPIRED');
  assert.equal(await getStatus(d.id), 'IN_TRANSIT');
  assert.deepEqual((await historyToStates(d.id)).filter((s) => s === 'DROPOFF_VERIFIED'), []);
  const after = await getCodes(d.id);
  assert.equal(after.dropoff.attemptsLeft, before.dropoff.attemptsLeft);
});

// --- 4. Single-use: a consumed code cannot be reused, no state change.
test('4 consumed pickup and dropoff codes cannot be reused', async () => {
  const d = await driveToAccepted();
  const histBefore = await historyToStates(d.id);
  assert.equal((await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code })).status, 200);
  // Replay: rejected (state machine no longer allows pickup verification
  // from PICKUP_VERIFIED) and the history is unchanged by the replay.
  const replay = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code });
  assert.equal(replay.status, 400);
  assert.equal(await getStatus(d.id), 'PICKUP_VERIFIED');
  assert.deepEqual(await historyToStates(d.id), [...histBefore, 'PICKUP_VERIFIED']);
  // Sender-side codes view also hides a consumed code.
  const codes = await getCodes(d.id);
  assert.equal(codes.pickup.code, null);
  assert.equal(codes.pickup.used, true);
  // Same for dropoff.
  assert.equal((await d.courier.req('POST', `/api/deliveries/${d.id}/step`, { to: 'IN_TRANSIT' })).status, 200);
  assert.equal((await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'dropoff', code: d.codes.dropoff.code })).status, 200);
  const replayDrop = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'dropoff', code: d.codes.dropoff.code });
  assert.equal(replayDrop.status, 400);
  assert.equal(await getStatus(d.id), 'DROPOFF_VERIFIED');
});

// --- 5. Cross-delivery: a code is rejected against a different delivery.
test('5 a delivery code is rejected against a different delivery at the same stage', async () => {
  const a = await driveToAccepted();
  const b = await driveToAccepted();
  // Courier for B submits A's pickup code to B: rejected, B unchanged,
  // and A's code remains valid afterwards (no cross-contamination).
  const cross = await b.courier.req('POST', `/api/deliveries/${b.id}/verify`, { stage: 'pickup', code: a.codes.pickup.code });
  assert.equal(cross.status, 400);
  assert.equal(cross.json.error.code, 'CODE_WRONG');
  assert.equal(await getStatus(b.id), 'ACCEPTED');
  assert.equal((await a.courier.req('POST', `/api/deliveries/${a.id}/verify`, { stage: 'pickup', code: a.codes.pickup.code })).status, 200);
  assert.equal((await b.courier.req('POST', `/api/deliveries/${b.id}/verify`, { stage: 'pickup', code: b.codes.pickup.code })).status, 200);
});

// --- 6. Attempt limits, plus the delivery rate limiter.
test('6a after max attempts the code locks: even the correct code gets CODE_LOCKED', async () => {
  const d = await driveToAccepted();
  const start = await getCodes(d.id);
  assert.equal(start.pickup.attemptsLeft, 5, 'DB default max_attempts is 5');
  for (let i = 0; i < 5; i++) {
    const bad = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: wrongCode(d.codes.pickup.code) });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'CODE_WRONG');
  }
  const locked = await getCodes(d.id);
  assert.equal(locked.pickup.attemptsLeft, 0);
  // The correct code is now unusable, with a DISTINCT locked status.
  const r = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'CODE_LOCKED');
  assert.equal(await getStatus(d.id), 'ACCEPTED');
  // A further wrong attempt stays locked (not a generic rejection).
  const again = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: wrongCode(d.codes.pickup.code) });
  assert.equal(again.json.error.code, 'CODE_LOCKED');
});

test('6b delivery rate limiter: a fresh user hits 429 after the hourly allowance', async () => {
  const fresh = new Session(srv.baseUrl);
  await fresh.initCsrf();
  await fresh.anonymous('Phase7 RateLimit');
  const statuses = [];
  for (let i = 0; i < 61; i++) {
    const r = await fresh.req('POST', '/api/deliveries', {
      name: 'Rate parcel', category: 'Other', size: 'Large',
      pickupArea: 'A', dropoffArea: 'B',
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 60), Array(60).fill(201));
  assert.equal(statuses[60], 429, '61st delivery-scoped request in the hour is rate-limited');
});

// --- 7. Duplicate transitions: concurrent + sequential valid submissions.
test('7a concurrent duplicate pickup submissions produce exactly one transition', async (t) => {
  if (!REAL_DB) { t.skip('concurrency semantics differ under the pg-mem emulator; sequential case is covered in 7b'); return; }
  const d = await driveToAccepted();
  const [r1, r2] = await Promise.all([
    d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code }),
    d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code }),
  ]);
  const okCount = [r1, r2].filter((r) => r.status === 200).length;
  assert.equal(okCount, 1, 'exactly one concurrent submission succeeds');
  assert.equal([r1, r2].filter((r) => r.status === 400).length, 1);
  assert.equal(await getStatus(d.id), 'PICKUP_VERIFIED');
  assert.equal((await historyToStates(d.id)).filter((s) => s === 'PICKUP_VERIFIED').length, 1);
});

test('7b sequential duplicate submissions produce exactly one transition', async () => {
  const d = await driveToInTransit();
  // Dropoff: first succeeds, second is rejected, history has exactly one entry.
  assert.equal((await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'dropoff', code: d.codes.dropoff.code })).status, 200);
  assert.equal((await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'dropoff', code: d.codes.dropoff.code })).status, 400);
  assert.equal((await historyToStates(d.id)).filter((s) => s === 'DROPOFF_VERIFIED').length, 1);
  assert.equal(await getStatus(d.id), 'DROPOFF_VERIFIED');
});

// --- 8. Unauthorized retrieval of the plaintext code.
test('8 code retrieval is sender-only across every probed caller', async () => {
  const d = await driveToAccepted();
  const otherCourier = await makeCourier('Phase7 OtherCourier');
  const otherOrder = await makeOrder();
  assert.equal((await otherCourier.req('POST', `/api/deliveries/${otherOrder.id}/claim`, {})).status, 200);
  const outsider = new Session(srv.baseUrl);
  await outsider.initCsrf();
  await outsider.anonymous('Phase7 Outsider');
  const unauth = new Session(srv.baseUrl);
  await unauth.initCsrf(); // no login at all

  // GET /codes itself:
  assert.equal((await unauth.req('GET', `/api/deliveries/${d.id}/codes`)).status, 401, 'anonymous caller');
  assert.equal((await outsider.req('GET', `/api/deliveries/${d.id}/codes`)).status, 403, 'unrelated authenticated user');
  assert.equal((await d.courier.req('GET', `/api/deliveries/${d.id}/codes`)).status, 403, 'assigned courier');
  assert.equal((await otherCourier.req('GET', `/api/deliveries/${d.id}/codes`)).status, 403, 'courier of a different delivery');
  // No other probed endpoint leaks code material:
  const detail = await d.courier.req('GET', `/api/deliveries/${d.id}`);
  assert.equal(detail.status, 200);
  assert.equal('code' in detail.json.data, false);
  assert.equal(JSON.stringify(detail.json.data).includes(d.codes.pickup.code), false);
  const mine = await d.courier.req('GET', '/api/deliveries?view=mine');
  assert.equal(mine.status, 200);
  assert.equal(JSON.stringify(mine.json.data).includes(d.codes.pickup.code), false);
  const hist = await d.courier.req('GET', `/api/deliveries/${d.id}/history`);
  assert.equal(hist.status, 200);
  assert.equal(JSON.stringify(hist.json.data).includes(d.codes.pickup.code), false);
  const qr = await fetchQr(d.courier, d.id);
  assert.equal(qr.status, 200);
  assert.equal(qr.buf.includes(Buffer.from(d.codes.pickup.code)), false);
  assert.equal(qr.buf.includes(Buffer.from(d.codes.dropoff.code)), false);
});

// --- 9. QR / public reference alone authorizes nothing.
test('9 public reference (QR payload) is rejected as a code, and the QR carries no code', async () => {
  const d = await driveToAccepted();
  const qr = await fetchQr(sender, d.id);
  assert.equal(qr.status, 200);
  assert.match(qr.contentType, /png/);
  assert.deepEqual([...qr.buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic');
  assert.equal(qr.buf.includes(Buffer.from(d.codes.pickup.code)), false);
  assert.equal(qr.buf.includes(Buffer.from(d.codes.dropoff.code)), false);
  // The public reference submitted as if it were a code: rejected (it does
  // not match the 6-digit code format, so validation rejects it before any
  // verification logic runs), state unchanged.
  const asCode = await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.publicRef });
  assert.equal(asCode.status, 400);
  assert.equal(await getStatus(d.id), 'ACCEPTED');
  // A code-gated transition via /step (the other state-changing endpoint)
  // is also refused even when a code-looking body is supplied.
  const step = await d.courier.req('POST', `/api/deliveries/${d.id}/step`, { to: 'PICKUP_VERIFIED', code: d.codes.pickup.code });
  assert.equal(step.status, 400);
  assert.equal(await getStatus(d.id), 'ACCEPTED');
  // And the genuine code still works afterwards.
  assert.equal((await d.courier.req('POST', `/api/deliveries/${d.id}/verify`, { stage: 'pickup', code: d.codes.pickup.code })).status, 200);
});

// --- 10. Storage review: ciphertext, not hash or plaintext.
test('10a sender code view never exposes ciphertext (every backend)', async () => {
  const d = await driveToAccepted();
  const codes = await getCodes(d.id);
  assert.equal('code_encrypted' in codes.pickup, false);
  assert.equal(codes.pickup.used, false);
  assert.equal(codes.pickup.attemptsLeft, 5);
});

test('10b stored challenges are AES-GCM ciphertext with no plaintext column (real PostgreSQL only)', async (t) => {
  if (!REAL_DB) { t.skip('stored-row shape inspection needs real PostgreSQL'); return; }
  const d = await driveToAccepted();
  const cols = await dbPool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'verification_challenges' ORDER BY ordinal_position",
  );
  const names = cols.rows.map((r) => r.column_name);
  assert.ok(names.includes('code_encrypted'));
  assert.ok(names.includes('attempts') && names.includes('max_attempts'));
  assert.ok(names.includes('expires_at') && names.includes('used_at'));
  assert.equal(names.some((n) => ['code', 'code_plain', 'plaintext', 'code_hash'].includes(n)), false, 'no plaintext/hash column exists');
  const row = await dbPool.query(
    'SELECT code_encrypted, attempts, max_attempts FROM verification_challenges WHERE delivery_id = $1 AND stage = $2',
    [d.id, 'pickup'],
  );
  assert.equal(row.rows.length, 1);
  const stored = row.rows[0].code_encrypted;
  assert.match(stored, /^[A-Za-z0-9+/]+={0,2}$/, 'base64 envelope');
  // Shape only, never the value: iv(12) + tag(16) + 6-byte code = 34 bytes.
  assert.equal(Buffer.from(stored, 'base64').length, 34);
  assert.notEqual(stored, d.codes.pickup.code, 'stored value is not the plaintext code');
  assert.equal(row.rows[0].attempts, 0);
  assert.equal(row.rows[0].max_attempts, 5);
});
