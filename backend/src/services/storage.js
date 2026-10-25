// Private file downloads: short-lived HMAC-signed URLs, issued only after an
// authorization check. There are no permanent public object URLs for private
// content. The signature covers file id + expiry; the download endpoint
// re-checks authorization before streaming.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const SIGN_TTL_MS = 15 * 60 * 1000;

function sign(fileId, exp) {
  return createHmac('sha256', config.codeEncryptionKey)
    .update(`${fileId}:${exp}`)
    .digest('hex');
}

export function signedDownloadUrl(fileId) {
  const exp = Date.now() + SIGN_TTL_MS;
  return `/api/files/${fileId}/download?exp=${exp}&sig=${sign(fileId, exp)}`;
}

export function verifyDownloadSignature(fileId, exp, sig) {
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = sign(fileId, Number(exp));
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
