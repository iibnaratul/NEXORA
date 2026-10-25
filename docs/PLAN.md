# NEXORA — Implementation plan

## 1. What the original was (inspected 2026-10-25)

Source: `docs/original-NEXORA.html` (23 KB, single file, preserved verbatim for audit).

- **UI, preserved**: 4 tabs (Chats / Delivery / Activity / Profile), dark futuristic theme
  (lime `#c6ff3d` / cyan accents), responsive bottom nav on mobile and side nav on
  desktop, auto/dark/light theme, skeleton loaders, toasts, offline banner.
- **Identity**: client-generated `NXR-XXXXX` guest ID in `localStorage` (`nx_me`),
  editable display name + avatar glyph, also local-only.
- **Chat**: public rooms only, via the proprietary `window.claude` database
  (`rooms`, `rooms/{id}/msgs`). Reply, delete-own, device-local block list, unread
  markers from local read timestamps. No private 1:1 chat, no groups, no server auth.
  When the Claude runtime is absent, `db = null` and the UI honestly shows
  "Shared storage isn't available in this view… nothing is saved or simulated."
- **NEXORA TRANSIT**: orders with 7 states
  (`CREATED, ACCEPTED, ARRIVING AT PICKUP, PICKED UP, IN TRANSIT, ARRIVING AT
  DESTINATION, DELIVERED`) + cancelled/disputed. Courier claim used a client-side
  lock (`acquire({ttlMs:5000})`). Handover codes were 6-digit random numbers,
  SHA-256-hashed client-side, with **plaintext stored in a per-user document**.
  Fee is informational ("not charged"). No payments, maps, GPS, camera, QR, uploads,
  push, E2EE, or server-side authorization — the profile page says so explicitly.
- **Security gaps in the original** (all fixed or documented in this rebuild):
  client-generated IDs used as identity; plaintext codes in a user document; no
  server authorization (any holder of the DB handle could read/write anything);
  device-local-only blocking; no input validation beyond `maxlength`; no rate
  limiting except a 1.5 s client send throttle; messages not E2EE (honestly stated).

## 2. Architecture decision

| Area | Choice | Why / trade-off |
|---|---|---|
| Backend | Node.js 24 + Express, plain JavaScript (ESM) | The brief prefers TypeScript. This environment has no build toolchain guarantee and the priority is a **runnable, tested** system. JS + JSDoc + Zod runtime validation gives the same boundary safety with zero build step. Module boundaries mirror the TS layout, so a TS migration is mechanical. Documented here, not hidden. |
| Database | PostgreSQL, `pg`, hand-written parameterized SQL | Spec allows parameterized queries *or* an ORM. Raw SQL keeps the authorization logic visible and auditable. Versioned migrations in `database/migrations/`. |
| Auth | Cookie sessions + CSRF double-submit | HttpOnly, `SameSite=Lax`, `Secure` in production. Sessions are server-side rows: opaque token, SHA-256 hash at rest, expiry, revocation. Passwords: bcryptjs. NEXORA IDs are server-issued, `NXR-` + 8 crypto-random chars, unique. |
| Realtime | Socket.IO | Auth via session cookie; one room per conversation; membership enforced on join **and** on every message event; per-socket rate limits. |
| File storage | Local private directory (dev) behind signed URLs | Files are never publicly addressable. Download = authorized endpoint issuing a short-lived HMAC-signed URL. An S3-compatible provider interface is documented; it is **not wired** (no credentials exist) and the health endpoint reports that honestly. |
| Maps / geocoding | Provider interface, none configured | Route/distance endpoint returns `503 MAPS_NOT_CONFIGURED`. The frontend keeps manual coarse areas and the original's honest "no map provider configured" notice. No fabricated routes, positions, or ETAs — ever. |
| Payments, push, live tracking, E2EE | Not implemented | Same honest stance as the original. Transport is TLS in production (reverse proxy); messages are **not** end-to-end encrypted and the UI says so. |

## 3. Feature map (original → backend)

| Original feature | Backend implementation |
|---|---|
| Guest identity (`nx_me`, client-generated) | `POST /api/auth/anonymous` → server-issued NEXORA ID + session; `PATCH /api/users/me` for display name/avatar (validated) |
| Public rooms | `conversations` with `type='room'` (listable, joinable) |
| (new) Private messaging | `type='dm'`, exactly 2 members, membership enforced on every read/write |
| (new) Private groups | `type='group'`, invite-only, owner/admin/member roles, invitation expiry |
| Reply / delete / block | `messages.reply_to_id`, delete (author or group admin/mod), `blocked_users` enforced server-side on reads |
| Activity / unread | `conversation_members.last_read_at` + `GET /api/conversations/unread-count` |
| Transit orders + 7 states | `deliveries` with the spec state machine (below), server-validated transitions, `delivery_status_history` |
| Courier claim | Atomic `UPDATE … WHERE status='SEARCHING_FOR_COURIER' AND courier_id IS NULL` — exactly one winner |
| Handover codes | `verification_challenges`: server-generated 6-digit codes, AES-256-GCM encrypted at rest, expiry, max attempts, single use, rate-limited; QR encodes only the order public reference, never the code; QR alone never authorizes completion |
| Parcel photo | `POST /api/deliveries/:id/photo` via multer, size/type limits, magic-byte signature check, private storage, preview-before-submit in UI |
| Fee | Informational only; no payment integration (honest) |
| Theme | Stays client-side (harmless preference) |
| "Not included" list | Maps/GPS/camera-evidence/QR/push/E2EE: camera + QR now implemented; maps, push, E2EE remain not implemented and are labelled as such |

## 4. Delivery state machine (server-enforced)

```
CREATED → SEARCHING_FOR_COURIER → ASSIGNED → ACCEPTED → PICKUP_VERIFIED
  → IN_TRANSIT → DROPOFF_VERIFIED → DELIVERED
```

Plus `CANCELLED` (from CREATED/SEARCHING_FOR_COURIER/ASSIGNED/ACCEPTED, sender
or admin only) and a `disputed` flag (any participant, any non-terminal state).
Every transition is validated server-side, recorded in `delivery_status_history`,
and rejected if the current state does not allow it — even for a modified client.

## 5. Authorization model (every endpoint, every socket event)

- All reads/writes require a valid session except `POST /api/auth/*` and `GET /api/health`.
- A user can only touch conversations/deliveries/files they participate in
  (membership/participant check in SQL, not in client code) — this is the IDOR defence.
- Roles: `user`, `courier`, `admin`. Courier-only endpoints check
  `courier_profiles` + availability; admin endpoints check `role='admin'`.
- Group owner/admin/member permissions enforced per operation; removed members
  immediately lose access to new messages and files.
- Blocks are enforced on DM creation and message reads.
- Rate limits: auth (10/min), messages (30/min), uploads, verification attempts
  (5/min per challenge), delivery creation (20/hour).

## 6. What is intentionally NOT claimed

- No end-to-end encryption. No live courier tracking. No payments. No push
  notifications. No S3/maps provider wired (no credentials). No "fully secure"
  claim — see `docs/SECURITY.md` for residual risks.
- Test evidence is reported exactly as executed in `docs/VERIFICATION_REPORT.md`.
  Anything not run is marked "Not tested", never "passed".
