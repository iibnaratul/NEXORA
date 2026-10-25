# NEXORA — Backup & restore (Phase 3, 2026-10-25)

## What to back up

1. **PostgreSQL database** — everything the app knows (users, sessions,
   conversations, messages, deliveries, status history, handover-code
   ciphertext, audit logs). A database-only backup is sufficient to restore
   the app's data, but not its files.
2. **`STORAGE_DIR`** (default `./storage`, in compose the `./storage` bind
   mount) — private uploaded files referenced by `private_file_metadata`
   rows. A database restore without the matching storage directory leaves
   file downloads dangling. Back both up together and restore them together.
3. **Secrets, separately** — `CODE_ENCRYPTION_KEY` and the database password
   live in the secret store / `.env` (never committed, never in a backup
   file). A restore is useless without the *same* `CODE_ENCRYPTION_KEY`:
   outstanding handover codes are AES-256-GCM ciphertext under that key and
   cannot be decrypted with a different one (see `docs/DEPLOYMENT.md` §1).

## Procedure (logical backup, the supported path)

```bash
# 1. Dump (run from the database host, or exec into the db container):
pg_dump "postgres://<user>:<password>@<db-host>:5432/<db>" -f nexora-backup.sql
#    -f writes a plain-SQL dump; -Fc (custom format) is equally valid and
#    restores with pg_restore instead of psql. Plain SQL was verified here.

# 2. Verify the dump is non-empty before you trust it:
test -s nexora-backup.sql && echo "dump OK ($(stat -c%s nexora-backup.sql) bytes)"

# 3. Restore into an EMPTY database (never over a live one):
createdb -O <user> <restored-db>
psql "postgres://<user>:<password>@<db-host>:5432/<restored-db>" -f nexora-backup.sql

# 4. Integrity check — counts must match, per table:
for t in users conversations messages deliveries delivery_status_history; do
  echo -n "$t: "
  psql -tA -c "SELECT count(*) FROM $t;" "postgres://<user>:<password>@<db-host>:5432/<db>"
  psql -tA -c "SELECT count(*) FROM $t;" "postgres://<user>:<password>@<db-host>:5432/<restored-db>"
done
# Also confirm schema_migrations has 001_init, 002_message_client_id,
# 003_history_seq, then boot the app against the restored DB and check
# /api/health reports "database":"up" plus one authenticated read.

# 5. Cut over only after step 4 passes: point DATABASE_URL at the restored
#    database (or rename databases), restore STORAGE_DIR alongside it, and
#    restart the app with the ORIGINAL CODE_ENCRYPTION_KEY.
```

For a container deployment, the same commands run as
`docker compose exec db pg_dump ...` / `docker compose exec -T db psql ...`,
with the dump file copied out via `docker compose cp`.

## Automated verification

`scripts/backup-restore-test.sh` runs the whole loop against disposable
databases and exits non-zero on any mismatch:

```bash
bash scripts/backup-restore-test.sh
# Optional: SRC_DB=nexora_deploy RESTORE_DB=nexora_restore_test APP_PORT=3103
#           KEEP_ARTIFACTS=1 bash scripts/backup-restore-test.sh
```

It seeds one synthetic record per checked table (user, room, message,
delivery, status-history row), dumps the source, restores into a separate
empty database, compares row counts, boots the real app in
`NODE_ENV=production` against the restored database, and checks
`/api/health` (`database: up`) plus an authenticated `GET /api/auth/me`.
It refuses to run against `nexora_test` or `nexora` unless
`BACKUP_ALLOW_ANY_DB=1` is set, and it prints **counts only** — never record
contents, tokens, or hashes.

### Evidence from the 2026-10-25 run

Source: disposable host database `nexora_deploy` (already holding the
Phase 3 deploy-check rows). Dump: `/tmp/nexora-backup-test-20261025134815.sql`,
37,508 bytes, non-empty. Restored into fresh `nexora_restore_test`:

| Table | Source | Restored |
|---|---|---|
| users | 5 | 5 |
| conversations | 2 | 2 |
| messages | 2 | 2 |
| deliveries | 1 | 1 |
| delivery_status_history | 1 | 1 |

Restored seed rows present (1 user, 1 message). App booted against the
restored DB: `/api/health` → `database: up`; anonymous registration → 200;
authenticated `GET /api/auth/me` → 200. Script result: `ALL GREEN`. The
restored database was dropped afterwards by the script; the dump file was
kept under `/tmp` for inspection.

## Retention, encryption-at-rest, and access control

- **Retention**: keep at least one daily dump for 30 days and one weekly dump
  for 90 days (adjust to your data policy). Old dumps contain the same
  personal data as the live database (messages, delivery areas, audit logs),
  so retention is also a deletion obligation: purge dumps on schedule, don't
  accumulate them.
- **Encryption-at-rest**: `pg_dump` output is plaintext SQL. Encrypt dumps
  before they leave the database host (e.g. `gpg --symmetric` with a key
  from the secret store, or a filesystem/volume that is encrypted at rest),
  and never store an unencrypted dump in object storage, a shared drive, or
  a repository. The dump contains password *hashes* (bcrypt) and handover
  *ciphertext* — neither is plaintext credentials, but both are sensitive
  and must be treated as such.
- **Access control**: dumps are readable only by the operator role that owns
  the database; no application user, courier, or support account ever gets
  dump access. Audit every restore (who, when, source, target) in the
  operator log — restores are privileged operations, not routine reads.
- **Scheduling**: run dumps from cron/systemd on the database host (or a
  backup sidecar), not from the app container, and alert on dump failure or
  on a dump smaller than the previous day's by an unexpected margin. A
  backup that is never restore-tested is a hope, not a backup — run
  `scripts/backup-restore-test.sh` (or your equivalent against a scratch
  database) on a schedule, e.g. weekly.

## Recovery limitations (honest list)

- **Point-in-time recovery is NOT provided by this procedure.** A nightly
  `pg_dump` restores you to the last dump, not to five minutes ago. For
  PITR you need continuous WAL archiving (`archive_mode = on` + a WAL
  archive) and a tested PITR runbook — not set up here.
- **File uploads are a separate restore.** If `STORAGE_DIR` is not restored
  alongside the database, message/delivery attachments 404 even though
  their metadata rows exist.
- **Sessions survive a restore** (they are database rows), but only if the
  restore target is then served with the same cookie domain and the same
  app configuration; sessions whose `expires_at` passed during the outage
  are dead on arrival, which is correct behaviour.
- **Handover codes survive only with the original key.** Rotating
  `CODE_ENCRYPTION_KEY` between backup and restore invalidates outstanding
  codes (see `docs/DEPLOYMENT.md` §1).
- **Restores are destructive to the target.** Never restore over a live
  database: restore into an empty database, verify counts, then cut over.
  The test script enforces this by refusing the known live/test database
  names.
