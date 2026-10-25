// Maps / GPS integration tests (Phase 5).
//
// Two layers, kept strictly separate:
//  (a) Provider unit behavior with an injected stub transport — the stub
//      lives ONLY in this test file and is never production behavior.
//  (b) The real HTTP route endpoint against a local stub OSRM/Nominatim
//      server (MAPS_*_BASE_URL pointed at it). The endpoint runs the real
//      OsmProvider code path, so success/error/timeout mapping is tested
//      end to end without ever claiming a stub response is a provider one.
// A live demo smoke test exists but is opt-in (NEXORA_MAPS_LIVE_SMOKE=1)
// and skipped otherwise, so the suite never fails for lack of network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, Session } from '../helpers.js';
import { MapsError, assertCoordinates } from '../../src/services/maps/provider.js';
import { OsmProvider } from '../../src/services/maps/osrm.js';

// ---- local stub "OSRM + Nominatim" server ---------------------------------
let stubMode = 'ok'; // 'ok' | 'provider-error' | 'hang' | 'no-result' | 'no-route'
let stub;
let stubUrl;
test.before(async () => {
  stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (stubMode === 'hang') return; // never respond: exercises the timeout
    if (u.pathname === '/search') {
      if (stubMode === 'provider-error') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'STUB_INTERNAL_BOOM' })); }
      if (stubMode === 'no-result') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[]'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ lat: '23.8103', lon: '90.4125', display_name: 'Stub Place, Dhaka' }]));
    }
    if (u.pathname.startsWith('/route/v1/')) {
      if (stubMode === 'provider-error') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 'Error', message: 'STUB_INTERNAL_BOOM' })); }
      if (stubMode === 'no-route') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 'NoRoute', routes: [] })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: 2949.6, duration: 380.7 }] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${stub.address().port}`;
});

// ---- app server ------------------------------------------------------------
let srv, sender, courier, outsider, anon;
function clearMapsEnv() {
  for (const k of ['MAPS_PROVIDER', 'MAPS_ROUTE_BASE_URL', 'MAPS_GEOCODE_BASE_URL', 'MAPS_TIMEOUT_MS', 'MAPS_PROFILE']) delete process.env[k];
}
function setOsrmEnv(timeoutMs = '5000') {
  process.env.MAPS_PROVIDER = 'osrm';
  process.env.MAPS_ROUTE_BASE_URL = stubUrl;
  process.env.MAPS_GEOCODE_BASE_URL = stubUrl;
  process.env.MAPS_TIMEOUT_MS = timeoutMs;
  delete process.env.MAPS_PROFILE;
}
test.before(async () => {
  clearMapsEnv();
  srv = await startTestServer();
  sender = new Session(srv.baseUrl); await sender.initCsrf();
  courier = new Session(srv.baseUrl); await courier.initCsrf();
  outsider = new Session(srv.baseUrl); await outsider.initCsrf();
  anon = new Session(srv.baseUrl); await anon.initCsrf();
  await sender.anonymous('Maps Sender');
  await courier.anonymous('Maps Courier');
  await outsider.anonymous('Maps Outsider');
  const reg = await courier.req('POST', '/api/couriers/register', {});
  assert.equal(reg.status, 200);
});
test.after(async () => {
  if (srv) await srv.close();
  if (stub) { stub.closeAllConnections?.(); await new Promise((resolve) => stub.close(resolve)); }
});

async function makeOrder(coords = {}) {
  const r = await sender.req('POST', '/api/deliveries', {
    name: 'Maps parcel', category: 'Documents', size: 'Small (fits a bag)',
    pickupArea: 'Savar', dropoffArea: 'Dhanmondi', ...coords,
  });
  assert.equal(r.status, 201);
  return r.json.data;
}

// ---- provider unit behavior (injected stub transport) -----------------------
test('provider: coordinate validation accepts boundaries, rejects NaN/out-of-range', () => {
  assert.deepEqual(assertCoordinates(90, 180), { lat: 90, lng: 180 });
  assert.deepEqual(assertCoordinates(-90, -180), { lat: -90, lng: -180 });
  assert.deepEqual(assertCoordinates(0, 0), { lat: 0, lng: 0 });
  for (const [lat, lng] of [[90.0001, 0], [-90.1, 0], [0, 180.1], [0, -180.5], [Number.NaN, 0], [0, Number.NaN], [Infinity, 0], ['23', 90]]) {
    assert.throws(() => assertCoordinates(lat, lng), (e) => e instanceof MapsError && e.code === 'INVALID_COORDINATES' && e.status === 400);
  }
});

test('provider: OsmProvider normalizes a stub route and geocode result', async () => {
  const fetchStub = async (url) => {
    if (String(url).includes('/search')) {
      return { ok: true, json: async () => [{ lat: '23.8103', lon: '90.4125', display_name: 'Stub Place, Dhaka' }] };
    }
    return { ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 2949.6, duration: 380.7 }] }) };
  };
  const p = new OsmProvider({ fetchImpl: fetchStub, routeBaseUrl: 'http://stub', geocodeBaseUrl: 'http://stub' });
  const hit = await p.geocode('Stub Place');
  assert.equal(hit.lat, 23.8103); assert.equal(hit.lng, 90.4125);
  const route = await p.route({ lat: 23.81, lng: 90.41 }, { lat: 23.83, lng: 90.43 });
  assert.equal(route.distanceMeters, 2949.6);
  assert.equal(route.durationSeconds, 380.7);
  assert.equal(route.geometry, null, 'no geometry is fabricated when overview=false');
  assert.match(route.attribution, /OpenStreetMap/);
});

test('provider: OsmProvider maps HTTP 500 to MapsError 502 without provider internals', async () => {
  const fetchStub = async () => ({ ok: false, status: 500, json: async () => ({ message: 'STUB_INTERNAL_BOOM' }) });
  const p = new OsmProvider({ fetchImpl: fetchStub, routeBaseUrl: 'http://stub', geocodeBaseUrl: 'http://stub' });
  await assert.rejects(() => p.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }),
    (e) => e instanceof MapsError && e.code === 'PROVIDER_ERROR' && e.status === 502 && !e.message.includes('STUB_INTERNAL_BOOM'));
});

test('provider: OsmProvider maps an aborted fetch to TIMEOUT 503', async () => {
  const fetchStub = (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const p = new OsmProvider({ fetchImpl: fetchStub, routeBaseUrl: 'http://stub', geocodeBaseUrl: 'http://stub', timeoutMs: 50 });
  await assert.rejects(() => p.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }),
    (e) => e instanceof MapsError && e.code === 'TIMEOUT' && e.status === 503);
});

// ---- route endpoint --------------------------------------------------------
test('route: unconfigured provider returns truthful 503', async () => {
  clearMapsEnv(); stubMode = 'ok';
  const order = await makeOrder({ pickupLat: 23.81, pickupLng: 90.41, dropoffLat: 23.83, dropoffLng: 90.43 });
  const r = await sender.req('GET', `/api/deliveries/${order.id}/route`);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'MAPS_NOT_CONFIGURED');
});

test('route: unknown provider returns 503, not a fabricated route', async () => {
  process.env.MAPS_PROVIDER = 'mapbox'; stubMode = 'ok';
  const order = await makeOrder({ pickupLat: 23.81, pickupLng: 90.41, dropoffLat: 23.83, dropoffLng: 90.43 });
  const r = await sender.req('GET', `/api/deliveries/${order.id}/route`);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'MAPS_NOT_IMPLEMENTED');
});

test('route: stub OSRM success returns distance/duration with attribution', async () => {
  setOsrmEnv(); stubMode = 'ok';
  const order = await makeOrder({ pickupLat: 23.81, pickupLng: 90.41, dropoffLat: 23.83, dropoffLng: 90.43 });
  const r = await sender.req('GET', `/api/deliveries/${order.id}/route`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.distanceMeters, 2949.6);
  assert.equal(r.json.data.durationSeconds, 380.7);
  assert.equal(r.json.data.from.source, 'delivery');
  assert.equal(r.json.data.from.lat, 23.81);
  assert.match(r.json.data.attribution, /OpenStreetMap/);
});

test('route: authorization — outsider 403, courier-viewer allowed, anonymous 401', async () => {
  setOsrmEnv(); stubMode = 'ok';
  const order = await makeOrder({ pickupLat: 23.81, pickupLng: 90.41, dropoffLat: 23.83, dropoffLng: 90.43 });
  assert.equal(order.status, 'SEARCHING_FOR_COURIER');
  assert.equal((await outsider.req('GET', `/api/deliveries/${order.id}/route`)).status, 403);
  assert.equal((await courier.req('GET', `/api/deliveries/${order.id}/route`)).status, 200, 'registered courier may view a queue order route');
  assert.equal((await anon.req('GET', `/api/deliveries/${order.id}/route`)).status, 401);
});

test('route: invalid coordinates rejected 400; boundaries accepted', async () => {
  setOsrmEnv(); stubMode = 'ok';
  const order = await makeOrder({ pickupLat: 23.81, pickupLng: 90.41, dropoffLat: 23.83, dropoffLng: 90.43 });
  const base = `/api/deliveries/${order.id}/route`;
  assert.equal((await sender.req('GET', `${base}?pickupLat=91&pickupLng=90.41&dropoffLat=23.83&dropoffLng=90.43`)).status, 400);
  assert.equal((await sender.req('GET', `${base}?pickupLat=NaN&pickupLng=90.41&dropoffLat=23.83&dropoffLng=90.43`)).status, 400);
  assert.equal((await sender.req('GET', `${base}?pickupLat=23.81&dropoffLat=23.83&dropoffLng=90.43`)).status, 400, 'one half of a pair is not enough');
  assert.equal((await sender.req('GET', `${base}?pickupLat=90&pickupLng=-180&dropoffLat=-90&dropoffLng=180`)).status, 200);
});

test('route: order without coordinates is 400; explicit query coords fix it', async () => {
  setOsrmEnv(); stubMode = 'ok';
  const order = await makeOrder();
  const base = `/api/deliveries/${order.id}/route`;
  const missing = await sender.req('GET', base);
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'ROUTE_COORDS_MISSING');
  const fixed = await sender.req('GET', `${base}?pickupLat=23.81&pickupLng=90.41&dropoffLat=23.83&dropoffLng=90.43`);
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json.data.from.source, 'user-supplied', 'query coords are labeled user-supplied, never GPS-verified');
});

test('route: provider error maps to generic 502 without leaking internals', async () => {
  setOsrmEnv(); stubMode = 'provider-error';
  const order = await makeOrder({ pickupLat: 23.81, pickupLng: 90.41, dropoffLat: 23.83, dropoffLng: 90.43 });
  const r = await sender.req('GET', `/api/deliveries/${order.id}/route`);
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'MAPS_PROVIDER_ERROR');
  assert.ok(!JSON.stringify(r.json).includes('STUB_INTERNAL_BOOM'), 'stub internals must not leak');
  stubMode = 'ok';
});

test('route: provider timeout maps to 503 MAPS_TIMEOUT', async () => {
  setOsrmEnv('200'); stubMode = 'hang';
  const order = await makeOrder({ pickupLat: 23.81, pickupLng: 90.41, dropoffLat: 23.83, dropoffLng: 90.43 });
  const r = await sender.req('GET', `/api/deliveries/${order.id}/route`);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'MAPS_TIMEOUT');
  stubMode = 'ok'; setOsrmEnv();
});

test('route: explicit place names are geocoded; an unknown place is 404', async () => {
  setOsrmEnv(); stubMode = 'ok';
  const order = await makeOrder();
  const base = `/api/deliveries/${order.id}/route`;
  const r = await sender.req('GET', `${base}?pickup=${encodeURIComponent('Stub Place')}&dropoff=${encodeURIComponent('Stub Place')}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.from.source, 'geocoded');
  assert.equal(r.json.data.from.displayName, 'Stub Place, Dhaka');
  stubMode = 'no-result';
  const nf = await sender.req('GET', `${base}?pickup=${encodeURIComponent('Nowhere')}&dropoff=${encodeURIComponent('Stub Place')}`);
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, 'PLACE_NOT_FOUND');
  stubMode = 'ok';
});

// Live smoke test: runs ONLY with NEXORA_MAPS_LIVE_SMOKE=1 (one real demo
// request through the real endpoint). Skipped otherwise, so the suite is
// hermetic by default. Kept last: it retargets the provider env at demo.
test('live smoke: OSRM demo returns a real route through the endpoint', { skip: process.env.NEXORA_MAPS_LIVE_SMOKE !== '1' }, async () => {
  clearMapsEnv();
  process.env.MAPS_PROVIDER = 'osrm';
  process.env.MAPS_TIMEOUT_MS = '15000';
  const order = await makeOrder({ pickupLat: 52.52167215019524, pickupLng: 13.414167165756226, dropoffLat: 52.5003103, dropoffLng: 13.4197763 });
  const r = await sender.req('GET', `/api/deliveries/${order.id}/route`);
  assert.equal(r.status, 200, `live demo should succeed, got ${r.status} ${JSON.stringify(r.json)}`);
  assert.ok(r.json.data.distanceMeters > 0, 'live route must carry a real positive distance');
  assert.ok(r.json.data.durationSeconds > 0, 'live route must carry a real positive duration');
});
