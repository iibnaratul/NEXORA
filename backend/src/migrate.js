// Applies every SQL file in database/migrations/ in filename order, once,
// recording each in schema_migrations. Idempotent: re-running is safe.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../database/migrations');

function splitStatements(sql) {
  // Migrations contain no semicolons inside string literals or dollar-quoting,
  // so splitting on semicolon-terminated lines is safe here.
  return sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

export async function migrate() {
  const pool = getPool();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])
      .catch(async (e) => {
        if (e.code === '42P01') { // schema_migrations itself doesn't exist yet
          await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
          return { rows: [] };
        }
        throw e;
      });
    if (done.rows.length) { console.log(`[migrate] ${file} (already applied)`); continue; }
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const stmt of splitStatements(sql)) await client.query(stmt);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log(`[migrate] ${file} applied`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(async () => { console.log('[migrate] done'); await closePool(); })
    .catch(async (e) => { console.error('[migrate] FAILED:', e.message); await closePool(); process.exit(1); });
}
