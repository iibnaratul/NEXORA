# NEXORA — Verification report

Date: 2026-10-25. Environment: Node.js v24.22.1, npm 10.9.4, PostgreSQL 16
(installed via apt during this session; no Docker daemon was available, so the
provided `docker-compose.yml` was **not** executed). All commands below were run
from `~/workspace/nexora`.

## Commands executed and actual results

| Command | Result |
|---|---|
| `npm install` | 183 packages installed. Multer 1.x deprecation warning noted → upgraded to multer 2.x before testing. |
| `node --test "backend/tests/unit/*.test.js"` | 14 pass, 0 fail (state machine, codes, IDs, magic bytes, validation). |
| `node --test "backend/tests/integration/*.test.js" "backend/tests/unit/*.test.js" "e2e/*.test.js"` (pg-mem path) | 46 pass, 0 fail. pg-mem needed two shims, both test-only: `gen_random_uuid` + `char_length` registered in `backend/tests/helpers.js`. The migration SQL itself is unmodified real PostgreSQL. |
| `bash scripts/test-real-pg.sh` | **ALL GREEN** — every test file against real PostgreSQL 16, fresh database per file, migrations `001_init`, `002_message_client_id`, `003_history_seq` applied each time. |
| `DATABASE_URL=… npm run migrate` (fresh `nexora_dev` DB) | `001_init.sql applied`, `002_message_client_id.sql applied`, `003_history_seq.sql applied`, `done`. |
| Live server smoke test (`PORT=3100`, real DB) | `GET /api/health` → 200, `database: up`, `maps.configured: false`, `payments.configured: false`, `e2ee.enabled: false`. `GET /` → 200 (original CSS intact), `/src/app.js` → 200, `/socket.io/socket.io.js` → 200. Anonymous registration → server-issued `NXR-UCBYFTRX`. |
| Bugs found and fixed during testing | (1) `conflict` not imported in deliveries route (500 on second claim). (2) Account-deletion violated `users_password_or_anonymous` CHECK (fixed: deletion sets `is_anonymous=TRUE`). (3) History `ORDER BY created_at` ties on real PG (fixed: migration 003 sequence + `ORDER BY seq`). (4) pg-mem lacks correlated-subquery support (rewrote list/unread/DM queries to joins + JS merges — same semantics on real PG). (5) Static frontend path was one level too high (fixed `config.root`). (6) Rate-limit budget shared across tests in one file (auth tests raise the cap for themselves; the limiter itself is tested separately with defaults). |

## Feature verification table

| Feature | Implementation status | Test status | Evidence or limitation |
|---|---|---|---|
| Backend API | Implemented | Tested (real PG) | Express routes for auth, users, conversations, messages, files, deliveries, couriers, admin, health; 46 tests green on real PG 16. |
| Persistent database | Implemented | Tested (real PG) | Migrations 001–003 apply cleanly; E2E "reload" test re-reads delivery + messages from the DB after reconnect. |
| Authentication | Implemented | Tested (real PG) | Anonymous server-issued IDs, register/login, claim, logout revocation, deletion; no account-enumeration (identical 401s); CSRF enforced (missing token → 403). |
| Server-side authorization | Implemented | Tested (real PG) | IDOR sweep (DM/conversation/message/read/leave all 403 for non-members), file download scope checks, admin-only endpoints 403 for users, last-owner protection. |
| Private real-time chat | Implemented | Tested (real PG) | HTTP + Socket.IO; E2E test proves Bob receives Alice's message over the socket; unauthenticated socket rejected; membership checked on join and send. |
| Private groups | Implemented | Tested (real PG) | Group create/add/remove; member cannot add; removed member immediately loses read + send. |
| Media sharing | Implemented (local provider) | Tested (real PG) | PNG upload + attach + signed download; fake PNG rejected by magic bytes; non-member download 403; expired URL 403; parcel photo sender-only + images-only. S3 provider: **not implemented** (no credentials). |
| GPS and maps | Partial (storage + honest 503) | Tested (real PG) | Coordinates accepted/stored/validated; route endpoint returns `503 MAPS_NOT_CONFIGURED`. No provider configured; no route/ETA is fabricated. Frontend has GPS-on-tap + manual areas. |
| QR and delivery verification | Implemented | Tested (real PG) | QR PNG of order reference only; wrong code → 400 + attempt consumed; correct code → state advance; replay → 400; sender-only code view. Code expiry test: **not run** (would need clock control; expiry logic shares the code path tested for used/locked). |
| Courier assignment | Implemented | Tested (real PG) | Atomic claim (second courier → 409); sender cannot claim own order; non-courier cannot claim. Concurrency is by SQL atomicity, not a parallel-load test — a true concurrent-race test was **not run**. |
| Security controls | Implemented | Tested (real PG) | SQLi stored literally (tables intact), XSS stored raw + frontend-escaped, CSRF, rate limits (login 10/min, messages 30/min — both observed 429), Helmet CSP, audit logging. |
| End-to-end workflows | Implemented | Tested (real PG) | E2E test: register → DM over socket → delivery lifecycle → reload persists. |
| Frontend integration | Implemented | Smoke-tested (server) | Serves 200 with original CSS; API wiring written for all tabs. **Not tested in a real browser** — no browser automation run was performed against the new frontend; socket.io client file serves 200. |
| Deployment (Docker) | Implemented (files only) | **Not tested** | `docker-compose.yml` + `Dockerfile` provided; Docker daemon unavailable in this environment, so the compose stack was never booted. |
| TypeScript | **Not implemented (deviation)** | N/A | Plain JavaScript (ESM) + Zod was chosen for zero-build runnability; documented in `docs/PLAN.md` and README. Module layout mirrors the TS structure. |
| Payments / push / E2EE / email recovery | **Not implemented** | N/A (honest 503s) | Endpoints and health report state this; nothing is faked. See README "What is NOT implemented". |

## Production-readiness program — 2026-10-25 (evening, 9 phases)

Six parallel workstreams (browser E2E, Docker/deployment, security,
maps/GPS, courier race, verification codes) plus a consolidation pass that
fixed every confirmed bug below and re-ran all suites sequentially.
Environment: Node.js v24.22.1, npm 10.9.4, PostgreSQL 16.15, Chromium
156.0.8078.4 (Playwright 1.64.1, headless shell), nginx 1.24.0 for the TLS
test. All commands run from `~/workspace/nexora`. Nothing was pushed to
GitHub in this program (workspace delivery only, per the task constraints).
`docs/original-NEXORA.html` is untouched.

### Status table (required format)

| Area | Status | Actual evidence | Remaining limitation |
|---|---|---|---|
| Browser E2E | Pass | `npm run test:e2e`: 25 passed, 0 failed, Chromium, real PostgreSQL (`nexora_browser`), desktop 1280×720 + mobile 390×844 | Headless shell only; no multi-browser run (Firefox/WebKit not installed); no physical-device GPS test |
| Four-tab navigation | Pass | Navigation spec: all 4 tabs visible + switchable (desktop + mobile), refresh + direct navigation, no JS exceptions, no failed requests | — |
| Login and session lifecycle | Pass | Auth spec (7 tests): anonymous NXR ID in Profile UI, register → reload keeps session, UI login after fresh boot, UI logout really revokes, revocation + expiry deny after reload, CSRF missing/bogus → 403 | `Secure` cookie in production mode is code-reviewed, not browser-tested (suite runs in dev mode) |
| Real-time chat | Pass | Chat spec (4 tests): two browser contexts, DM message arrives as a real `message:new` Socket.IO event without reload, persists after refresh both sides, non-member HTTP + socket denial, group create/invite/add, removed member loses HTTP + socket immediately | — |
| Media upload and access | Pass | Media spec (4 tests): real 1×1 PNG attached, recipient downloads identical bytes, fake signature/EXE/11 MB rejected, outsider + unauthenticated downloads denied, no permanent public URL | Oversize/malformed uploads surface as generic 500, not 413/400 (cosmetic, no leak, no file stored) |
| TRANSIT lifecycle | Pass | Delivery spec (2 tests) + UI-mutations spec: full lifecycle in browser to DELIVERED, persists after refresh, 8-step timeline in UI, invalid transitions rejected, unrelated users 403/≥400 | — |
| Docker deployment | Fail (environment) | Docker 29.1.3 binary installed; daemon fails: bridge/netlink denied, `runc create failed … setns: operation not permitted` for every container, registry pulls EOF, `docker compose` was missing (installed 2.40.3). `docker compose config` renders the merged stack correctly. Host-side equivalent passed: production-mode app on host PG 16 (migrations, health, registration, chat round-trip, restart persistence, no secret leakage in logs) | Container build/boot/migration/restart-persistence MUST be re-verified on a real Docker host; compose `POSTGRES_PASSWORD: changeme` is a placeholder; no `restart:` policy or app healthcheck in compose |
| HTTPS | Partial | Local TLS verified: nginx 1.24.0 terminated TLS (self-signed localhost cert) in front of the production-mode app — HTTPS 200, TLS 1.3, HTTP→HTTPS 301, HSTS present (test proxy), `Secure` + `HttpOnly` + `SameSite=Lax` cookies observed, Helmet headers observed | Public HTTPS UNTESTED: no domain or publicly trusted certificate exists here; Let's Encrypt issuance/renewal and port-443 serving must be verified on the real host; self-signed cert must never leave local testing |
| Backup and restore | Pass | `npm run test:deployment`: pg_dump (33,929 bytes, non-empty) → restore into separate empty DB, counts matched exactly (users/conversations/messages/deliveries/history 1/1 each on the fresh seed; 5/2/2/1/1 on the earlier run), app booted in production mode against restored DB (health up, anonymous 200, `/me` 200). Procedure in `docs/BACKUP_RESTORE.md` | No point-in-time recovery (needs WAL archiving, not set up); `STORAGE_DIR` must be restored alongside the DB; dumps are plaintext SQL — encrypt before they leave the DB host |
| Anonymous ID claim | Pass | security2-anon: 9/9 real PG, 9/9 pg-mem. Server-issued IDs, supplied fields ignored, invalid inputs rejected, conflicting claim → 409, repeated claim → 400, concurrent claims safe, no private fields in public responses | Concurrent-claim tests assert safe outcome shapes, not a specific winner (race is nondeterministic by nature) |
| Account deletion | Pass | security2-deletion: 6/6 real PG (5 pass + 1 PG-only skip on pg-mem). Sessions revoked HTTP + socket, login fails, profile 404, second delete safe, audit row survives, no ownership transfer/elevation, deleted email freed for new registration (documented) | Full purge of a user's content remains a manual operator action (see SECURITY.md deletion semantics) |
| Private access controls | Pass | security2-access 7/7, security2-files 10/10, security2-revocation 8/8, security2-misc 9/9 (all real PG). Full IDOR sweep, post-removal read/send/edit/delete/download denial, stale-socket kick, signed-URL tampering/expiry/replay rules, traversal/filename/MIME/size controls, no static exposure | Signed URLs replayable by the same authorized user within 15 min by design; removed members keep their own uploads (owner check, intended) |
| Real maps integration | Partial | Live demo verified: direct OSRM request → 200 (`code: "Ok"`, 2949.6 m, 380.7 s) and opt-in live smoke through `GET /:id/route` → 200 with positive distance/duration (`NEXORA_MAPS_LIVE_SMOKE=1`, 1 pass). maps.test.js: 13 pass, 0 fail, 1 skipped (live smoke) — stub-transport normalization, 400/404/502/503 mapping without leaking internals, authz, timeout | Demo-scale only: public OSRM/Nominatim servers are donated, rate-capped (~1 req/s), no uptime guarantee — NOT a production backend. Production needs a self-hosted instance (base-URL override, no code change) or a keyed provider behind the same interface. Default ships unconfigured (truthful 503). No rendered map (distance/duration only) |
| Concurrent courier assignment | Pass | `npm run test:race` (real PG): 20/20 rounds × 3 runs, 423 assertions each, exactly one winner per round, losers 40×409 per run, exactly one assignment row + one ASSIGNED history entry per round. Mechanism: row-lock-serialized conditional `UPDATE … WHERE status='SEARCHING_FOR_COURIER' AND courier_id IS NULL` in one transaction | Concurrency correctness only, NOT a load test (no throughput/latency claims); 20 rounds is a smoke-level sample; winner distribution skews to first-dispatched on localhost (ordering artifact, not a failure); the verify-path concurrent-code race is a separate surface worth a follow-up test |
| Verification expiry/replay | Pass | verificationCodes.test.js on real PG: 14/14 (was 13 pass + 2 fail before the B1 fix; the characterization test was deleted per its own instruction once fixed). Pickup + dropoff separately: stage binding, wrong-code rejection, deterministic expiry (direct `expires_at` backdate — payload embeds no expiry, so no crafted artifact is possible), single-use, cross-delivery rejection, lockout (`CODE_LOCKED` distinct), no duplicate transitions (concurrent + sequential), unauthorized retrieval denied, QR-alone rejected, storage = AES-256-GCM ciphertext (appropriate: sender must view the code) | Expiry boundary (exact millisecond) and rate-limiter window reset not tested; after a lockout there is no code-reissue endpoint (sender recourse is cancel-and-recreate); pg-mem does NOT reproduce the real transaction rollback, so pg-mem green runs must not be read as lockout proof |

### Commands executed and actual results (consolidation + final regression)

| Command | Result |
|---|---|
| `npm test` (final, pg-mem) | 129 tests, 122 pass, 0 fail, 7 skipped (skips are conditional pg-mem skips in verificationCodes/maps suites; one fewer than the pre-consolidation 130/8 because the fixed characterization test was deleted) |
| `npm run test:e2e` (final, Playwright, real PG) | 25 passed, 0 failed, 1.4 min: auth 7, chat 4, delivery 2, media 4, navigation 5, ui-mutations 3 |
| `NEXORA_TEST_DATABASE_URL=…/nexora_codes node --test backend/tests/integration/verificationCodes.test.js` | 14 pass, 0 fail (real PG) |
| `bash scripts/test-race.sh` | ALL GREEN (20 rounds, exactly one winner per round, real PG) |
| `NEXORA_TEST_DATABASE_URL=…/nexora_security bash scripts/test-security.sh` | ALL GREEN: 49/49 across 6 files (real PG, sequential) |
| `NEXORA_MAPS_LIVE_SMOKE=1 node --test --test-name-pattern="live smoke" backend/tests/integration/maps.test.js` | 1 pass (real OSRM demo route through the endpoint) |
| `npm run test:deployment` | Config tests pass + backup/restore ALL GREEN (see table) |
| `npm audit` | NOT RUN — sandbox registry policy blocks it (403 `policy_denied` on the audit endpoint). No severity counts available; no dependency upgrades made on that basis. Installed versions observed: express 4.22.3, helmet 8.3.0, socket.io 4.8.4, pg 8.23.1, zod 3.25.76, multer 2.5.0, bcryptjs 2.4.3 |

### Bugs found and fixed during this program (all with failing tests first)

1. **B1 — verification-code attempts never persisted (Medium).** Wrong-code
   increment ran inside the verify transaction and rolled back on throw, so
   `CODE_LOCKED` was unreachable. Fix: sentinel return + separate committed
   UPDATE; `CODE_MAX_ATTEMPTS` now honored at challenge creation (was
   ignored; DB default always applied). Files: `backend/src/routes/
   deliveries.js`, `backend/src/config.js` (clamped ≥ 1).
2. **CSRF adoption — all authenticated UI mutations failed (Severe).**
   Frontend never adopted `csrfToken` from auth responses, and
   `GET /api/auth/csrf` minted a fresh random token on every call (so even
   reloads broke mutations). Fix: `frontend/src/api.js` adopts
   `data.csrfToken`; `/api/auth/csrf` returns the session token when
   authenticated. `openConv()`'s read-mark is now best-effort. Converted
   known-issue browser tests now assert the fixed behavior; new
   `tests/browser/ui-mutations.spec.js` covers UI clicks incl. post-claim
   rotation.
3. **CSP blocked the app's own styling (cosmetic, UI-total).** Inline
   `<style>` + inline `style=`/`onerror` vs `style-src 'self'`. Fix: CSS
   moved verbatim to `frontend/src/styles.css`, inline styles became
   classes, avatar hue via `data-hue` + CSSOM, QR `onerror` via a
   capture-phase delegated listener. Playwright asserts zero CSP reports.
4. **CORS reflect-all default (Low/Medium).** With `CORS_ORIGINS` unset, any
   Origin was reflected with credentials. Fix: default same-origin only
   (`origin: false`) for Express and Socket.IO. Probe-verified the socket
   option governs headers, not the handshake gate (cookie + revalidation
   is the real control).
5. **Session fixation on claim, post-removal edit/delete, stale-socket
   broadcast receipt, socket surviving logout, UUID 500 leaks, bio-only
   update 500, filename NUL bytes (V1–V7, Medium→Low).** Fixed in Phase 4;
   see `docs/SECURITY.md` for the full list with mechanisms.
6. **Production `DATABASE_URL` not required (Medium).** `reqInProd()` was
   defined but never called, so production could boot database-down. Fix:
   `backend/src/config.js` now fails fast; 5 regression tests in
   `backend/tests/unit/config.test.js`. (`CODE_ENCRYPTION_KEY` was already
   fail-fast — verified, not a defect.)

### Files changed in this program

- **Production fixes:** `backend/src/routes/deliveries.js` (B1 + route
  endpoint + maps wiring), `backend/src/routes/auth.js` (session-token
  `/csrf`, claim session rotation), `backend/src/routes/conversations.js`
  (membership on edit/delete, socket kick), `backend/src/routes/files.js`
  (filename sanitization), `backend/src/routes/users.js` (empty-SET fix),
  `backend/src/services/authz.js` (UUID validation), `backend/src/
  realtime/socket.js` (per-event revalidation, CORS default),
  `backend/src/server.js` (generic 500s, CORS default),
  `backend/src/config.js` (production fail-fast, max-attempts clamp),
  `frontend/src/api.js` (CSRF adoption), `frontend/src/app.js` (openConv
  resilience, CSP classes, geolocation + manual fallback),
  `frontend/src/styles.css` (new), `frontend/index.html` (stylesheet link).
- **New services:** `backend/src/services/maps/` (`provider.js`,
  `osrm.js`, `index.js`).
- **New tests:** `tests/browser/` (Playwright config + 6 spec files +
  helpers + artifacts), `backend/tests/integration/security2-*.test.js`
  (6 files, 49 tests), `backend/tests/integration/courierRace.test.js`,
  `backend/tests/integration/verificationCodes.test.js`,
  `backend/tests/integration/maps.test.js`,
  `backend/tests/unit/config.test.js`.
- **New scripts/docs:** `scripts/test-security.sh`, `scripts/test-race.sh`,
  `scripts/backup-restore-test.sh` (+ repeatability fix),
  `docker-compose.test-override.yml`, `docs/DEPLOYMENT.md`,
  `docs/BACKUP_RESTORE.md`, `docs/MAPS.md`, `package.json` (Playwright
  devDependency + `test:e2e`/`test:journey`/`test:security`/`test:race`/
  `test:deployment` scripts), `.env.example` (maps placeholders, CORS
  warning, production notes), `README.md` (scripts table, maps status,
  deployment section).
- **Untouched:** `docs/original-NEXORA.html`, `database/migrations/`
  (no new migrations were needed), `Dockerfile`,
  `docker-compose.yml` (production file unchanged; test-only override
  separate), no `.env` created, no GitHub push made in this program.

### Known limitations (consolidated, honest)

- Docker container boot is **untested** in this sandbox (4 independent
  blockers) and must be re-run on a real Docker host before any
  container-based production claim.
- Public HTTPS is **untested** (no domain/certificate); local TLS via nginx
  self-signed cert is the only HTTPS evidence.
- Maps is **demo-scale only** until a self-hosted or keyed provider is
  configured; no map is rendered.
- `npm audit` **not run** (registry policy block); dependency vulnerabilities
  are unknown, not clean.
- No payments, push, E2EE, S3, or mail wiring (unchanged honest gaps).
- Browser suite is Chromium-only, headless; no Firefox/WebKit, no
  physical-device testing.
- The courier race test proves correctness under 3-way localhost
  contention, not load performance; the verify-path concurrent-code race
  is untested.

## What "tested" means here

- "Tested (real PG)" = the named behavior is covered by an automated test that
  passed against PostgreSQL 16 in this session (via `scripts/test-real-pg.sh`).
- "Smoke-tested (server)" = a live HTTP check, not a full user journey.
- Anything marked "Not tested" or "Not implemented" was deliberately left that
  way and is labeled as such in the product too (health endpoint, UI banners).
- No test was ever marked passed without running it. Two real bugs found by the
  real-PG run (history ordering, missing import) are listed above with fixes.
