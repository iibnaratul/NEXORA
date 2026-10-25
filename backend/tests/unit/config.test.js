// Production fail-fast config tests (Phase 3, 2026-10-25).
// config.js reads the environment at import time, so each case runs in a
// fresh node subprocess importing the real config module — no env mutation
// of the test runner itself. No secrets are asserted or printed; the key
// used here is a fixed, obviously-fake hex string, never a real secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/config.js');
const FAKE_KEY = '0123456789abcdef'.repeat(4); // 64 hex chars, test-only
const FAKE_DB = 'postgres://nexora:placeholder@127.0.0.1:5432/nexora';

function runConfig(env) {
  const childEnv = { ...process.env, ...env };
  for (const k of ['DATABASE_URL', 'CODE_ENCRYPTION_KEY']) {
    if (!(k in env)) delete childEnv[k];
  }
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(configPath)})`], {
    env: childEnv, encoding: 'utf8',
  });
}

test('production refuses to boot without CODE_ENCRYPTION_KEY (pre-existing behaviour)', () => {
  const r = runConfig({ NODE_ENV: 'production', DATABASE_URL: FAKE_DB });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /CODE_ENCRYPTION_KEY is required in production/);
});

test('production refuses to boot without DATABASE_URL (Phase 3 fix)', () => {
  const r = runConfig({ NODE_ENV: 'production', CODE_ENCRYPTION_KEY: FAKE_KEY });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Missing required production environment variable: DATABASE_URL/);
});

test('production refuses a malformed CODE_ENCRYPTION_KEY', () => {
  const r = runConfig({ NODE_ENV: 'production', DATABASE_URL: FAKE_DB, CODE_ENCRYPTION_KEY: 'short' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /CODE_ENCRYPTION_KEY must be 64 hex characters/);
});

test('production boots when both mandatory variables are present', () => {
  const r = runConfig({ NODE_ENV: 'production', DATABASE_URL: FAKE_DB, CODE_ENCRYPTION_KEY: FAKE_KEY });
  assert.equal(r.status, 0, r.stderr);
});

test('development still boots without either variable (ephemeral dev key)', () => {
  const r = runConfig({ NODE_ENV: 'development' });
  assert.equal(r.status, 0, r.stderr);
});
