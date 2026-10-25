// Test-only server entrypoint for Playwright browser tests.
// Reuses backend/tests/helpers.js startTestServer() verbatim (real Express +
// Socket.IO app, same migrations). Preferred DB: real PostgreSQL database
// nexora_browser; falls back to pg-mem only if the real-PostgreSQL boot
// fails. Writes tests/browser/.server.json with the ephemeral baseUrl + which
// DB actually ran, then stays alive until SIGTERM. Rate limits are raised via
// test-only env vars so a full browser suite does not trip the per-minute
// auth/api limits (these vars are read per request). Never logs cookies,
// tokens, codes or passwords.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from '../../backend/tests/helpers.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const infoPath = path.join(dir, '.server.json');

process.env.AUTH_RATE_LIMIT_MAX ??= '1000';
process.env.API_RATE_LIMIT_MAX ??= '10000';
process.env.MESSAGE_RATE_LIMIT_MAX ??= '1000';
process.env.DELIVERY_RATE_LIMIT_MAX ??= '10000';
process.env.UPLOAD_RATE_LIMIT_MAX ??= '1000';

const REAL_URL = 'postgresql://nexora:nexora-dev-only@127.0.0.1:5432/nexora_browser';
let server = null;
let dbMode = null;

async function boot() {
  process.env.NEXORA_TEST_DATABASE_URL = REAL_URL;
  try {
    server = await startTestServer();
    dbMode = 'real-postgresql:nexora_browser';
    console.log(`[browser-serve] up on ${server.baseUrl} (${dbMode})`);
  } catch (e) {
    console.error(`[browser-serve] real PostgreSQL boot failed (${e.message}); falling back to pg-mem`);
    try {
      const { closePool } = await import('../../backend/src/db.js');
      await closePool();
    } catch { /* best effort */ }
    delete process.env.NEXORA_TEST_DATABASE_URL;
    server = await startTestServer();
    dbMode = 'pg-mem-fallback';
    console.log(`[browser-serve] up on ${server.baseUrl} (${dbMode})`);
  }
  fs.writeFileSync(infoPath, JSON.stringify({
    baseUrl: server.baseUrl, dbMode, pid: process.pid, startedAt: new Date().toISOString(),
  }, null, 2));
  const r = await fetch(`${server.baseUrl}/api/health`);
  if (!r.ok) throw new Error(`health probe failed: ${r.status}`);
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[browser-serve] shutting down (${signal})`);
  try { if (server) await server.close(); } catch (e) { console.error('[browser-serve] close error', e.message); }
  try { fs.unlinkSync(infoPath); } catch { /* already gone */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await boot();
