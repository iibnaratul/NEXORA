// Shared test harness.
// Integration tests run against pg-mem (an in-memory PostgreSQL emulator)
// ONLY because no real PostgreSQL server is available in this environment
// (see docs/VERIFICATION_REPORT.md). The same migration SQL files are applied
// to pg-mem as to real PostgreSQL, and the app always passes explicit UUIDs,
// so the only pg-mem-specific shim is registering gen_random_uuid (used only
// in column defaults the app never relies on).
import { newDb } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../database/migrations');

function splitStatements(sql) {
  return sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

export async function createTestDb() {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid', args: [], returns: 'uuid',
    implementation: () => randomUUID(),
  });
  // pg-mem implements very few native functions; the migration uses
  // char_length() in CHECK constraints, so register the obvious equivalent.
  db.public.registerFunction({
    name: 'char_length', args: ['text'], returns: 'int',
    implementation: (s) => (s === null || s === undefined ? 0 : String(s).length),
  });
  // Same class of shim: GET /api/conversations (list) uses NULLIF() in its
  // DM-partner query, which pg-mem does not implement. Real PostgreSQL has
  // NULLIF natively, so this is a test-emulator gap, not an app bug: without
  // it the list endpoint 500s on pg-mem whenever a DM partner row exists.
  db.public.registerFunction({
    name: 'nullif', args: ['text', 'text'], returns: 'text',
    implementation: (a, b) => (a === b ? null : a),
  });
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    for (const stmt of splitStatements(sql)) {
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(stmt)) {
        db.public.none(stmt);
        continue;
      }
      db.public.none(stmt);
    }
    db.public.none(`INSERT INTO schema_migrations (version) VALUES ('${file.replace(/\.sql$/, '')}')`);
  }
  return db;
}

export async function startTestServer() {
  process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-test-'));
  const { setPool, closePool } = await import('../src/db.js');
  if (process.env.NEXORA_TEST_DATABASE_URL) {
    // Real PostgreSQL path (see scripts/test-real-pg.sh): the caller recreates
    // a fresh database per test file, then the real migration files are applied.
    const pg = await import('pg');
    setPool(new pg.Pool({ connectionString: process.env.NEXORA_TEST_DATABASE_URL }));
    const { migrate } = await import('../src/migrate.js');
    await migrate();
    const { createApp } = await import('../src/server.js');
    const { createSocketServer } = await import('../src/realtime/socket.js');
    const app = createApp();
    const server = http.createServer(app);
    const io = createSocketServer(server);
    app.set('io', io);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      async close() {
        await new Promise((resolve) => server.close(resolve));
        io.close();
        await closePool();
        fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
      },
    };
  }
  const db = await createTestDb();
  const { Pool } = db.adapters.createPg();
  setPool(new Pool());
  const { createApp } = await import('../src/server.js');
  const { createSocketServer } = await import('../src/realtime/socket.js');
  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  app.set('io', io);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      io.close();
      await closePool();
      fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
    },
  };
}

// Minimal cookie-jar HTTP client (cookie sessions + CSRF double-submit).
export class Session {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = {};
    this.csrf = null;
    this.user = null;
  }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  storeCookies(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  async req(method, path, body, { form = false } = {}) {
    const headers = { Cookie: this.cookieHeader() };
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf;
    const res = await fetch(this.baseUrl + path, {
      method, headers,
      body: body === undefined ? undefined : (form ? body : JSON.stringify(body)),
    });
    this.storeCookies(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  async initCsrf() {
    const r = await this.req('GET', '/api/auth/csrf');
    this.csrf = r.json?.data?.csrfToken;
    return r;
  }
  async anonymous(displayName = '') {
    const r = await this.req('POST', '/api/auth/anonymous', { displayName });
    if (r.status === 200) { this.user = r.json.data.user; this.csrf = r.json.data.csrfToken; }
    return r;
  }
  async register(email, password, displayName = '') {
    const r = await this.req('POST', '/api/auth/register', { email, password, displayName });
    if (r.status === 200) { this.user = r.json.data.user; this.csrf = r.json.data.csrfToken; }
    return r;
  }
  async login(email, password) {
    const r = await this.req('POST', '/api/auth/login', { email, password });
    if (r.status === 200) { this.user = r.json.data.user; this.csrf = r.json.data.csrfToken; }
    return r;
  }
}

export function pngBytes() {
  // Minimal valid 1x1 PNG (magic bytes + structure).
  return Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
}
