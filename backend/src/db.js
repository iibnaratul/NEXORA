// PostgreSQL access via node-postgres. Every query is parameterized — no
// string-interpolated SQL anywhere in the codebase (grep for it in review).
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// Tests may inject a pg-mem pool via setPool(); production always uses DATABASE_URL.
let pool = null;
export function setPool(p) { pool = p; }
export function getPool() {
  if (!pool) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set. Copy .env.example to .env and set it.');
    }
    pool = new Pool({ connectionString: config.databaseUrl });
    pool.on('error', (e) => console.error('[nexora] idle pg client error', e.message));
  }
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}
