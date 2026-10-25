// Maps provider factory.
//
// Reads process.env on every call (not an import-time snapshot), so the
// route endpoint always reflects the running configuration and tests can
// point the adapter at a stub base URL without restarting the server.
// config.mapsProvider (import-time) is still what /api/health reports; in
// production the variable is set before startup, so the two agree.
//
// Supported values for MAPS_PROVIDER:
//   '' (empty/unset) -> { status: 'unconfigured' }  (route endpoint: 503)
//   'osrm'           -> OSM stack (OSRM routing + Nominatim geocoding)
//   anything else    -> { status: 'unknown' }       (route endpoint: 503)
// There is deliberately no test-double provider here: tests inject a stub
// transport into OsmProvider directly, or point MAPS_*_BASE_URL at a local
// stub HTTP server. A fake route can never ship as production behavior.
import { OsmProvider } from './osrm.js';

export { MapsError, assertCoordinates, assertQuery, OSM_ATTRIBUTION } from './provider.js';
export { OsmProvider } from './osrm.js';

export function resolveMapsProvider() {
  const name = (process.env.MAPS_PROVIDER || '').trim().toLowerCase();
  if (!name) return { status: 'unconfigured', provider: null };
  if (name === 'osrm') return { status: 'ready', provider: new OsmProvider() };
  return { status: 'unknown', provider: null };
}
