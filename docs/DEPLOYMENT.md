# NEXORA — Deployment guide (Phase 3, 2026-10-25)

Production reference: `docker-compose.yml` (PostgreSQL 16 + app, migrations run
explicitly, never on boot). This document records what was actually verified,
what is required, and what is still untested. It does not claim a deployment
that did not happen.

## 1. Required environment (production fail-fast)

`backend/src/config.js` refuses to boot in `NODE_ENV=production` when a
mandatory variable is missing or malformed. Verified 2026-10-25 by direct
subprocess runs and by `backend/tests/unit/config.test.js` (5/5 pass):

| Variable | Required in production? | Behaviour if missing/malformed |
|---|---|---|
| `CODE_ENCRYPTION_KEY` | Yes — 64 hex chars (32 bytes) | Refuses to boot (pre-existing behaviour, kept). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Never commit it; never log it. |
| `DATABASE_URL` | Yes (Phase 3 fix, 2026-10-25) | Refuses to boot with `Missing required production environment variable: DATABASE_URL`. Before this fix the server booted into a degraded "database: DOWN" mode in production and served an API whose data endpoints all failed; development still tolerates a missing database and reports it honestly via `/api/health`. |
| `PORT` | No (default 3000) | — |
| `TRUST_PROXY` | Set `true` only behind a trusted reverse proxy | Controls `app.set('trust proxy', 1)`. Behind nginx it must be `true` so rate-limit keys and `req.ip` are correct; on a directly exposed server it must be `false`, or clients could spoof IPs. |
| `CORS_ORIGINS` | Strongly recommended (see §5 finding F-1) | Comma-separated allowlist, e.g. `https://app.example.com`. Empty = see warning below. |
| `SESSION_TTL_DAYS` | No (default 7) | Session cookie `Max-Age` and row expiry. |
| `SESSION_COOKIE_NAME` | No (default `nx_session`) | — |
| `BCRYPT_ROUNDS` | No (default 12) | Lower values weaken password hashing; do not lower in production. |
| `CODE_TTL_HOURS` / `CODE_MAX_ATTEMPTS` | No (defaults 24 / 5) | Handover-code lifetime and verification attempts. |
| `STORAGE_DIR` / `STORAGE_PROVIDER` | No (defaults `./storage` under the project / `local`) | Only `local` is wired; `s3` is documented, not implemented. The directory must be a persistent volume, or uploaded files vanish on container recreation. |
| `MAX_UPLOAD_MB` | No (default 10) | — |
| `MAPS_PROVIDER` | No (empty = none) | Route endpoint returns `503 MAPS_NOT_CONFIGURED` when unset — by design, never fabricated. |
| `AUTH/MESSAGE/UPLOAD/DELIVERY/API_RATE_LIMIT_MAX` | No | Test/ops overrides only; production defaults are auth 10/min, messages 30/min, uploads 20/min, deliveries 60/hour, API 300/min. |

There is **no session signing secret**: sessions are opaque random tokens
whose SHA-256 hashes live in `user_sessions`. "Rotating" sessions therefore
means revoking rows, not rotating a key:

- Per user: `UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1`.
- Global logout: `UPDATE user_sessions SET revoked_at = now() WHERE revoked_at IS NULL`.
- Shortening `SESSION_TTL_DAYS` only affects newly issued sessions; existing
  rows keep their stored `expires_at`.

### Encryption-key rotation (handover codes)

`CODE_ENCRYPTION_KEY` decrypts outstanding one-time handover codes
(`verification_challenges.code_encrypted`, AES-256-GCM). There is **no key
versioning**: rotating the key makes every outstanding pickup/dropoff code
undecryptable, so those deliveries cannot complete verification until a new
code is issued (if the app flow allows it — check the delivery flow before
rotating). Rotation procedure:

1. Confirm no delivery is mid-handover (no unexpired, unused challenge rows).
2. Set the new key in the secret store, restart the app.
3. Verify `/api/health` reports `database: up` and a test login works.
4. Keep the old key recorded (sealed, access-controlled) until every code
   encrypted under it has expired (`CODE_TTL_HOURS`, default 24h), in case of
   rollback.

## 2. Standard deployment (Docker host with a working daemon)

```bash
# From the project root. The compose file requires CODE_ENCRYPTION_KEY.
CODE_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  docker compose up --build -d
docker compose exec app npm run migrate   # explicit, idempotent
curl -s http://localhost:3000/api/health  # expect "database":"up"
```

Notes:

- `docker-compose.yml` sets `POSTGRES_PASSWORD: changeme` and the matching
  `DATABASE_URL`. That is a **placeholder**: override both for any real
  deployment (e.g. a `.env` file next to the compose file, never committed).
- Migrations are deliberately not run on boot, so a bad migration can never
  auto-apply when a container restarts.
- Data persistence is the named volume `pgdata`; recreating the `app`
  container does not touch it. Uploaded files live in the `./storage` bind
  mount — back it up alongside the database (see `docs/BACKUP_RESTORE.md`).
- The compose file has no `restart:` policy and no app healthcheck; add
  `restart: unless-stopped` and an app healthcheck in your deployment overlay
  if your orchestrator does not provide them. (Left out of the committed file
  on purpose: Phase 3 did not change the production file for unverified
  improvements.)

## 3. Isolated test deployment (never against production data)

```bash
CODE_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  docker compose -p nexora-deploy-test \
    -f docker-compose.yml -f docker-compose.test-override.yml up --build -d
docker compose -p nexora-deploy-test -f docker-compose.yml -f docker-compose.test-override.yml \
  exec app npm run migrate
# ... run checks against http://localhost:3101/api/health ...
docker compose -p nexora-deploy-test -f docker-compose.yml -f docker-compose.test-override.yml down -v
```

The override (`docker-compose.test-override.yml`) only changes test-project
ports, the test database name/password, and `CORS_ORIGINS`; it does not alter
the production service definitions. The `-p` project name keeps volumes and
networks separate from any other stack on the same host.

## 4. What Docker verification actually showed in this sandbox (2026-10-25)

Docker **cannot run containers in this VM**, so `docker compose up` was
**not** achieved here. Three independent blockers, all reproduced:

1. **Default daemon fails**: `dockerd` exits with
   `failed to start daemon: Error initializing network controller: error
   creating default "bridge" network: operation not supported`
   (`Failed to create bridge docker0 via netlink`, plus the reported
   iptables NAT `RULE_APPEND failed (exit status 4)`).
2. **Workaround daemon starts, containers still cannot start**:
   `dockerd --iptables=false --bridge=none --storage-driver=vfs` reaches
   `Daemon has completed initialization`, and `docker network create` still
   fails (`operation not supported`), but every `docker run` — including
   `--privileged` — fails with:
   `OCI runtime create failed: runc create failed: unable to start container
   process: error spawning mount remapping thread: mount source thread: join
   container mntns: setns: operation not permitted`.
   The sandbox denies the namespace operations containers need.
3. **Registry pulls became unavailable**: `docker pull node:24-alpine` and
   `postgres:16-alpine` fail with `Get "https://registry-1.docker.io/v2/": EOF`
   (an earlier `hello-world` pull succeeded once, then the same path failed —
   transient at first, then consistent). So `docker build` never got past
   `Step 1/11 : FROM node:24-alpine`.

4. **Compose plugin was missing** (found while validating the test
   override): `docker compose` initially failed with
   `docker: unknown command: docker compose`. Installing the Ubuntu package
   `docker-compose-v2` (2.40.3) fixed the CLI, and `docker compose -p
   nexora-deploy-test -f docker-compose.yml -f docker-compose.test-override.yml
   config` then rendered the merged stack correctly — test DB
   `nexora_deploy_test`, app published only on 3101 (via `!override`; plain
   port lists merge additively), and the DB healthcheck correctly overridden
   to `pg_isready -U nexora_test` (the base healthcheck probes user `nexora`
   and would never go healthy under the renamed test user). Config
   validation passed; `up` itself still cannot run here for reasons 1–3.

Consequence: the Dockerfile and compose file are **syntactically present and
unchanged, but the image build, compose boot, in-container migration, and
container-restart persistence checks are UNTESTED** and must be re-run on a
real Docker host before anyone claims a container deployment works. What
*was* verified instead, on the host against real PostgreSQL 16 with the app
in `NODE_ENV=production`:

- Migrations applied cleanly: `001_init`, `002_message_client_id`,
  `003_history_seq` (via `npm run migrate` against a disposable `nexora_deploy` DB).
- `/api/health` → `status: ok, database: up`; frontend `/` → 200.
- Anonymous registration (×2) + password registration → 200; DM creation →
  201; message send → 201; cross-user read-back → 200 with the exact body.
- Restart persistence: server killed and restarted (fresh throwaway key);
  counts unchanged (users 3, conversations 1, messages 1 at that point) and
  the message body survived.
- Server log contained no 64-hex strings (leak scan: 0 matches) and no
  unhandled-error output during these runs.

## 5. HTTPS (reverse proxy) — verified locally, public HTTPS UNTESTED

A real TLS-terminating nginx (1.24.0, installed via apt for this test) was
run in front of the production-mode app on localhost with a self-signed
certificate for `localhost` (2-day validity, SAN `DNS:localhost,IP:127.0.0.1`).
Verified with `curl -k`:

- `https://127.0.0.1:8443/api/health` → 200, `database: up`, TLS 1.3
  (`TLS_AES_256_GCM_SHA384`).
- `http://127.0.0.1:8080/api/health` → `301 https://127.0.0.1:8443/api/health`.
- HSTS header present: `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  (configured in the test proxy config below — HSTS was enabled in this test).
- Session cookie over TLS: `nx_session: HttpOnly, Secure, SameSite=Lax`;
  `nx_csrf: Secure, SameSite=Lax` (not HttpOnly by design — the frontend JS
  reads it for the double-submit header). The `Secure` flag comes from
  `NODE_ENV=production` in `middleware/auth.js` and `routes/auth.js`; it is
  present even when the app itself is reached over plain HTTP behind the
  proxy, which is correct — browsers only send it over HTTPS.
- Helmet headers observed: CSP (`default-src 'self'`, `upgrade-insecure-requests`),
  `X-Content-Type-Options: nosniff`.

Local test proxy config (ports 8443/8080 are test-only; production uses
443/80 and a real certificate):

```nginx
server {
    listen 8443 ssl;
    server_name localhost;
    ssl_certificate /tmp/nexora-tls/localhost.crt;
    ssl_certificate_key /tmp/nexora-tls/localhost.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    location / {
        proxy_pass http://127.0.0.1:3101;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    listen 8080;
    server_name localhost;
    return 301 https://$host:8443$request_uri;
}
```

With this proxy, set `TRUST_PROXY=true` on the app so rate limiting and
`req.ip` use the forwarded client IP. **Public HTTPS is UNTESTED**: no domain
or publicly trusted certificate exists in this environment, so the Let's
Encrypt / certbot path (certificate issuance, renewal, and 443 serving) must
be verified on the real host. The self-signed cert above must never be used
beyond local testing.

### Finding F-1 (out of Phase 3 ownership — NOT fixed, needs a decision)

`backend/src/server.js` configures CORS as
`origin: config.corsOrigins.length ? config.corsOrigins : true` with
`credentials: true`. In production with `CORS_ORIGINS` unset, that reflects
**any** request `Origin` while allowing credentials — a cross-origin
credentialed API hole if the API is ever called cross-origin. It is mostly
moot in the default same-origin deployment (the app serves its own frontend),
but it is still the wrong default. The fix belongs in `server.js` (outside
Phase 3 ownership, so it was not changed): default to no cross-origin access
or require an explicit allowlist, and always set `CORS_ORIGINS` in real
deployments (the test override does). Flagged for the coordinator, not
silently patched.

## 6. Logging, health, and operations

- The app logs only startup (`API up on :PORT (database: up|DOWN)`) and
  5xx errors to stdout/stderr — no request log, no secret values. Put access
  logging at the proxy (nginx `access_log`) and ship container stdout to
  your log aggregator.
- `/api/health` is unauthenticated by design and reports capability status
  (database, storage provider, maps configured, realtime, payments/push/E2EE
  explicitly unconfigured). It never claims a provider exists when it does
  not. Use it for load-balancer health checks; do not use it as a readiness
  gate for migrations — run `npm run migrate` explicitly first.
- Backups: see `docs/BACKUP_RESTORE.md` (procedure + `scripts/backup-restore-test.sh`).
