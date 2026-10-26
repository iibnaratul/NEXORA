// Reusable Leaflet map helpers — NEXORA Phase 1+2 (free maps).
// Leaflet is vendored locally at /vendor/leaflet/ (no CDN). Tiles are
// OpenStreetMap, with the required attribution. No route polyline is ever
// drawn here: the route API returns geometry null, and inventing a line
// would present a guess as a route. No ETA is shown anywhere.
// Coordinates shown by a picker are labelled by source: a one-shot GPS
// reading, or user-supplied (picked on the map / typed manually).

const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const DHAKA = [23.81, 90.41];

function leafletReady() {
  return typeof window.L !== 'undefined';
}

function mapUnavailable(el, why) {
  if (el) el.innerHTML = `<div class="c mu">${why || 'Map unavailable — the map library failed to load. Coordinates can still be typed manually.'}</div>`;
}

function defaultIcon() {
  return window.L.icon({
    iconUrl: '/vendor/leaflet/images/marker-icon.png',
    iconRetinaUrl: '/vendor/leaflet/images/marker-icon-2x.png',
    shadowUrl: '/vendor/leaflet/images/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
  });
}

function validCoord(lat, lng) {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

function fmt(lat, lng) {
  return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

// Read-only map showing one or more pins. pins: [{lat, lng, label}].
// Returns the map instance (or null). Never draws a route line.
export function mountPinsMap(el, pins) {
  if (!el) return null;
  if (!leafletReady()) { mapUnavailable(el); return null; }
  const good = (pins || []).filter((p) => validCoord(Number(p.lat), Number(p.lng)));
  if (!good.length) { el.innerHTML = '<div class="c mu">No pins to show — this delivery has no coordinates stored.</div>'; return null; }
  const map = window.L.map(el, { scrollWheelZoom: false }).setView([Number(good[0].lat), Number(good[0].lng)], 13);
  window.L.tileLayer(OSM_TILES, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(map);
  const markers = good.map((p) => window.L.marker([Number(p.lat), Number(p.lng)], { icon: defaultIcon() })
    .addTo(map).bindPopup(p.label || fmt(p.lat, p.lng)));
  if (markers.length > 1) {
    const bounds = window.L.latLngBounds(markers.map((m) => m.getLatLng()));
    map.fitBounds(bounds, { padding: [30, 30] });
  } else {
    markers[0].openPopup();
  }
  return map;
}

// Interactive pin picker. onPick({lat, lng, source}) fires on click, drag,
// GPS reading, and (via setFromInputs) manual typing.
// source is 'gps' for the one-shot device reading, otherwise 'user-supplied'.
// The GPS button preserves the existing permission-first pattern exactly:
// first tap shows an explanation; only a second tap calls
// getCurrentPosition once (10s timeout, no watchPosition, no tracking).
export function mountPinPicker(el, { initial = null, onPick = null, gpsLabel = 'location' } = {}) {
  if (!el) return null;
  if (!leafletReady()) { mapUnavailable(el); return null; }
  const start = initial && validCoord(Number(initial.lat), Number(initial.lng))
    ? [Number(initial.lat), Number(initial.lng)] : DHAKA;
  const map = window.L.map(el, { scrollWheelZoom: false }).setView(start, initial ? 15 : 12);
  window.L.tileLayer(OSM_TILES, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(map);
  let marker = null;
  let current = initial && validCoord(Number(initial.lat), Number(initial.lng))
    ? { lat: Number(initial.lat), lng: Number(initial.lng), source: initial.source || 'user-supplied' } : null;

  function place(lat, lng, source) {
    if (!validCoord(lat, lng)) return;
    current = { lat, lng, source };
    if (marker) marker.setLatLng([lat, lng]);
    else {
      marker = window.L.marker([lat, lng], { draggable: true, icon: defaultIcon() }).addTo(map);
      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        current = { lat: ll.lat, lng: ll.lng, source: 'user-supplied' };
        if (onPick) onPick({ ...current });
      });
    }
    if (onPick) onPick({ ...current });
  }
  if (current) place(current.lat, current.lng, current.source);
  map.on('click', (e) => place(e.latlng.lat, e.latlng.lng, 'user-supplied'));

  // Invalidate size after the container becomes visible (it is rendered
  // inside a view that may just have been injected into the DOM).
  setTimeout(() => map.invalidateSize(), 0);

  return {
    map,
    get: () => (current ? { ...current } : null),
    set(lat, lng, source = 'user-supplied') { place(lat, lng, source); map.setView([lat, lng], 15); },
    setFromInputs(lat, lng) {
      if (validCoord(lat, lng)) { place(lat, lng, 'user-supplied'); map.setView([lat, lng], 15); }
    },
    destroy() { try { map.remove(); } catch { /* already removed */ } },
  };
}

// One-shot GPS button block, same permission-first pattern as the existing
// delivery form: explanation first, second tap reads once. onReading(loc)
// receives {lat, lng, source:'gps'}. Returns the container element.
export function mountGpsButton(boxEl, { label, onReading }) {
  if (!boxEl) return null;
  boxEl.innerHTML = `<button class="b g" data-gps-first="1">Use my location for ${label}</button>`;
  const first = boxEl.querySelector('[data-gps-first]');
  first.addEventListener('click', () => {
    boxEl.innerHTML = `<div class="c"><small>Using your device location will read your current position <b>once</b>, only for this ${label} field, and store it only if you then save. It is not tracked afterwards, and it is never shared with anyone except the delivery participants. You can also pick a pin on the map or type coordinates manually instead — no permission needed.</small><br>
      <button class="b" data-gps-ok="1">Use my device location</button> <button class="b g" data-gps-man="1">Pick / enter manually instead</button></div>`;
    boxEl.querySelector('[data-gps-ok]').addEventListener('click', () => {
      const say = (m) => { boxEl.innerHTML = `<div class="c"><small>${m}</small></div>`; };
      if (!window.isSecureContext) return say('Location needs a secure context (HTTPS or localhost) — pick a pin on the map or enter the coordinates manually instead.');
      if (!navigator.geolocation) return say('Geolocation is not available in this browser — pick a pin on the map or enter the coordinates manually instead.');
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const loc = { lat: p.coords.latitude, lng: p.coords.longitude, source: 'gps' };
          boxEl.innerHTML = `<div class="c"><small>Location captured once for ${label}: ${fmt(loc.lat, loc.lng)}. It will be saved only when you save. No tracking continues.</small></div>`;
          if (onReading) onReading(loc);
        },
        (err) => {
          const why = err?.code === 1 ? 'Location permission was denied.'
            : err?.code === 2 ? 'Your position is unavailable right now.'
            : err?.code === 3 ? 'Getting your location timed out.'
            : 'Location could not be read.';
          say(`${why} Pick a pin on the map or enter the coordinates manually instead — they will be stored exactly as picked/typed, not GPS-verified.`);
        },
        { timeout: 10000, enableHighAccuracy: false, maximumAge: 0 },
      );
    });
    boxEl.querySelector('[data-gps-man]').addEventListener('click', () => {
      boxEl.innerHTML = '<small>Pick a pin on the map or enter the coordinates manually below — they will be stored exactly as picked/typed, not GPS-verified.</small>';
    });
  });
  return boxEl;
}

export function directionsUrl(from, to) {
  if (!from || !to || !validCoord(Number(from.lat), Number(from.lng)) || !validCoord(Number(to.lat), Number(to.lng))) return null;
  return `https://www.openstreetmap.org/directions?from=${Number(from.lat)}%2C${Number(from.lng)}&to=${Number(to.lat)}%2C${Number(to.lng)}`;
}

export { fmt, validCoord, OSM_ATTR };
