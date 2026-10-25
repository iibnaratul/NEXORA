#!/bin/bash
# NEXORA backup/restore verification (Phase 3, 2026-10-25).
#
# Proves, against DISPOSABLE databases only, that pg_dump of a live NEXORA
# database restores into a separate empty database with identical row counts
# and that the real app boots against the restored database.
#
# SAFETY: refuses to run against nexora_test (used by other agents' real-PG
# suite) or the default 'nexora' database unless BACKUP_ALLOW_ANY_DB=1 is set.
# Only row COUNTS are printed — never record contents, tokens, or hashes.
#
# Usage:
#   bash scripts/backup-restore-test.sh
#   SRC_DB=nexora_deploy RESTORE_DB=nexora_restore_test bash scripts/backup-restore-test.sh
#   KEEP_ARTIFACTS=1 bash scripts/backup-restore-test.sh   # keep dump + restored DB
#
# Prerequisites: local PostgreSQL 16, role nexora / dev-only password (see
# .env.example — production uses its own credentials, never these), node,
# curl. The app is booted in NODE_ENV=production with a freshly generated
# throwaway encryption key; that key is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC_DB="${SRC_DB:-nexora_deploy}"
RESTORE_DB="${RESTORE_DB:-nexora_restore_test}"
APP_PORT="${APP_PORT:-3103}"
PGURL_BASE="postgres://nexora:nexora-dev-only@127.0.0.1:5432"
BACKUP_FILE="${BACKUP_FILE:-/tmp/nexora-backup-test-$(date +%Y%m%d%H%M%S).sql}"
APP_LOG="/tmp/nexora-restore-app.log"

if [[ "$SRC_DB" == "nexora_test" || "$SRC_DB" == "nexora" ]] && [[ "${BACKUP_ALLOW_ANY_DB:-}" != "1" ]]; then
  echo "REFUSING: SRC_DB=$SRC_DB is not a disposable test database. Set SRC_DB to a disposable name (e.g. nexora_deploy) or BACKUP_ALLOW_ANY_DB=1." >&2
  exit 2
fi
if [[ "$RESTORE_DB" == "$SRC_DB" ]]; then echo "REFUSING: RESTORE_DB must differ from SRC_DB." >&2; exit 2; fi

command -v pg_dump >/dev/null || { echo "pg_dump not found" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql not found" >&2; exit 1; }

# Repeatability: ensure the disposable source DB exists and is migrated
# (idempotent — migrate skips already-applied versions). Previously the
# script assumed a leftover database from an earlier manual run.
su postgres -c "createdb -O nexora $SRC_DB" >/dev/null 2>&1 || true
DATABASE_URL="$PGURL_BASE/$SRC_DB" node backend/src/migrate.js >/dev/null

psql "$PGURL_BASE/$SRC_DB" -v ON_ERROR_STOP=1 -q <<'SQL'
-- Seed one synthetic record per table under test. Idempotent on re-runs:
-- previous seed rows (identified by their synthetic refs) are removed first.
DELETE FROM delivery_status_history WHERE delivery_id IN (SELECT id FROM deliveries WHERE public_ref = 'NXD-BKPTEST');
DELETE FROM delivery_participants WHERE delivery_id IN (SELECT id FROM deliveries WHERE public_ref = 'NXD-BKPTEST');
DELETE FROM deliveries WHERE public_ref = 'NXD-BKPTEST';
DELETE FROM messages WHERE sender_id IN (SELECT id FROM users WHERE nexora_id = 'NXR-BACKUP01');
DELETE FROM conversation_members WHERE user_id IN (SELECT id FROM users WHERE nexora_id = 'NXR-BACKUP01');
DELETE FROM conversations WHERE created_by IN (SELECT id FROM users WHERE nexora_id = 'NXR-BACKUP01') AND name = 'BackupProbeRoom';
DELETE FROM public_profiles WHERE user_id IN (SELECT id FROM users WHERE nexora_id = 'NXR-BACKUP01');
DELETE FROM users WHERE nexora_id = 'NXR-BACKUP01';

INSERT INTO users (nexora_id, is_anonymous, display_name) VALUES ('NXR-BACKUP01', TRUE, 'BackupProbe');
INSERT INTO public_profiles (user_id, display_name)
  SELECT id, 'BackupProbe' FROM users WHERE nexora_id = 'NXR-BACKUP01';
INSERT INTO conversations (type, name, created_by)
  SELECT 'room', 'BackupProbeRoom', id FROM users WHERE nexora_id = 'NXR-BACKUP01';
INSERT INTO conversation_members (conversation_id, user_id, role)
  SELECT c.id, u.id, 'owner' FROM conversations c, users u
  WHERE c.name = 'BackupProbeRoom' AND u.nexora_id = 'NXR-BACKUP01';
INSERT INTO messages (conversation_id, sender_id, body)
  SELECT c.id, u.id, 'backup-restore probe message'
  FROM conversations c, users u WHERE c.name = 'BackupProbeRoom' AND u.nexora_id = 'NXR-BACKUP01';
INSERT INTO deliveries (public_ref, sender_id, name, category, size, pickup_area, dropoff_area, status)
  SELECT 'NXD-BKPTEST', id, 'Probe parcel', 'Documents', 'Small (fits a bag)', 'Savar Bazar', 'Dhanmondi', 'CREATED'
  FROM users WHERE nexora_id = 'NXR-BACKUP01';
INSERT INTO delivery_participants (delivery_id, user_id, role)
  SELECT d.id, u.id, 'sender' FROM deliveries d, users u
  WHERE d.public_ref = 'NXD-BKPTEST' AND u.nexora_id = 'NXR-BACKUP01';
INSERT INTO delivery_status_history (delivery_id, from_status, to_status, actor_id)
  SELECT d.id, NULL, 'CREATED', u.id FROM deliveries d, users u
  WHERE d.public_ref = 'NXD-BKPTEST' AND u.nexora_id = 'NXR-BACKUP01';
SQL
echo "[backup-test] seeded synthetic records into $SRC_DB"

count() { # count <db> <table>
  psql "$PGURL_BASE/$1" -tA -c "SELECT count(*) FROM $2;"
}
for t in users conversations messages deliveries delivery_status_history; do
  echo "[backup-test] source $t: $(count "$SRC_DB" "$t")"
done

echo "[backup-test] dumping $SRC_DB -> $BACKUP_FILE"
pg_dump "$PGURL_BASE/$SRC_DB" -f "$BACKUP_FILE"
if [[ ! -s "$BACKUP_FILE" ]]; then echo "[backup-test] FAIL: backup file is empty or missing" >&2; exit 1; fi
echo "[backup-test] backup file: $BACKUP_FILE ($(stat -c%s "$BACKUP_FILE") bytes, non-empty: OK)"

su postgres -c "dropdb --if-exists $RESTORE_DB" >/dev/null
su postgres -c "createdb -O nexora $RESTORE_DB" >/dev/null
echo "[backup-test] restoring into empty $RESTORE_DB"
psql "$PGURL_BASE/$RESTORE_DB" -v ON_ERROR_STOP=1 -q -f "$BACKUP_FILE" >/dev/null
echo "[backup-test] restore complete"

FAIL=0
for t in users conversations messages deliveries delivery_status_history; do
  before=$(count "$SRC_DB" "$t"); after=$(count "$RESTORE_DB" "$t")
  echo "[backup-test] $t: source=$before restored=$after"
  if [[ "$before" != "$after" ]]; then echo "[backup-test] FAIL: $t count mismatch" >&2; FAIL=1; fi
done
# Spot-check the synthetic rows exist in the restored DB (counts only).
probe_users=$(psql "$PGURL_BASE/$RESTORE_DB" -tA -c "SELECT count(*) FROM users WHERE nexora_id='NXR-BACKUP01';")
probe_msgs=$(psql "$PGURL_BASE/$RESTORE_DB" -tA -c "SELECT count(*) FROM messages WHERE body='backup-restore probe message';")
echo "[backup-test] restored seed user rows: $probe_users, restored seed message rows: $probe_msgs"
if [[ "$probe_users" != "1" || "$probe_msgs" != "1" ]]; then echo "[backup-test] FAIL: seed rows missing after restore" >&2; FAIL=1; fi
if [[ "$FAIL" == "1" ]]; then exit 1; fi

# Boot the real app against the RESTORED database and exercise it.
echo "[backup-test] booting app against restored DB on :$APP_PORT"
export NODE_ENV=production PORT="$APP_PORT" STORAGE_DIR=/tmp/nexora-restore-storage
export DATABASE_URL="$PGURL_BASE/$RESTORE_DB"
export CODE_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
mkdir -p "$STORAGE_DIR"
node backend/src/server.js >"$APP_LOG" 2>&1 &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null || true' EXIT
HEALTH_OK=0
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$APP_PORT/api/health" | grep -q '"database":"up"'; then HEALTH_OK=1; break; fi
  sleep 1
done
if [[ "$HEALTH_OK" != "1" ]]; then echo "[backup-test] FAIL: app did not reach healthy state on restored DB" >&2; cat "$APP_LOG" >&2; exit 1; fi
echo "[backup-test] /api/health on restored DB: database=up"
# One authenticated read: fresh anonymous session, then GET /api/auth/me.
node - "$APP_PORT" <<'NODE'
const port = process.argv[2];
const base = `http://127.0.0.1:${port}`;
const jar = {};
async function req(method, path, body, csrf) {
  const headers = { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';'); const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}
const csrfRes = await req('GET', '/api/auth/csrf');
const anon = await req('POST', '/api/auth/anonymous', { displayName: 'RestoreProbe' }, csrfRes.json.data.csrfToken);
console.log(`[backup-test] anonymous on restored DB: ${anon.status}`);
const me = await req('GET', '/api/auth/me');
console.log(`[backup-test] authenticated GET /api/auth/me on restored DB: ${me.status} (user present: ${!!me.json?.data?.user})`);
if (anon.status !== 200 || me.status !== 200) { console.error('[backup-test] FAIL: authenticated read on restored DB'); process.exit(1); }
NODE
kill $APP_PID 2>/dev/null || true
trap - EXIT
echo "[backup-test] app check on restored DB: OK"

if [[ "${KEEP_ARTIFACTS:-}" != "1" ]]; then
  su postgres -c "dropdb --if-exists $RESTORE_DB" >/dev/null
  echo "[backup-test] cleaned up restored DB $RESTORE_DB (backup file kept at $BACKUP_FILE)"
else
  echo "[backup-test] KEEP_ARTIFACTS=1: restored DB $RESTORE_DB and $BACKUP_FILE kept"
fi
echo "[backup-test] ALL GREEN"
