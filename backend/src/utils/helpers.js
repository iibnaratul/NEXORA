// Small shared helpers. Nothing here touches the network or the database.
import { randomBytes, randomInt, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (m, code = 'VALIDATION_ERROR') => new ApiError(400, code, m);
export const unauthorized = (m = 'Authentication required', code = 'UNAUTHORIZED') => new ApiError(401, code, m);
export const forbidden = (m = 'Not allowed', code = 'FORBIDDEN') => new ApiError(403, code, m);
export const notFound = (m = 'Not found', code = 'NOT_FOUND') => new ApiError(404, code, m);
export const conflict = (m, code = 'CONFLICT') => new ApiError(409, code, m);
export const notConfigured = (m, code = 'NOT_CONFIGURED') => new ApiError(503, code, m);

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function ok(res, data, meta) {
  return res.json({ ok: true, data, ...(meta ? { meta } : {}) });
}
export function created(res, data) {
  return res.status(201).json({ ok: true, data });
}

const NEXORA_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/1/I/O/L, matches the original
export function newNexoraId() {
  const bytes = randomBytes(8);
  return 'NXR-' + [...bytes].map((b) => NEXORA_ALPHABET[b % NEXORA_ALPHABET.length]).join('');
}
export function newPublicRef() {
  const bytes = randomBytes(6);
  return 'NXD-' + [...bytes].map((b) => NEXORA_ALPHABET[b % NEXORA_ALPHABET.length]).join('');
}
export function randomToken(bytes = 32) { return randomBytes(bytes).toString('hex'); }
export function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

// Six-digit handover code, crypto-random (the original used the same approach).
export function newCode() { return String(randomInt(0, 1_000_000)).padStart(6, '0'); }

// AES-256-GCM envelope: base64(iv[12] | tag[16] | ciphertext). The code is
// never stored in plaintext; the sender can re-view it only via an authorized
// endpoint that decrypts it. Verification decrypts and constant-time compares.
export function encryptCode(code) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.codeEncryptionKey, iv);
  const ct = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}
export function decryptCode(enc) {
  const buf = Buffer.from(enc, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', config.codeEncryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
export function codesEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function parsePagination(req, { maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}
export function pageMeta(page, limit, total) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

// Minimal cookie parser (avoids an extra dependency). Values are never trusted.
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
