// OSM-stack adapter: OSRM for routing + Nominatim for geocoding.
//
// Why this pair: both are public, no-key services run on donated OSM
// infrastructure, so NEXORA can return real routes without any credential.
// That is also their limit — see docs/MAPS.md: the public demo servers are
// evaluation / low-traffic only (OSRM demo: reasonable non-commercial use,
// do not exceed ~1 req/s, no uptime guarantee; Nominatim: absolute max
// 1 req/s per application, identifying User-Agent required, no bulk use,
// no search-as-you-type). Production traffic must move to a self-hosted
// OSRM/Nominatim instance (same API, different base URL) or a keyed
// provider behind this same interface.
//
// Server-side only. No key exists for this stack, so none is read, sent,
// logged, or included in any error. The Nominatim User-Agent identifies
// the application, as its usage policy requires; it is not a secret.
//
// Timeouts: every outbound call is bounded by AbortSignal.timeout()
// (default 5000 ms, MAPS_TIMEOUT_MS). A timeout surfaces as MapsError
// TIMEOUT, never as a hung request.
import { MapsError, assertCoordinates, assertQuery, OSM_ATTRIBUTION } from './provider.js';

export const DEFAULT_ROUTE_BASE_URL = 'https://router.project-osrm.org';
export const DEFAULT_GEOCODE_BASE_URL = 'https://nominatim.openstreetmap.org';
export const DEFAULT_TIMEOUT_MS = 5000;
export const USER_AGENT = 'NEXORA/1.0 (maps; https://github.com/iir20/Nexora-beta-0.1)';

export function mapsTimeoutMs() {
  const v = Number(process.env.MAPS_TIMEOUT_MS);
  if (Number.isFinite(v) && v >= 100 && v <= 30_000) return v;
  return DEFAULT_TIMEOUT_MS;
}

function isAbort(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

// fetchImpl is injectable so unit tests can substitute a stub transport
// without touching production code or the network.
export class OsmProvider {
  constructor({
    fetchImpl = globalThis.fetch,
    routeBaseUrl = process.env.MAPS_ROUTE_BASE_URL || DEFAULT_ROUTE_BASE_URL,
    geocodeBaseUrl = process.env.MAPS_GEOCODE_BASE_URL || DEFAULT_GEOCODE_BASE_URL,
    timeoutMs = mapsTimeoutMs(),
    profile = process.env.MAPS_PROFILE || 'driving',
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.routeBaseUrl = String(routeBaseUrl).replace(/\/$/, '');
    this.geocodeBaseUrl = String(geocodeBaseUrl).replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.profile = profile;
  }

  async geocode(query) {
    const q = assertQuery(query);
    let res;
    try {
      const url = `${this.geocodeBaseUrl}/search?${new URLSearchParams({ format: 'json', limit: '1', q })}`;
      res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      if (isAbort(err)) throw new MapsError('TIMEOUT', 503, 'Geocoding timed out.');
      throw new MapsError('PROVIDER_ERROR', 502, 'Geocoding provider unavailable.');
    }
    if (!res.ok) throw new MapsError('PROVIDER_ERROR', 502, 'Geocoding provider unavailable.');
    let body;
    try { body = await res.json(); } catch {
      throw new MapsError('PROVIDER_ERROR', 502, 'Geocoding provider returned an unreadable response.');
    }
    if (!Array.isArray(body) || !body.length) return null;
    const first = body[0];
    const lat = Number(first.lat), lng = Number(first.lon);
    try {
      assertCoordinates(lat, lng);
    } catch {
      throw new MapsError('PROVIDER_ERROR', 502, 'Geocoding provider returned invalid coordinates.');
    }
    return { lat, lng, displayName: String(first.display_name || q) };
  }

  async route(from, to) {
    const a = assertCoordinates(from?.lat, from?.lng);
    const b = assertCoordinates(to?.lat, to?.lng);
    // OSRM speaks lng,lat on the wire; the translation happens only here.
    const coords = `${a.lng},${a.lat};${b.lng},${b.lat}`;
    let res;
    try {
      const url = `${this.routeBaseUrl}/route/v1/${encodeURIComponent(this.profile)}/${coords}?overview=false`;
      res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      if (isAbort(err)) throw new MapsError('TIMEOUT', 503, 'Routing timed out.');
      throw new MapsError('PROVIDER_ERROR', 502, 'Routing provider unavailable.');
    }
    if (!res.ok) throw new MapsError('PROVIDER_ERROR', 502, 'Routing provider unavailable.');
    let body;
    try { body = await res.json(); } catch {
      throw new MapsError('PROVIDER_ERROR', 502, 'Routing provider returned an unreadable response.');
    }
    if (body?.code === 'NoRoute' || !body?.routes?.length) {
      throw new MapsError('NO_ROUTE', 502, 'No route could be calculated between these points.');
    }
    if (body.code !== 'Ok') throw new MapsError('PROVIDER_ERROR', 502, 'Routing provider unavailable.');
    const r = body.routes[0];
    const distanceMeters = Number(r.distance);
    const durationSeconds = Number(r.duration);
    if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)
      || distanceMeters < 0 || durationSeconds < 0) {
      throw new MapsError('PROVIDER_ERROR', 502, 'Routing provider returned invalid route data.');
    }
    // Geometry is intentionally omitted (overview=false): NEXORA renders no
    // map, so it only ever displays distance/duration. Nothing is fabricated
    // to fill the field — it is null, honestly.
    return {
      provider: 'osrm',
      profile: this.profile,
      distanceMeters,
      durationSeconds,
      distanceKm: distanceMeters / 1000,
      durationMinutes: durationSeconds / 60,
      geometry: null,
      attribution: OSM_ATTRIBUTION,
    };
  }
}
