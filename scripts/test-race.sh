#!/bin/bash
# NEXORA courier race-condition test (Phase 6, 2026-10-25).
# MUST run against real PostgreSQL: pg-mem serializes requests on one thread
# and cannot prove the row-lock behavior of the conditional-UPDATE claim.
# Uses a disposable database (nexora_race); never touches nexora_test.
#
# Usage: bash scripts/test-race.sh
# Prerequisites: local PostgreSQL 16, role nexora, superuser access via
# `su postgres` for database recreation.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v psql >/dev/null || { echo "psql not found — real PostgreSQL is required for the race test" >&2; exit 1; }
su postgres -c "dropdb --if-exists nexora_race" >/dev/null
su postgres -c "createdb -O nexora nexora_race" >/dev/null
NEXORA_TEST_DATABASE_URL="postgres://nexora:nexora-dev-only@127.0.0.1:5432/nexora_race" \
  node --test backend/tests/integration/courierRace.test.js
echo "RACE SUITE: ALL GREEN (20 rounds, exactly one winner per round)"
