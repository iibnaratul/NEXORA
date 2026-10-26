# NEXORA

[![CI](https://github.com/ibnaratul2025-hue/NEXORA/actions/workflows/ci.yml/badge.svg)](https://github.com/ibnaratul2025-hue/NEXORA/actions/workflows/ci.yml)

Pseudonymous chat and parcel delivery (**NEXORA TRANSIT**) with a real backend:
PostgreSQL persistence, cookie sessions, server-side authorization on every
endpoint and socket event, private media behind signed URLs, and a
server-validated delivery state machine with one-time handover codes.

This is a transformation of the original single-file prototype
(`docs/original-NEXORA.html`, preserved verbatim). The interface, dark futuristic
theme, and tab structure are kept; the data layer is entirely replaced — no
`window.claude`, no `localStorage` identity, no mock data, no fake success.

## Quick start (local, real PostgreSQL)

```bash
npm install
cp .env.example .env        # set DATABASE_URL + CODE_ENCRYPTION_KEY
npm run migrate             # applies database/migrations/ in order
npm run seed                # dev-only demo data (refused in production)
npm start                   # http://localhost:3000
```

Without a database the server still boots, but `/api/health` reports
`database: down` and every data endpoint fails honestly instead of faking data.

## Docker

```bash
CODE_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  docker compose up --build
docker compose exec app npm run migrate
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Run the backend (serves API + frontend on one origin) |
| `npm run migrate` | Apply pending migrations, once each, in order |
| `npm run seed` | Dev-only demo users/room/order (see below) |
| `npm test` | All tests (pg-mem emulator path, no PostgreSQL needed) |
| `npm run test:unit` / `test:integration` | Subsets |
| `npm run test:journey` | Backend end-to-end journey (register → chat → delivery → reload) |
| `npm run test:e2e` | Real-browser Playwright suite (Chromium, real PostgreSQL) |
| `npm run test:security` | Security regression suites, run sequentially per file (set `NEXORA_TEST_DATABASE_URL` for the real-PostgreSQL path) |
| `npm run test:race` | Courier race test, 20 concurrent-claim rounds (real PostgreSQL required) |
| `npm run test:deployment` | Production fail-fast config tests + backup/restore verification |
| `bash scripts/test-real-pg.sh` | Every test file against real PostgreSQL 16, fresh DB per file |

## Architecture

See `docs/PLAN.md` for the full feature map and the decisions behind it. In short:

- **Backend**: Node.js 24 + Express, plain JavaScript (ESM). The brief prefers
  TypeScript; JS was chosen deliberately for zero-build-step runnability in this
  environment, with Zod validating every write at the boundary. Module layout
  mirrors the TS structure, so a TS migration is mechanical.
- **Database**: PostgreSQL, hand-written parameterized SQL, versioned migrations.
- **Auth**: HttpOnly cookie sessions (server-side rows, SHA-256 token hashes,
  expiry, revocation) + CSRF double-submit. Passwords: bcrypt. NEXORA IDs are
  server-issued (`NXR-` + 8 crypto-random chars).
- **Realtime**: Socket.IO, session-cookie auth, membership checked on join and
  on every message event.
- **Files**: private directory storage, magic-byte verification, short-lived
  HMAC-signed download URLs, authorization re-checked on download.
- **Delivery machine**: `CREATED → SEARCHING_FOR_COURIER → ASSIGNED → ACCEPTED →
  PICKUP_VERIFIED → IN_TRANSIT → DROPOFF_VERIFIED → DELIVERED`, plus
  `CANCELLED` and disputes. Courier claim is one atomic `UPDATE … WHERE
  status='SEARCHING_FOR_COURIER'`; handover codes are AES-256-GCM encrypted,
  expiring, attempt-limited, single-use; the QR holds only the order reference.
  Marketplace orders (2026-10-26) use a separate fulfillment path
  `CREATED → PREPARED → READY_FOR_PICKUP → DELIVERED` driven by delivery
  requests created inside chats/groups (see `docs/API.md`); cash-on-pickup
  is recorded, never charged.
- **Community hub & trust (2026-10-26)**: group roles Owner/Admin/Moderator/
  Member with badges; pinned announcements; group rules; admin log;
  ownership transfer with confirmation; invite links + invite QR; join-
  request approvals; message threads, reactions, and edited tags; a live
  delivery status card in chat driven only by the real delivery state;
  time-limited pickup-only live location (one-shot reading, 30-minute
  expiry, no tracking, no history); post-delivery ratings with reputation
  computed live from real data only (never seeded); "Item Exchanged" as the
  display state for delivered marketplace orders; system messages for
  arrival and exchange; well-lit-public-place guidance copy (text only).
  Not built: E2EE, auto-deleting messages, "discreet mode" (see
  `docs/API.md`).

## Seed accounts (development only — change immediately)

- Admin: `admin@nexora.local` / `Admin123!change`
- Alice: `alice@nexora.local` / `Alice123!change`
- Bob (courier): `bob@nexora.local` / `Bob123!change`

## What is NOT implemented (honest list)

- **Maps/GPS routing**: OSRM (routing) + Nominatim (geocoding) are integrated
  behind a provider interface (`backend/src/services/maps/`, see
  `docs/MAPS.md`) and verified live against the public demo servers. Since
  2026-10-26 the frontend renders a real map (Leaflet 1.9.4 vendored
  locally, OpenStreetMap tiles, no key) with a pin picker, and `render.yaml`
  sets `MAPS_PROVIDER=osrm` for the live deployment so routing works there
  (if a Blueprint sync misses it on the existing service, set it in the
  Render dashboard too). Demo servers remain rate-capped with no uptime
  guarantee — production scale needs a self-hosted or keyed provider (the
  Google adapter is documented in `docs/MAPS.md`, not implemented — it needs
  a real Google Cloud key + billing). No routes, distances, or ETAs are
  ever fabricated. Manual areas + optional GPS coordinates are stored.
- **Payments**: fees are informational only; nothing is charged.
- **Push notifications**: in-app notifications table exists; no push channel.
- **End-to-end encryption**: messages are protected by TLS in production, not
  E2EE. The UI says so.
- **S3 storage**: interface documented; only the local private-directory
  provider is wired (no credentials exist).
- **Email password recovery**: endpoint returns `503 NOT_CONFIGURED` (no mail
  provider). Admins reset accounts via the admin API.

## Deployment (Phase 3, 2026-10-25)

Production refuses to boot without `CODE_ENCRYPTION_KEY` (64 hex chars) and
`DATABASE_URL` — the latter fail-fast was added in Phase 3; previously a
production server could boot into a degraded database-down mode. Full
procedure, secret/key rotation, and the honest verification status live in
`docs/DEPLOYMENT.md`; backup/restore procedure and its automated test live in
`docs/BACKUP_RESTORE.md` (`bash scripts/backup-restore-test.sh`). Note:
Docker containers could **not** be started in the Phase 3 sandbox (daemon
bridge failure, runc namespace denial, registry unavailability), so the
container boot path is still untested and must be re-verified on a real
Docker host; the app itself was verified in `NODE_ENV=production` on the host
against real PostgreSQL 16, and local HTTPS via nginx (self-signed) was
verified — public HTTPS is untested. An isolated test stack is defined by
`docker-compose.test-override.yml` (project `-p nexora-deploy-test`, app on
host port 3101).

## Live deployment (2026-10-26)

NEXORA is live at https://nexora-oaje.onrender.com/ via a Render Blueprint
(`render.yaml` in the repo root): a free Node web service + free PostgreSQL
database, both in the Singapore region, auto-deploying on every push to
`main`. Migrations run via `startCommand` (`npm run migrate && npm start`)
because Render's free tier does not support `preDeployCommand`. Verified
2026-10-26: `/api/health` reports `status: ok, database: up` and the
frontend serves the welcome page.

Free-tier limits (checked Oct 2026): the web service spins down after 15
minutes idle (~1 minute to wake); the free database expires 30 days after
creation with a 14-day grace period to upgrade; uploaded files on local
disk do not survive redeploys. For permanent data, upgrade the database
to a paid plan.

## Continuous integration & releases

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request: the full test suite (pg-mem), the integration/e2e suites against
real PostgreSQL 16, the Playwright browser suite against real PostgreSQL,
and a Docker stack smoke test (build, migrate, health check). Pushing a
version tag (`v*.*.*`) additionally publishes a GitHub Release containing
a source tarball of the app — but only after all test jobs pass.

A Release is **not** a live website — but NEXORA is separately deployed
live at https://nexora-oaje.onrender.com/ via Render (see Deployment
above and `docs/DEPLOYMENT.md`).

## Documentation

- `docs/PLAN.md` — implementation plan + original-feature map
- `docs/API.md` — endpoint reference
- `docs/SECURITY.md` — controls, threat notes, residual risks
- `docs/VERIFICATION_REPORT.md` — what was actually run, with evidence
- `docs/DEPLOYMENT.md` — production config, Docker status, HTTPS
- `docs/BACKUP_RESTORE.md` — backup/restore procedure + verification
