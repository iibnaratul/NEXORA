# NEXORA Maps / GPS (Phase 5)

## Chosen provider: the OSM stack — OSRM for routing, Nominatim for geocoding

No single no-key service does both well, so the provider interface
(`backend/src/services/maps/provider.js`) is implemented by one adapter
(`osrm.js`) over two OSM services that share data, licensing, and the
no-key model:

| | OSRM demo (`router.project-osrm.org`) | Nominatim (`nominatim.openstreetmap.org`) |
|---|---|---|
| Used for | `GET /route/v1/driving/{lng},{lat};{lng},{lat}` → distance + duration | `GET /search` → place name → coordinates |
| Key / account | None | None |
| Price | Free (donated infrastructure) | Free (donated infrastructure) |
| Coverage | Worldwide OSM road network, including Bangladesh | Worldwide OSM place data |
| Terms that bind us | Demo server: reasonable, non-commercial use; do not exceed ~1 request/second; no uptime, latency, or data-freshness guarantee | Absolute maximum 1 request/second **per application**; a valid identifying `User-Agent` (we send `NEXORA/1.0`); attribution displayed; no bulk geocoding; no search-as-you-type/autocomplete |
| Attribution | `© OpenStreetMap contributors, routing by OSRM, geocoding by Nominatim` — returned in every route response and rendered by the frontend | ODbL (share-alike) for OSM data |

### Why this, and why not the keyed alternatives

- **Mapbox, Google Maps, OpenRouteService, and similar** all need an API
  key (and usually billing/a card) that does not exist for this project.
  Inventing or hardcoding one was never an option, so a keyed provider
  would have left the endpoint at 503. They remain the right move for
  production scale: any of them can sit behind the same provider
  interface later (implement `geocode` + `route`, add the name to the
  factory, keep the key server-side in an env var — never in the
  frontend, never in logs, never in error responses).
- **Self-hosted OSRM / Nominatim** is the production path for the OSM
  stack: same API, different base URL, no demo-server limits. Point
  `MAPS_ROUTE_BASE_URL` / `MAPS_GEOCODE_BASE_URL` at your own instance.
- **Rendered maps (since 2026-10-26).** The frontend renders a real map:
  Leaflet 1.9.4 vendored locally under `frontend/vendor/leaflet/` (no CDN,
  no key) with OpenStreetMap tiles and the required attribution, a
  click-to-place/draggable pin picker for pickup and drop-off, and a pins
  map on the delivery detail page. The route response itself still carries
  distance/duration only, and its `geometry` field is honestly `null` (the
  OSRM call uses `overview=false`) — no route polyline is ever drawn, so
  no route line is fabricated.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MAPS_PROVIDER` | (empty = none) | `osrm` enables the OSM stack. Anything else → the route endpoint returns 503 `MAPS_NOT_IMPLEMENTED`. Empty → 503 `MAPS_NOT_CONFIGURED`. `render.yaml` sets `osrm` for the live Render deployment (2026-10-26); if a Blueprint sync does not apply it to the existing service, set it in the Render dashboard. The local default remains empty. |
| `MAPS_ROUTE_BASE_URL` | `https://router.project-osrm.org` | OSRM base URL (self-host override). |
| `MAPS_GEOCODE_BASE_URL` | `https://nominatim.openstreetmap.org` | Nominatim base URL (self-host override). |
| `MAPS_TIMEOUT_MS` | `5000` | Per-request timeout (clamped to 100–30000 ms) via `AbortSignal.timeout()`. |
| `MAPS_PROFILE` | `driving` | OSRM profile segment in the route URL. |

**No key variable exists for this stack, on purpose.** There is no
`MAPS_API_KEY` to obtain, restrict, or leak: OSM services need no key.
If a keyed provider is added later, its key must come from a server-side
env var, and any browser-visible public key must be documented here with
its origin/API restrictions before it ships — never bundled with a value.

## The route endpoint

`GET /api/deliveries/:id/route` (authenticated; same participant /
courier-queue authorization as the delivery itself; rate-limited by the
existing delivery limiter, 60/hour per user, plus the global API limiter).

Coordinate resolution, in order, per endpoint (pickup, then drop-off):
1. Explicit query coordinates (`pickupLat/pickupLng/dropoffLat/dropoffLng`).
2. Explicit place names (`pickup`/`dropoff`), geocoded server-side.
3. The delivery's stored `pickup_lat/lng` / `dropoff_lat/lng`.

Validation: latitude −90..90, longitude −180..180, finite numbers only
(boundaries inclusive); `NaN`, infinities, and out-of-range values are
400; one half of a coordinate pair without the other is 400. The
delivery's coarse `pickup_area`/`dropoff_area` strings are **never**
auto-geocoded — turning a deliberately coarse area into precise
coordinates would present a guess as a location. A delivery with no
coordinates and no query input is 400 `ROUTE_COORDS_MISSING`, not an
estimate.

Success response (real provider numbers, nothing estimated):

```json
{ "ok": true, "data": {
  "deliveryId": "…", "provider": "osrm", "profile": "driving",
  "from": { "lat": 23.81, "lng": 90.41, "source": "delivery" },
  "to":   { "lat": 23.83, "lng": 90.43, "source": "delivery" },
  "distanceMeters": 2949.6, "distanceKm": 2.9496,
  "durationSeconds": 380.7, "durationMinutes": 6.345,
  "geometry": null,
  "attribution": "© OpenStreetMap contributors, routing by OSRM, geocoding by Nominatim"
} }
```

`source` tells the truth about each endpoint: `delivery` (stored on the
order), `user-supplied` (query coordinates — never labeled GPS-verified),
or `geocoded` (plus the provider's `displayName`).

Failure mapping (generic messages only — no provider body, URL, or key
material ever reaches the client):
- No provider configured → 503 `MAPS_NOT_CONFIGURED` (the truthful
  unavailable state; the frontend says so in plain words).
- Unknown provider name → 503 `MAPS_NOT_IMPLEMENTED`.
- Provider HTTP error / bad payload / no route → 502 `MAPS_PROVIDER_ERROR`.
- Provider timeout → 503 `MAPS_TIMEOUT`.
- Place name resolves to nothing → 404 `PLACE_NOT_FOUND`.

## Frontend behavior

- **Unavailable routing is shown, not hidden.** The Delivery tab says
  routing is unavailable while no provider is configured; an order's
  detail page shows the real distance/duration when the endpoint
  succeeds, and a plain-words reason otherwise (not configured /
  no coordinates / provider unavailable). No ETA is ever estimated.
- **Geolocation is permission-first and one-shot.** Tapping "Use my
  location" first shows an explanation (one reading, only for that
  field, stored only if the order is created, never tracked afterwards).
  Only a second tap, "Use my device location", calls
  `getCurrentPosition` — once, with a 10 s timeout. There is no
  `watchPosition`, no background tracking, and no live courier tracking
  anywhere. Denied / unavailable / timeout / insecure-context
  (non-HTTPS, non-localhost) cases each get their own visible message.
- **Manual fallback.** Latitude/longitude inputs sit beside each area
  field, validated client-side and again server-side (same ranges).
  Manual coordinates are stored exactly as typed and labeled
  user-supplied / not GPS-verified; if both manual and GPS values exist,
  manual wins. A GPS reading is cleared after the order is created so a
  later form never silently reuses it.
- **Pin picker (2026-10-26).** The delivery form and the drop-off editor
  include a Leaflet pin picker beside the typed inputs and the one-shot
  GPS button; picking, dragging, typing, and the GPS reading all feed the
  same coordinate fields, labeled by source (one-shot GPS reading vs
  user-supplied).

## Live verification (not a claim — a record)

Two real, read-only OSRM demo requests were made during evaluation
(neither was a scan; the demo's ~1 req/s policy was respected):

1. Direct demo check, 2026-10-25:
   `GET https://router.project-osrm.org/route/v1/driving/13.414167165756226,52.52167215019524;13.4197763,52.5003103?overview=false`
   → HTTP 200, `code: "Ok"`, distance 2949.6 m, duration 380.7 s.
2. Full-stack smoke test (`backend/tests/integration/maps.test.js`,
   opt-in via `NEXORA_MAPS_LIVE_SMOKE=1`, same Berlin coordinates through
   `GET /api/deliveries/:id/route` with `MAPS_PROVIDER=osrm`) → 200 with
   positive distance and duration. It is skipped by default so `npm test`
   never depends on the network.

## Blocker / honest limitation

**No blocker remains for demo-scale routing:** with `MAPS_PROVIDER=osrm`
the endpoint returns real provider routes, verified live as above. The
limitation is scale, not function — the public demo servers are
donated, rate-capped (~1 req/s), and carry no uptime guarantee, so they
are not a production backend. Production use requires either a
self-hosted OSRM/Nominatim instance (base-URL override, no code change)
or a keyed provider behind this interface. Until one of those is in
place, treat demo-backed routing as evaluation/low-traffic only. The
local default configuration still ships with `MAPS_PROVIDER` empty (503
unavailable state); the live Render deployment sets `osrm` via
`render.yaml` (2026-10-26).

## Google Maps adapter contract (NOT implemented — documentation only)

Google Maps is not wired in: no Google adapter code exists and no key is
stored anywhere. When the user supplies a real Google Cloud key (which
requires a billing account), the adapter is implemented behind this same
provider interface with no frontend rewrite:

- Server side: implement `geocode` + `route` against the Google Geocoding
  and Routes/Directions APIs; the server key comes from a server-side env
  var only (never in the frontend, never in logs, never in error
  responses).
- Browser side: the Maps JavaScript API replaces the Leaflet tile layer
  for the rendered map, and Places Autocomplete replaces the
  type-and-search geocoding (Nominatim forbids search-as-you-type, so
  autocomplete is a Google-only feature); the browser key must be
  HTTP-referrer-restricted to the app's origins and documented here
  with its restrictions before it ships.
- The OSM adapter stays as the fallback. Nothing here is a promise of
  Google data: until a real key exists, all maps and routing are the
  free OSM stack above.

## Tests

`backend/tests/integration/maps.test.js` — 13 tests run by default
(provider validation boundaries, stub-transport normalization, 500 →
502 without internals, abort → 503 timeout, 503 unconfigured, 503
unknown provider, stub success shape + attribution, authorization
403/200/401, 400 invalid coordinates + boundary acceptance, 400 missing
coordinates + query fix, 502 leak check, 503 endpoint timeout, geocode
success + 404), plus the 1 opt-in live smoke test above.
