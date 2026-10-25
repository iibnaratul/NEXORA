# NEXORA API reference

Base: same origin as the frontend. All responses use the envelope
`{ ok: true, data, meta? }` or `{ ok: false, error: { code, message } }`.
Authentication: HttpOnly session cookie + `X-CSRF-Token` header on every
mutation (fetch the token from `GET /api/auth/csrf` first; when called with
a valid session cookie it returns that session's stored token, and only
mints a fresh pre-auth token for unauthenticated callers. Auth responses
also return the fresh session `csrfToken` — clients must adopt it, since
claim/login/register rotate the session).

## Health

- `GET /api/health` — public. Reports database/storage/maps/payments/push/E2EE
  status honestly; never claims an unconfigured provider exists.

## Auth — `/api/auth`

- `POST /anonymous` `{ displayName?, avatarGlyph? }` — server-issued NEXORA ID.
- `POST /register` `{ email, password (min 10), displayName?, avatarGlyph? }`
- `POST /login` `{ email, password }` — unknown email and wrong password give
  the identical 401 (no account enumeration).
- `POST /claim` (auth) `{ email, password }` — anonymous → password account,
  keeps the NEXORA ID.
- `POST /logout` (auth) — revokes this session.
- `GET /me` (auth) — current user.
- `POST /forgot` — `503 NOT_CONFIGURED` (no mail provider).
- `DELETE /me` (auth) — soft-delete + revoke all sessions + clear profile.

## Users — `/api/users` (auth)

- `GET /by-nexora/:nexoraId` — public profile (pseudonymous fields only).
- `PATCH /me` `{ displayName?, avatarGlyph?, bio? }`
- `GET /me/blocks`, `POST /me/blocks` `{ nexoraId }`, `DELETE /me/blocks/:nexoraId`
- `POST /reports` `{ targetType: message|user|delivery, targetId, reason }`

## Conversations — `/api/conversations` (auth)

- `GET /` — my memberships + public rooms, with `unread` counts and DM partner
  names. Pagination: `?page=&limit=` (max 100).
- `GET /unread-count`
- `POST /` `{ type: dm|group|room, name?, description?, memberNexoraIds? }` —
  DM with an existing partner returns the existing conversation (`reused: true`).
- `GET /:id` — conversation + members (rooms readable by any authed user).
- `POST /:id/join` — rooms only. `POST /:id/leave` — last owner cannot leave.
- `POST /:id/read` — mark read.
- `GET /:id/messages` — newest first, `?page=&limit=`, `?before=ISO`.
- `POST /:id/messages` `{ body (1–2000), replyToId?, clientId?, attachmentIds? }` —
  `clientId` makes sends idempotent (retry returns the original).
- `POST /:id/members` (group owner/admin) `{ nexoraId }`
- `DELETE /:id/members/:userId` (owner/admin or self; last owner protected)

## Messages — `/api/messages` (auth)

- `PATCH /:id` `{ body }` — author only.
- `DELETE /:id` — author, or group/room owner/admin. Soft delete.

## Files — `/api/files` (auth, except download which uses the signed URL + session)

- `POST /conversations/:id/upload` (multipart `file`) — member only.
- `POST /deliveries/:id/photo` (multipart `file`) — sender only, images only.
- `GET /:id/url` — re-issue a signed download URL (authorization checked).
- `GET /:id/download?exp=&sig=` — signature + expiry + scope authorization,
  then stream. No permanent public URLs exist.

## Deliveries — `/api/deliveries` (auth)

- `POST /` — create; `publish` (default true) moves it straight to
  `SEARCHING_FOR_COURIER`.
- `GET /?view=mine|queue&status=&page=&limit=` — queue requires a courier profile.
- `GET /:id`, `GET /:id/history` (sequence-ordered status history).
- `POST /:id/claim` — atomic; exactly one courier wins (loser gets 409).
- `POST /:id/step` `{ to }` — server-validated transition (codes cannot be
  passed here; use `/verify`).
- `POST /:id/verify` `{ stage: pickup|dropoff, code: 6 digits }` — courier only,
  attempt-counted, expiring, single-use; success advances the state machine.
- `GET /:id/codes` — sender only; decrypted codes + expiry + attempts left.
- `GET /:id/qr` — PNG of the public order reference only.
- `POST /:id/cancel` — sender/admin, pre-pickup states only.
- `POST /:id/dispute` `{ reason }` — any participant, non-terminal states.
- `POST /:id/dispute/resolve` — admin only.
- `GET /:id/route` — `503 MAPS_NOT_CONFIGURED` unless a provider is set
  (`MAPS_PROVIDER=osrm` enables OSRM routing + Nominatim geocoding; see
  `docs/MAPS.md`). Query params: `pickupLat/pickupLng/dropoffLat/dropoffLng`
  (explicit coordinates win) or `place` (geocoded server-side); otherwise
  the delivery's stored coordinates are used. Response carries distance/
  duration plus attribution; errors are 400 (bad coordinates), 404 (unknown
  place), 502 (provider error, generic), 503 (timeout/unconfigured/unknown
  provider). Coordinates are validated server-side (lat −90..90, lng
  −180..180); query coordinates are labeled `user-supplied`, never GPS.

## Couriers — `/api/couriers` (auth)

- `POST /register`, `GET /me`, `PATCH /me/availability` `{ available, vehicle? }`

## Admin — `/api/admin` (admin role only)

- `GET /reports`, `PATCH /reports/:id` `{ status: open|reviewed|dismissed }`
- `POST /users/:id/role` `{ role: user|courier|admin }` — cannot change own role.
- `GET /audit` — paginated audit log.

## Realtime (Socket.IO, same origin)

Handshake requires the session cookie. Events:

- `conversation:join` / `conversation:leave` — membership-checked.
- `message:send` `{ conversationId, body, replyToId?, clientId? }` — acked;
  membership-checked; broadcast as `message:new` to the conversation room.
- `delivery:subscribe` — participant/queue-viewer checked; server emits
  `delivery:update` `{ deliveryId, status }` to the sender's user room.
