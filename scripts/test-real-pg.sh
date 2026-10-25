#!/bin/bash
# Runs every test file against REAL PostgreSQL 16 (not pg-mem).
# Each file gets a freshly recreated database, so files cannot pollute each other.
# Prerequisites: local PostgreSQL 16 running, role nexora / password nexora-dev-only
# (dev-only credentials — see .env.example for production guidance).
# Usage: bash scripts/test-real-pg.sh
set -e
cd "$(dirname "$0")/.."
export NEXORA_TEST_DATABASE_URL="postgres://nexora:nexora-dev-only@127.0.0.1:5432/nexora_test"
# NOTE: AUTH_RATE_LIMIT_MAX is deliberately NOT raised here — rateLimits.test.js
# relies on the production default (10/min). auth.test.js raises it for itself
# in its own before() hook.
FAIL=0
for f in backend/tests/unit/*.test.js backend/tests/integration/*.test.js e2e/*.test.js; do
  echo "=== $f (fresh database) ==="
  su postgres -c "dropdb --if-exists nexora_test" >/dev/null
  su postgres -c "createdb -O nexora nexora_test" >/dev/null
  if ! node --test "$f"; then FAIL=1; echo "FAILED: $f"; fi
done
if [ "$FAIL" -eq 1 ]; then echo "REAL-PG SUITE: FAILURES PRESENT"; exit 1; fi
echo "REAL-PG SUITE: ALL GREEN"
