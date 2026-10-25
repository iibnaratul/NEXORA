# NEXORA security documentation

## Implemented controls

- **Parameterized queries everywhere** — no string-interpolated SQL. Verified by
  the SQL-injection test (quoted payloads stored literally, tables intact).
- **Output encoding** — the frontend escapes all rendered text (`esc()`); the
  server stores raw input and never renders HTML. Verified by the XSS test.
- **Authentication** — bcrypt passwords (configurable rounds), server-side
  sessions, SHA-256 token hashes at rest, expiry, revocation on logout and on
  account deletion. Login/register/anonymous are rate-limited (10/min/IP-or-user).
- **CSRF** — double-submit tokens on every mutation, including pre-auth flows.
- **Authorization (IDOR defence)** — membership/participant checks inside SQL on
  every conversation, message, file, and delivery access, plus socket-event
  checks. Cross-user access tests cover reads, writes, joins, and downloads.
- **Roles** — `user` / `courier` / `admin`, checked server-side; admins cannot
  change their own role; courier endpoints require a courier profile.
- **Delivery integrity** — server-side state machine (unit-tested), atomic
  courier claim, one-time expiring attempt-limited handover codes (AES-256-GCM
  at rest, never logged), QR carries only the order reference.
- **Files** — magic-byte verification (not MIME/filename), size limits, opaque
  storage keys (no path traversal by construction), signed short-lived download
  URLs with authorization re-checked on download.
- **Rate limits** — auth, messages, uploads, deliveries, global API.
- **Headers** — Helmet with a strict CSP (self-only scripts/styles, no objects).
- **Audit logging** — auth, membership, delivery transitions, disputes, admin
  actions. Audit details strip passwords/tokens/codes/bodies as a backstop.
- **Secrets** — environment only; `.env.example` holds placeholders; no secrets
  in frontend code or the repository.
- **No sensitive logging** — passwords, tokens, codes, message bodies, and
  precise locations are never written to logs.

## Residual risks (stated, not hidden)

1. **No end-to-end encryption.** The server can read messages. Users who need
   E2EE must not use NEXORA chat for sensitive content until a reviewed E2EE
   protocol is implemented.
2. **Session token in a cookie + CSRF token pattern** is sound for same-origin
   use, but cross-origin deployments must set `CORS_ORIGINS` explicitly and run
   behind HTTPS with `Secure` cookies (automatic when `NODE_ENV=production`).
3. **Handover codes are 6 digits** — short by design (human-readable). Risk is
   bounded by 5 attempts, 24 h expiry, single use, stage binding, and courier
   authentication, but a shoulder-surfed code is usable until it expires or is
   used. Treat codes as secrets when sharing them.
4. **Local file storage** is only as private as the host's filesystem
   permissions (`0600` files, opaque keys). For multi-host deployments, move to
   the documented S3-compatible provider (not yet wired).
5. **No malware scanning** on uploads — the spec's "when available" condition is
   not met here. Magic-byte + type/size checks are the current controls.
6. **No WAF / intrusion detection / backup automation** is included. Operators
   must add database backups (`pg_dump` on a schedule) and TLS termination
   (reverse proxy) before production use.
7. **Anonymous accounts are pseudonymous, not untraceable.** The server links
   activity to accounts for moderation; a hosting provider could do the same.
   The UI states this.
8. **Rate limits are in-memory** (per process). Multi-process deployments need a
   shared store (e.g. Redis) for limits to hold across instances.
9. **Seed credentials are public and weak by design** — `npm run seed` refuses
   production, but any dev database must be wiped before promotion.

## Production checklist

- [ ] Real `CODE_ENCRYPTION_KEY` (64 hex chars) and `DATABASE_URL` from a secret
      manager; never commit `.env`.
- [ ] TLS reverse proxy (e.g. Caddy/nginx), `NODE_ENV=production`,
      `TRUST_PROXY=true` only behind that proxy.
- [ ] `npm run migrate` before first boot; `pg_dump` backups scheduled.
- [ ] `CORS_ORIGINS` set to the exact frontend origin(s).
- [ ] Seed data removed; admin password rotated; demo accounts deleted.
- [ ] Log shipping (stdout) without sensitive fields — the app already avoids
      logging them.
- [ ] Decide on maps/S3/mail providers, or keep their endpoints returning
      honest 503s.

## Verification history — Phase 4 security program + consolidation (2026-10-25)

All findings below were reproduced by a failing test first, then fixed, then
re-verified. Suites: `backend/tests/integration/security2-*.test.js`
(49/49 on real PostgreSQL 16 via `bash scripts/test-security.sh`),
`backend/tests/integration/verificationCodes.test.js` (14/14 on real PG),
plus the Playwright browser suite (`npm run test:e2e`, 25 tests).

### Fixed in Phase 4 (each with a regression test)

- **V1 — Session fixation on account claim (Medium).** Claiming an anonymous
  account kept the pre-claim session token, so whoever planted it owned the
  claimed account. Fix: claim revokes the old session row and issues a fresh
  session; the response returns the new `csrfToken` and callers must adopt it.
- **V2 — Message edit/delete after group removal (Medium).** Handlers checked
  authorship but not membership. Fix: both handlers now require conversation
  access (send-level) before the authorship check.
- **V3 — Stale socket still received broadcasts after removal (Medium).**
  Socket sends were membership-checked; broadcast receipt was not. Fix:
  member removal and self-leave now kick the socket from the room
  (`kickFromConversation()`).
- **V4 — Live socket survived logout (Medium).** Fix (two layers): logout and
  account deletion disconnect all of the user's sockets, and every privileged
  socket event now revalidates the session against the database.
- **V5 — Malformed UUID → 500 leaking a Postgres error code (Low/Medium).**
  Fix: `assertUuid()` in the authz lookups (malformed IDs → 404) plus a
  central error handler that forces `INTERNAL_ERROR` for all 500s.
- **V6 — Bio-only profile update → 500 (Low).** The users UPDATE ran with an
  empty SET list. Fix: skip the users UPDATE when no user-table fields are
  present (the profile update still runs).
- **V7 — NUL/control bytes in filenames (Low, partially fixed).** Raw NULs in
  multipart headers are rejected by busboy (generic 500, no file, no leak);
  filenames reaching app code are now stripped of NUL/control bytes on
  upload and on the download `Content-Disposition`. Residual cosmetic issue:
  malformed-multipart rejections surface as 500 instead of 400 (not a leak
  or a bypass).

### Fixed in consolidation (each with a regression test)

- **B1 — Verification-code attempts never persisted, lockout unreachable
  (Medium).** On a wrong code, the handler incremented `attempts` inside the
  verify transaction and then threw — `withTransaction` rolled the increment
  back, so `attempts` stayed 0 forever and `CODE_LOCKED` could never engage
  (a 6-digit code was then bounded only by the 60/hour delivery limiter).
  Fix: the verify transaction returns a `{ wrong: true }` sentinel instead
  of throwing, and the caller commits the increment in a separate UPDATE
  (guarded by `used_at IS NULL`). The characterization test that documented
  the bug was deleted per its own instruction once tests 2/6a passed.
  Secondary drift fixed in the same change: `CODE_MAX_ATTEMPTS` was never
  passed to challenge creation (the DB default of 5 always applied); it is
  now inserted from config (clamped to ≥ 1).
- **CSRF token adoption (Severe, UI-total).** Two cooperating defects meant
  every authenticated UI mutation failed with 403 `CSRF_INVALID`: (a) the
  frontend kept one module-level token set only by `initCsrf()` and never
  adopted the fresh `csrfToken` returned by anonymous/register/login/claim
  responses; (b) `GET /api/auth/csrf` minted a fresh random token on every
  call, so even a page reload broke mutations (the boot token never matched
  the session's stored token). Fix: `api.js` adopts `data.csrfToken` from
  any response, and `/api/auth/csrf` returns the session's stored token
  when called authenticated (fresh pre-auth token only when unauthenticated).
  `openConv()`'s read-mark is now best-effort so a failed mark can never
  again block message rendering or the socket join.
- **CORS reflect-all default (Low/Medium).** With `CORS_ORIGINS` unset, the
  server reflected any request Origin with credentials (HTTP) and sent
  permissive socket CORS headers. Fix: default is now same-origin only
  (`origin: false` when unset) for both Express and Socket.IO; cross-origin
  deployments must set `CORS_ORIGINS` explicitly. Empirically verified that
  the socket option governs response headers, not the handshake gate — the
  session cookie (SameSite=Lax) plus per-event session revalidation remains
  the actual socket authentication control.
- **CSP blocked the app's own styling (cosmetic, UI-total).** Helmet's
  `style-src 'self'` blocked the inline `<style>` block and all inline
  `style=`/`onerror` attributes, so the UI rendered completely unstyled.
  Fix (appearance unchanged, CSS verbatim): the block moved to
  `frontend/src/styles.css` (same-origin), inline styles became classes,
  the dynamic avatar border color travels as `data-hue` and is applied via
  CSSOM after render, and the QR `onerror` became a capture-phase delegated
  listener. Playwright now asserts zero CSP reports and theme computed
  styles on ordinary pages.

### Verified secure by exercise (not assumed)

Anonymous-ID claim (server-issued IDs, supplied fields ignored, conflicting
claims → 409, concurrent claims safe); account deletion (sessions revoked
HTTP + socket, login fails, second delete safe, audit row survives, no
ownership transfer); session revocation (per-session logout leaves other
sessions working, DB-crafted expiry rejected, login rotates, no collateral
invalidation); IDOR sweep (outsider 403 on DM/group read/send/read-mark/
leave/edit/delete/member add/remove/join/delivery read/codes/QR/history;
socket join/send without membership denied); private files (unauthenticated
download 401, outsider replay 403, tampered/changed-expiry/past-expiry
signatures 403, magic bytes beat filename/MIME, traversal names → opaque
keys, no static serving of private files); SQLi (neutralized), stored/
reflected XSS (JSON-only server, frontend `esc()`), CSRF (missing/wrong
token rejected), privilege escalation (role smuggling, admin endpoints,
courier gating all denied), rate limits (X-Forwarded-For rotation does not
bypass with `TRUST_PROXY=false`; burst → 429).

### Known limitations of the security verification

- `npm audit` could not run in this sandbox (registry policy 403 on the
  audit endpoint) — no severity counts are available and no dependency
  upgrades were made on that basis. Installed versions observed: express
  4.22.3, helmet 8.3.0, socket.io 4.8.4, pg 8.23.1, zod 3.25.76, multer 2.5.0,
  bcryptjs 2.4.3.
- `Secure` cookie behavior in production mode is code-reviewed, not
  browser-tested (browser suite runs in development mode).
- A forged-valid signature for a past expiry cannot be tested without the
  server key (by design unforgeable); expiry itself is tested with
  deadbeef/past-expiry inputs.
- Signed URLs are replayable by the same authorized user within their
  15-minute window by design (not single-use); cross-user replay fails.
- Oversize uploads and malformed-multipart rejections surface as generic
  500s rather than 413/400 (cosmetic, no leak, no file stored).
- A removed member can still download their own uploads (owner check) —
  intended, not a leak; they lose other members' files.

## Account deletion semantics

Soft delete: sessions revoked, email/password cleared, profile blanked, but
messages and delivery records keep their NEXORA ID attribution (other
participants rely on those records). A full purge of a user's content is an
operator action: delete the user's rows from `messages` (or anonymize
`sender_id`), `delivery_participants`, and `private_file_metadata` + stored
files, then the `users` row — in that order, respecting foreign keys.
