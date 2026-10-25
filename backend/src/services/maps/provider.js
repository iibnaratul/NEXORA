// Maps provider interface (Phase 5).
//
// A provider answers two questions, and nothing else:
//   geocode(query)  -> { lat, lng, displayName } | null   (place name -> coordinates)
//   route(from, to) -> { distanceMeters, durationSeconds, geometry }
// Coordinates are ALWAYS { lat, lng } in WGS-84 degrees inside NEXORA.
// Providers that speak lng,lat on the wire (OSRM does) translate at the
// adapter boundary, so no caller ever has to remember the order.
//
// Error contract: adapters throw MapsError, never a raw fetch error, never a
// provider response body. The route handler maps MapsError codes to generic
// HTTP responses, so provider internals (and any future key material) can
// never leak to a client. No adapter logs request URLs, keys, or bodies.
export class MapsError extends Error {
  // code: 'TIMEOUT' | 'PROVIDER_ERROR' | 'NO_ROUTE' | 'NO_RESULT' |
  //       'INVALID_COORDINATES' | 'INVALID_QUERY'
  // status: the HTTP status the handler should use (502/503 for provider
  // failures, 400/404 for caller-side problems).
  constructor(code, status, message) {
    super(message);
    this.name = 'MapsError';
    this.code = code;
    this.status = status;
  }
}

export const COORD_LIMITS = { latMin: -90, latMax: 90, lngMin: -180, lngMax: 180 };

// Validate one coordinate pair. Throws MapsError INVALID_COORDINATES (400)
// on NaN, non-finite, non-numeric, or out-of-range values. Boundaries are
// inclusive: lat -90/90 and lng -180/180 are valid.
export function assertCoordinates(lat, lng) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(lat) || !ok(lng)
    || lat < COORD_LIMITS.latMin || lat > COORD_LIMITS.latMax
    || lng < COORD_LIMITS.lngMin || lng > COORD_LIMITS.lngMax) {
    throw new MapsError(
      'INVALID_COORDINATES', 400,
      'Coordinates must be finite numbers with latitude in -90..90 and longitude in -180..180.',
    );
  }
  return { lat, lng };
}

export function assertQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) {
    throw new MapsError('INVALID_QUERY', 400, 'A place search must be 1..200 characters.');
  }
  return query.trim();
}

// Attribution that must accompany any displayed route/geocode result.
// OSM data is under the ODbL; the frontend renders this string verbatim.
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, routing by OSRM, geocoding by Nominatim';
