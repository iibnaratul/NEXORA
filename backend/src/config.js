// Environment-based configuration. No secrets are hardcoded; production values
// come from the environment (see .env.example). Anything marked "dev only"
// refuses to run in production.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src -> project root (two levels up).
const root = path.resolve(__dirname, '../..');

function reqInProd(name) {
  const v = process.env[name];
  if (process.env.NODE_ENV === 'production' && !v) {
    throw new Error(`Missing required production environment variable: ${name}`);
  }
  return v;
}

let codeKey = process.env.CODE_ENCRYPTION_KEY || '';
if (!codeKey) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CODE_ENCRYPTION_KEY is required in production (64 hex chars, 32 bytes).');
  }
  // Dev-only ephemeral key: codes encrypted with it cannot survive a restart.
  // That is intentional — it makes "works on my machine" impossible to mistake
  // for a production setup.
  codeKey = randomBytes(32).toString('hex');
  console.warn('[nexora] CODE_ENCRYPTION_KEY not set — using an ephemeral dev key.');
}
if (!/^[0-9a-fA-F]{64}$/.test(codeKey)) {
  throw new Error('CODE_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
}

export const config = {  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  // Production fail-fast (added 2026-10-25, Phase 3): a production server
  // must never boot into the "database: DOWN" degraded mode that development
  // tolerates (server.js logs it and keeps serving). Without a database every
  // data endpoint fails, so refusing to boot is safer than serving a broken
  // API. Development/test keep the old behaviour (empty string -> db.js
  // throws only when a query is actually attempted).
  databaseUrl: reqInProd('DATABASE_URL') || '',
  sessionCookie: process.env.SESSION_COOKIE_NAME || 'nx_session',
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 7),
  csrfCookie: 'nx_csrf',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  codeEncryptionKey: Buffer.from(codeKey, 'hex'),
  codeTtlHours: Number(process.env.CODE_TTL_HOURS || 24),
  codeMaxAttempts: Math.max(1, Number(process.env.CODE_MAX_ATTEMPTS || 5) || 5),
  storageDir: process.env.STORAGE_DIR || path.join(root, 'storage'),
  storageProvider: process.env.STORAGE_PROVIDER || 'local', // 'local' only; 's3' is documented, not wired
  mapsProvider: process.env.MAPS_PROVIDER || '', // '' = none configured
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024,
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: process.env.TRUST_PROXY === 'true',
  root,
};
export const isProd = config.env === 'production';

// Resolved lazily so tests can point storage at a temp dir via STORAGE_DIR
// without re-importing the config module.
export function storageDir() {
  return process.env.STORAGE_DIR || config.storageDir;
}
