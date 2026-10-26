// API client for the NEXORA backend. Same-origin, cookie sessions, CSRF
// double-submit: the token is fetched once from /api/auth/csrf and sent as
// X-CSRF-Token on every mutation. No tokens or private data are kept in
// browser storage — the session lives in an HttpOnly cookie.
let csrf = null;

export async function initCsrf() {
  const r = await fetch('/api/auth/csrf', { credentials: 'include' });
  const j = await r.json();
  csrf = j.data?.csrfToken || null;
  return csrf;
}

async function req(method, path, body, { form = false } = {}) {
  const headers = {};
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const r = await fetch(path, {
    method, credentials: 'include', headers,
    body: body === undefined ? undefined : (form ? body : JSON.stringify(body)),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. PNG) handled by callers */ }
  // Auth responses (anonymous/register/login/claim) rotate the session and
  // return its fresh CSRF token. Adopt it: the old boot token no longer
  // matches the session, so every authenticated mutation would 403
  // CSRF_INVALID without this (verified bug, 2026-10-25).
  if (json?.data?.csrfToken) csrf = json.data.csrfToken;
  if (!r.ok) {
    const err = new Error(json?.error?.message || `Request failed (${r.status})`);
    err.status = r.status; err.code = json?.error?.code;
    throw err;
  }
  return json;
}

export const api = {
  me: () => req('GET', '/api/auth/me'),
  health: () => req('GET', '/api/health'),
  anonymous: (displayName) => req('POST', '/api/auth/anonymous', { displayName }),
  register: (email, password, displayName) => req('POST', '/api/auth/register', { email, password, displayName }),
  login: (email, password) => req('POST', '/api/auth/login', { email, password }),
  claim: (email, password) => req('POST', '/api/auth/claim', { email, password }),
  logout: () => req('POST', '/api/auth/logout', {}),
  deleteAccount: () => req('DELETE', '/api/auth/me'),
  updateMe: (patch) => req('PATCH', '/api/users/me', patch),
  lookupUser: (nexoraId) => req('GET', `/api/users/by-nexora/${encodeURIComponent(nexoraId)}`),
  blocks: () => req('GET', '/api/users/me/blocks'),
  block: (nexoraId) => req('POST', '/api/users/me/blocks', { nexoraId }),
  unblock: (nexoraId) => req('DELETE', `/api/users/me/blocks/${encodeURIComponent(nexoraId)}`),
  report: (targetType, targetId, reason) => req('POST', '/api/users/reports', { targetType, targetId, reason }),

  conversations: () => req('GET', '/api/conversations?limit=100'),
  unreadCount: () => req('GET', '/api/conversations/unread-count'),
  createConversation: (body) => req('POST', '/api/conversations', body),
  conversation: (id) => req('GET', `/api/conversations/${id}`),
  joinRoom: (id) => req('POST', `/api/conversations/${id}/join`, {}),
  leaveConversation: (id) => req('POST', `/api/conversations/${id}/leave`, {}),
  markRead: (id) => req('POST', `/api/conversations/${id}/read`, {}),
  messages: (id, page = 1) => req('GET', `/api/conversations/${id}/messages?limit=80&page=${page}`),
  sendMessage: (id, body) => req('POST', `/api/conversations/${id}/messages`, body),
  editMessage: (id, body) => req('PATCH', `/api/messages/${id}`, { body }),
  deleteMessage: (id) => req('DELETE', `/api/messages/${id}`),
  addMember: (id, nexoraId) => req('POST', `/api/conversations/${id}/members`, { nexoraId }),
  removeMember: (id, userId) => req('DELETE', `/api/conversations/${id}/members/${userId}`),

  // --- Community hub (005) ---
  pins: (id) => req('GET', `/api/conversations/${id}/pins`),
  pinMessage: (id, messageId) => req('POST', `/api/conversations/${id}/pins`, { messageId }),
  unpinMessage: (id, messageId) => req('DELETE', `/api/conversations/${id}/pins/${messageId}`),
  updateGroupRules: (id, rules) => req('PATCH', `/api/conversations/${id}/rules`, { rules }),
  adminLog: (id) => req('GET', `/api/conversations/${id}/admin-log?limit=50`),
  transferOwnership: (id, newOwnerId) => req('POST', `/api/conversations/${id}/transfer`, { newOwnerId, confirm: true }),
  setMemberRole: (id, userId, role) => req('PATCH', `/api/conversations/${id}/members/${userId}/role`, { role }),
  createInvite: (id, body = {}) => req('POST', `/api/conversations/${id}/invites`, body),
  listInvites: (id) => req('GET', `/api/conversations/${id}/invites`),
  inviteQrUrl: (id, code) => `/api/conversations/${id}/invites/${encodeURIComponent(code)}/qr`,
  joinByCode: (code) => req('POST', '/api/conversations/join-by-code', { code }),
  createJoinRequest: (id) => req('POST', `/api/conversations/${id}/join-requests`, {}),
  listJoinRequests: (id) => req('GET', `/api/conversations/${id}/join-requests`),
  decideJoinRequest: (id, reqId, decision) => req('POST', `/api/conversations/${id}/join-requests/${reqId}/${decision}`, {}),

  // --- Transaction flow / trust (005) ---
  messageReplies: (id) => req('GET', `/api/messages/${id}/replies`),
  toggleReaction: (id, emoji) => req('POST', `/api/messages/${id}/reactions`, { emoji }),
  sharePickupLocation: (id, lat, lng) => req('POST', `/api/deliveries/${id}/share-location`, { lat, lng }),
  pickupLocation: (id) => req('GET', `/api/deliveries/${id}/pickup-location`),
  rateDelivery: (id, stars, comment) => req('POST', `/api/deliveries/${id}/ratings`, { stars, comment }),
  deliveryRatings: (id) => req('GET', `/api/deliveries/${id}/ratings`),
  userReputation: (id) => req('GET', `/api/users/${id}/reputation`),

  uploadToConversation: async (id, file) => {
    const fd = new FormData(); fd.append('file', file);
    return req('POST', `/api/files/conversations/${id}/upload`, fd, { form: true });
  },
  fileUrl: (id) => req('GET', `/api/files/${encodeURIComponent(id)}/url`),
  uploadParcelPhoto: async (id, file) => {
    const fd = new FormData(); fd.append('file', file);
    return req('POST', `/api/files/deliveries/${id}/photo`, fd, { form: true });
  },

  deliveries: (view) => req('GET', `/api/deliveries?view=${view}&limit=100`),
  delivery: (id) => req('GET', `/api/deliveries/${id}`),
  deliveryHistory: (id) => req('GET', `/api/deliveries/${id}/history`),
  createDelivery: (body) => req('POST', '/api/deliveries', body),
  claimDelivery: (id) => req('POST', `/api/deliveries/${id}/claim`, {}),
  stepDelivery: (id, to) => req('POST', `/api/deliveries/${id}/step`, { to }),
  verifyDelivery: (id, stage, code) => req('POST', `/api/deliveries/${id}/verify`, { stage, code }),
  deliveryCodes: (id) => req('GET', `/api/deliveries/${id}/codes`),
  cancelDelivery: (id) => req('POST', `/api/deliveries/${id}/cancel`, {}),
  disputeDelivery: (id, reason) => req('POST', `/api/deliveries/${id}/dispute`, { reason }),
  deliveryRoute: (id) => req('GET', `/api/deliveries/${id}/route`),

  // --- Marketplace delivery requests (Phase 1+2 contract) ---
  // All paths live here so a backend path change is a one-line fix.
  // NOTE: the parcel-photo upload is the existing private-file endpoint
  // /api/files/deliveries/:id/photo (see uploadParcelPhoto above), not
  // /api/deliveries/:id/photo — that shorter path does not exist.
  deliveryRequests: (conversationId) => req('GET', `/api/delivery-requests?conversationId=${encodeURIComponent(conversationId)}`),
  deliveryRequest: (id) => req('GET', `/api/delivery-requests/${encodeURIComponent(id)}`),
  createDeliveryRequest: (body) => req('POST', '/api/delivery-requests', body),
  acceptDeliveryRequest: (id) => req('POST', `/api/delivery-requests/${encodeURIComponent(id)}/accept`, {}),
  declineDeliveryRequest: (id) => req('POST', `/api/delivery-requests/${encodeURIComponent(id)}/decline`, {}),
  cancelDeliveryRequest: (id) => req('POST', `/api/delivery-requests/${encodeURIComponent(id)}/cancel`, {}),
  updateDeliveryRequest: (id, patch) => req('PATCH', `/api/delivery-requests/${encodeURIComponent(id)}`, patch),
  updateDeliverySettings: (id, patch) => req('PATCH', `/api/conversations/${encodeURIComponent(id)}/delivery-settings`, patch),

  // --- Marketplace delivery actions (Phase 1+2 contract) ---
  prepareDelivery: (id) => req('POST', `/api/deliveries/${encodeURIComponent(id)}/prepare`, {}),
  updateDropoff: (id, patch) => req('PATCH', `/api/deliveries/${encodeURIComponent(id)}/dropoff`, patch),
  arriveDelivery: (id) => req('POST', `/api/deliveries/${encodeURIComponent(id)}/arrive`, {}),
  handoverDelivery: (id, code) => req('POST', `/api/deliveries/${encodeURIComponent(id)}/handover`, { code }),

  courierRegister: () => req('POST', '/api/couriers/register', {}),
  courierMe: () => req('GET', '/api/couriers/me'),
  courierAvailability: (available, vehicle) => req('PATCH', '/api/couriers/me/availability', { available, vehicle }),
};
