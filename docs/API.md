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
- `PATCH /:id/delivery-settings` `{ enabled, allowRequests? }` — group owner/admin; DM either participant. `GET /:id` returns `deliverySettings { enabled, allowRequests }`. When disabled, creating a delivery request in that conversation returns 403.

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

## Marketplace delivery requests — `/api/delivery-requests` (auth, 2026-10-26)

Buyer requests a parcel/product from a seller inside a DM or group; the seller reviews, prepares, sets a drop-off photo + exact pin; the buyer travels to the point, pays cash, and receives the parcel. Payment is a RECORD only — no money moves in-app.

- `POST /` `{ conversationId, targetId, title (≤60), description, priceMinor?, note? }` → 201, status `REQUESTED`. DM target must be the other participant; group target must be a member; requester ≠ target; disabled delivery settings → 403.
- `GET /?conversationId=` (required, participants only), `GET /:id` (participants of the linked conversation).
- `POST /:id/accept` (target only) → creates a marketplace delivery in `CREATED` (sender = seller, recipient = buyer, price copied) and marks the request `ACCEPTED`.
- `POST /:id/decline` (target only) → `DECLINED` (terminal).
- `PATCH /:id` (while `REQUESTED`: requester edits title/description/price/note; seller edits price/note).
- `POST /:id/cancel` (requester or seller, before pickup) → request `CANCELLED`, cascading to a pre-pickup delivery.
- Marketplace delivery path (fulfillment `marketplace`, separate from the courier machine): `CREATED → PREPARED → READY_FOR_PICKUP → DELIVERED`, plus `CANCELLED` from any pre-pickup state.
- `POST /api/deliveries/:id/prepare` (seller, `CREATED` → `PREPARED`, sets `prepared_at`).
- `PATCH /api/deliveries/:id/dropoff` `{ dropoffLat, dropoffLng, dropoffArea?, dropoffPhotoFileId?, dropoffCoordSource? }` (seller, `PREPARED`/`READY_FOR_PICKUP`; first set → `READY_FOR_PICKUP` and issues the pickup code to the buyer; coordinates are `user-supplied` unless from the one-shot GPS reading; a coarse area string is never converted to coordinates; the photo is optional for the state change).
- `POST /api/deliveries/:id/arrive` (buyer, `READY_FOR_PICKUP`, sets `arrived_at`).
- `POST /api/deliveries/:id/handover` `{ code }` (seller, `READY_FOR_PICKUP`) — verifies the existing one-time pickup code (single-use, expiring, attempt-limited); success → `DELIVERED` + a cash payment record `{ payer_id (buyer), payee_id (seller), amount_minor, currency: 'BDT', method: 'cash', recorded_at }`.
- `GET /api/deliveries/:id` for marketplace orders returns `fulfillment`, `request_id`, `prepared_at`, `arrived_at`, `dropoff_coord_source`, `dropoff_photo_url` (signed URL) or null, and `payment`/`payment_record`/`cash_payment` (record or null).
- Drop-off photo upload reuses `POST /api/files/deliveries/:id/photo` (private-file pipeline, magic-byte check); its response `data.id` is the `dropoffPhotoFileId`.
- All edits and cancels are recorded in `delivery_audit` (who, when, old/new for price and pin).

## Community hub & trust — `/api/conversations`, `/api/messages`, `/api/deliveries`, `/api/users` (auth, 2026-10-26)

Group roles: Owner / Admin / Moderator / Member, with distinct badges in the UI. Permission matrix: Moderator pins/unpins messages and deletes messages in the group; Admin does all Moderator powers plus add/remove members (never the owner, never a fellow admin), edit rules, approve/decline join requests, view the admin log; Owner does all Admin powers plus transfer ownership and remove admins. Last-owner guard is kept everywhere.

- Pins (group only): `GET/POST /api/conversations/:id/pins`, `DELETE /:id/pins/:messageId` (moderator+; re-pin → 409). Pinned messages surface at the top of the group view.
- Rules: `PATCH /api/conversations/:id/rules` (admin+); shown in the group view/settings.
- Admin log: `GET /api/conversations/:id/admin-log` (admin+) — role changes, member add/remove, pin/unpin, rules edits, ownership transfers, join approve/decline, delivery-settings changes.
- Roles: `PATCH /api/conversations/:id/members/:userId/role` (owner: any member → admin/moderator/member, never own role; admin: member/moderator → moderator/member only, never to admin, never touching owner/fellow admin).
- Ownership transfer: `POST /api/conversations/:id/transfer { newOwnerId, confirm: true }` (owner only; `confirm` must be literally `true`; new owner must be a member; old owner becomes admin; logged; UI asks twice).
- Invites: `POST/GET /api/conversations/:id/invites` (admin+); `GET /:id/invites/:code/qr` (any member; non-members 403) — the QR encodes ONLY the invite code and authorizes nothing on its own; `POST /api/conversations/join-by-code { code }` (expired → 410, exhausted → 403, unknown → 404, never a silent join).
- Join requests: `POST/GET /api/conversations/:id/join-requests`, `POST /:id/join-requests/:requestId/approve|decline` (admin+; approval creates membership; duplicate pending → 409). Groups default to `join_mode: 'approval'`; direct-add by owner/admin and invite-code joins work regardless of mode. DM behavior unchanged; rooms keep existing join behavior.
- Threads/reactions: `GET /api/messages/:id/replies` → `{ parent, replies }` (participants only); `POST /api/messages/:id/reactions { emoji }` (same emoji removes, different replaces; one reaction per user per message; message reads carry a reactions aggregate, `replyCount`, `parentSnippet`). Messages carry `edited_at` (set by the existing PATCH); the UI shows an "edited" tag when set.
- Live delivery status card in chat: for conversations with a linked marketplace delivery, the card shows the real state plus 3 steps — "Seller En Route" (PREPARED or later), "Buyer Arriving" (only when `arrived_at` is set), "QR Scan for Exchange" (only at DELIVERED). A step is never shown as reached unless its underlying real condition holds; no courier position or ETA is ever shown. The card shows the existing order QR for reference (ref only — the handover code remains the verification).
- Time-limited pickup location: `POST /api/deliveries/:id/share-location { lat, lng }` (marketplace participant, only while `READY_FOR_PICKUP`, else 400; one one-shot GPS reading; server sets expiry = now + 30 min; only the latest share is kept) and `GET /api/deliveries/:id/pickup-location` (participants only; expired shares are deleted on read and never returned; null after DELIVERED/CANCELLED). No `watchPosition`, no background tracking, no history endpoint.
- Ratings & reputation: `POST /api/deliveries/:id/ratings { stars 1–5, comment? }` (DELIVERED only, one per rater → 409 on repeat; buyer↔seller on marketplace orders), `GET /api/deliveries/:id/ratings`, `GET /api/users/:id/reputation`. Reputation is computed live by SQL aggregate on read — `{ avgStars (null when no ratings — never 0-as-a-score, never a default), ratingsCount, completedDeliveries }` — with no stored score column. Handoff views show the other party's reputation ("No ratings yet" when null).
- Completion experience: marketplace `DELIVERED` renders as "Item Exchanged" (display label only; the state machine is untouched). System messages (`is_system`, never editable/deletable, reactions/replies rejected) are posted into the linked conversation on arrival ("Buyer has arrived at the drop-off point") and on handover ("Item exchanged"). Drop-off/pickup views carry well-lit-public-place guidance copy (text only — locations are never enforced, verified, or scored).
- Explicitly NOT built: end-to-end encryption, auto-deleting messages, "discreet mode".

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
