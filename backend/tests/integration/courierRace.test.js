// Phase 6 — courier claim race-condition tests.
//
// What is under test: POST /api/deliveries/:id/claim in
// backend/src/routes/deliveries.js. The claim is a conditional UPDATE inside
// withTransaction:
//
//   UPDATE deliveries SET status = 'ASSIGNED', courier_id = $2, updated_at = now()
//     WHERE id = $1 AND status = 'SEARCHING_FOR_COURIER' AND courier_id IS NULL
//     RETURNING *
//
// (deliveries.js, claim handler). There is deliberately NO SELECT ... FOR
// UPDATE: under real PostgreSQL, concurrent UPDATEs of the same row
// serialize on the row lock; the loser re-evaluates the WHERE clause after
// the winner commits, finds status != 'SEARCHING_FOR_COURIER', gets zero
// rows, and the handler throws conflict() -> HTTP 409
// ('Order is no longer available to claim'). The assignment row, the
// participant row, and the ASSIGNED history row are inserted in the same
// transaction, so a losing claim inserts nothing.
//
// This is a concurrency CORRECTNESS test, NOT a load test: 3 couriers, one
// delivery per round, 20 independent rounds. It proves exactly-one-winner
// under contention; it says nothing about throughput or latency under load.
//
// Synchronization (deterministic, no sleeps): the competing requests are
// passed as arguments to a single Promise.all() call. JavaScript evaluates
// those arguments synchronously, and each Session.req() runs synchronously
// up to its fetch() call before yielding, so all claim requests are
// dispatched in the same tick with no await / setTimeout / sleep between
// them. Promise.all then awaits all of them together. No arbitrary delay is
// used anywhere to "make" the race happen.
//
// Setup note: the same 3 couriers are reused across rounds (each round gets
// a FRESH delivery, which is the contested resource). Fresh couriers per
// round were avoided deliberately: anonymous registration is IP-keyed and
// rate-limited to 10/minute (authLimiter), so 60 fresh anonymous couriers
// would hit 429s and pollute the race with limiter rejections. Reused
// couriers stay well under the per-user delivery limit (20 claims each,
// limit 60/hour) and the sender stays under it too (20 creations).
// Direct DB reads are used ONLY for verification, never to perform the
// assignment itself — every claim goes through the real HTTP API.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session } from '../helpers.js';
import { query } from '../../src/db.js';
import { DELIVERY_STATES } from '../../src/services/deliveryMachine.js';

const ROUNDS = 20;
const FULL_CHAIN = [
  'CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED',
  'PICKUP_VERIFIED', 'IN_TRANSIT', 'DROPOFF_VERIFIED', 'DELIVERED',
];

let srv;
let sender;
let couriers; // [{ session, id, label }]
let assertions = 0;

function eq(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}

function deepEq(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

test.before(async () => {
  srv = await startTestServer();
  sender = new Session(srv.baseUrl);
  await sender.initCsrf();
  await sender.anonymous('Race Sender');
  couriers = [];
  for (let i = 0; i < 3; i += 1) {
    const s = new Session(srv.baseUrl);
    await s.initCsrf();
    await s.anonymous(`Race Courier ${i + 1}`);
    const reg = await s.req('POST', '/api/couriers/register', {});
    eq(reg.status, 200, `courier ${i + 1} registration must succeed`);
    couriers.push({ session: s, id: s.user.id, label: `courier${i + 1}` });
  }
});

test.after(async () => { if (srv) await srv.close(); });

async function makeOrder(round) {
  const r = await sender.req('POST', '/api/deliveries', {
    name: `Race parcel round ${round}`, category: 'Documents', size: 'Small (fits a bag)',
    pickupArea: 'Savar Bazar', dropoffArea: 'Dhanmondi',
  });
  eq(r.status, 201, `round ${round}: delivery creation must succeed`);
  eq(r.json.data.status, 'SEARCHING_FOR_COURIER', `round ${round}: order must start assignable`);
  return r.json.data;
}

test('concurrent claims: exactly one winner in every round (20 rounds)', async () => {
  const outcomes = [];
  const winnerCounts = new Map(couriers.map((c) => [c.label, 0]));
  const loserStatuses = new Map();

  for (let round = 1; round <= ROUNDS; round += 1) {
    const order = await makeOrder(round);
    const id = order.id;

    // --- Deterministic barrier: all requests dispatched in the same tick.
    // Arguments to Promise.all are evaluated synchronously before the call,
    // and each req() reaches its fetch() before yielding, so no request gets
    // a head start from an await/sleep in this code.
    const responses = await Promise.all(
      couriers.map((c) => c.session.req('POST', `/api/deliveries/${id}/claim`, {})),
    );
    const statuses = responses.map((r) => r.status);
    const winnerIdx = statuses.indexOf(200);
    const winner = winnerIdx >= 0 ? couriers[winnerIdx] : null;
    const losers = statuses.filter((s) => s !== 200);

    // --- Verify via API + direct DB reads (reads only; assignment via API).
    const viaGet = await sender.req('GET', `/api/deliveries/${id}`);
    const dbDelivery = await query(
      'SELECT id, status, courier_id FROM deliveries WHERE id = $1', [id],
    );
    const dbAssignments = await query(
      'SELECT id, delivery_id, courier_id, status FROM courier_assignments WHERE delivery_id = $1',
      [id],
    );
    // Duplicate-row check scoped to this delivery, via a plain COUNT
    // aggregate (a GROUP BY ... HAVING query was tried first but pg-mem
    // does not implement HAVING; the row list above plus this COUNT give
    // the same no-duplicates evidence on both backends).
    const dbAssignCount = await query(
      'SELECT count(*) AS n FROM courier_assignments WHERE delivery_id = $1',
      [id],
    );
    const dbHistory = await query(
      `SELECT from_status, to_status, actor_id FROM delivery_status_history
        WHERE delivery_id = $1 ORDER BY seq`,
      [id],
    );
    const toSeq = dbHistory.rows.map((h) => h.to_status);
    const fromSeq = dbHistory.rows.map((h) => h.from_status);
    const assignedRows = dbHistory.rows.filter((h) => h.to_status === 'ASSIGNED');

    // Log the raw round evidence BEFORE asserting, so a failing round's
    // exact state is visible in the test output even though the test stops.
    console.log(
      `race round ${round}: delivery=${id} statuses=[${statuses.join(',')}] ` +
      `winner=${winner ? winner.label : 'NONE'} getStatus=${viaGet.json?.data?.status} ` +
      `dbStatus=${dbDelivery.rows[0]?.status} assignments=${dbAssignments.rows.length} ` +
      `assignCount=${dbAssignCount.rows[0]?.n} history=[${toSeq.join('>')}]`,
    );

    // --- Assertions: exactly one winner, losers get 409, no duplicates.
    eq(statuses.filter((s) => s === 200).length, 1,
      `round ${round}: exactly one claim must succeed, got statuses [${statuses.join(',')}]`);
    for (const s of losers) {
      eq(s, 409, `round ${round}: losing claims must receive HTTP 409, got ${s}`);
      loserStatuses.set(s, (loserStatuses.get(s) || 0) + 1);
    }
    winnerCounts.set(winner.label, winnerCounts.get(winner.label) + 1);

    // Post-race state via API agrees with the winner.
    eq(viaGet.status, 200, `round ${round}: sender must be able to GET the delivery`);
    eq(viaGet.json.data.status, 'ASSIGNED', `round ${round}: delivery must be ASSIGNED after the race`);
    eq(viaGet.json.data.courier_id, winner.id, `round ${round}: API courier must be the winning courier`);

    // Post-race state via DB agrees, and there is exactly one assignment row.
    eq(dbDelivery.rows.length, 1, `round ${round}: delivery row must exist`);
    eq(dbDelivery.rows[0].status, 'ASSIGNED', `round ${round}: DB status must be ASSIGNED`);
    eq(dbDelivery.rows[0].courier_id, winner.id, `round ${round}: DB courier must be the winning courier`);
    eq(dbAssignments.rows.length, 1,
      `round ${round}: exactly one courier_assignments row must exist, got ${dbAssignments.rows.length}`);
    eq(dbAssignments.rows[0].courier_id, winner.id,
      `round ${round}: assignment row must belong to the winning courier`);
    eq(Number(dbAssignCount.rows[0].n), 1, `round ${round}: assignment COUNT must be exactly 1 (no duplicates)`);

    // History consistency: exactly one ASSIGNED transition, valid chain.
    eq(assignedRows.length, 1,
      `round ${round}: exactly one ASSIGNED history row must exist, got ${assignedRows.length}`);
    eq(assignedRows[0].actor_id, winner.id,
      `round ${round}: ASSIGNED history actor must be the winning courier`);
    eq(assignedRows[0].from_status, 'SEARCHING_FOR_COURIER',
      `round ${round}: ASSIGNED transition must come from SEARCHING_FOR_COURIER`);
    deepEq(toSeq, ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED'],
      `round ${round}: history to_status sequence must be CREATED>SEARCHING_FOR_COURIER>ASSIGNED`);
    deepEq(fromSeq, [null, 'CREATED', 'SEARCHING_FOR_COURIER'],
      `round ${round}: history from_status chain must be consistent`);
    // Valid-prefix check against the state machine: the observed sequence
    // must be a prefix of the full legal chain, and the final state must be
    // a recognised state.
    deepEq(toSeq, FULL_CHAIN.slice(0, toSeq.length),
      `round ${round}: history must be a valid prefix of the state machine`);
    eq(DELIVERY_STATES.includes(dbDelivery.rows[0].status), true,
      `round ${round}: final status must be a recognised delivery state`);

    outcomes.push({ round, statuses, winner: winner.label, assignments: dbAssignments.rows.length });
  }

  console.log(
    `race summary: ${ROUNDS} rounds, winners=${JSON.stringify(Object.fromEntries(winnerCounts))}, ` +
    `loserStatuses=${JSON.stringify(Object.fromEntries(loserStatuses))}, ` +
    `roundsWithExactlyOneAssignment=${outcomes.filter((o) => o.assignments === 1).length}/${ROUNDS}, ` +
    `assertions=${assertions}`,
  );
  eq(outcomes.length, ROUNDS, 'all rounds must have run');
  eq(outcomes.filter((o) => o.assignments === 1).length, ROUNDS,
    'every round must end with exactly one assignment row');
});
