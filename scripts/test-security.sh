#!/bin/bash
# NEXORA security regression suite (Phase 4, 2026-10-25).
# Runs the security2-*.test.js files SEQUENTIALLY, one process per file.
# Sequential matters: running all six in one node --test glob hung once
# when the files shared a single real-PostgreSQL database (a leaked-socket
# case deadlocked server.close()). Sequential per-file runs are reliable.
#
# Usage:
#   bash scripts/test-security.sh            # pg-mem path (default)
#   NEXORA_TEST_DATABASE_URL=postgres://nexora:nexora-dev-only@127.0.0.1:5432/nexora_security bash scripts/test-security.sh
#                                           # real PostgreSQL path (preferred
#                                           # for revocation/expiry/FK checks)
set -u
cd "$(dirname "$0")/.."
FAIL=0
for f in backend/tests/integration/security2-*.test.js; do
  echo "=== $f ==="
  if ! node --test "$f"; then FAIL=1; echo "FAILED: $f"; fi
done
if [ "$FAIL" -eq 1 ]; then echo "SECURITY SUITE: FAILURES PRESENT"; exit 1; fi
echo "SECURITY SUITE: ALL GREEN"
