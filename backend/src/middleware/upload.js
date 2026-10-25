// Upload handling: multer in memory, then magic-byte signature verification
// (never trust MIME type or filename), size limits, and an opaque storage key.
// Files land under STORAGE_DIR/<first-2-hex-chars>/<uuid> — never a
// user-supplied path, so path traversal is impossible by construction.
import multer from 'multer';
import { config, storageDir } from '../config.js';
import { badRequest } from '../utils/helpers.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

const ALLOWED = [
  { mime: 'image/jpeg', sigs: [[0, Buffer.from([0xff, 0xd8, 0xff])]] },
  { mime: 'image/png', sigs: [[0, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]] },
  { mime: 'image/webp', sigs: [[0, Buffer.from('RIFF')], [8, Buffer.from('WEBP')]] },
  { mime: 'image/gif', sigs: [[0, Buffer.from('GIF87a')], [0, Buffer.from('GIF89a')]] },
  { mime: 'video/mp4', sigs: [[4, Buffer.from('ftyp')]] },
  { mime: 'application/pdf', sigs: [[0, Buffer.from('%PDF')]] },
];

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

// A file is accepted only if ALL of a type's required signatures match, except
// GIF where either signature suffices (handled by trying each entry: GIF has
// two single-signature entries below via the alt list).
export function detectMime(buf) {
  const gif = [Buffer.from('GIF87a'), Buffer.from('GIF89a')];
  if (gif.some((g) => buf.subarray(0, g.length).equals(g))) return 'image/gif';
  for (const entry of ALLOWED) {
    if (entry.mime === 'image/gif') continue;
    if (entry.sigs.every(([off, sig]) => buf.subarray(off, off + sig.length).equals(sig))) {
      return entry.mime;
    }
  }
  return null;
}

export async function storePrivateFile(buffer, mime) {
  const id = randomUUID();
  const key = `${id.slice(0, 2)}/${id}`;
  const full = path.join(storageDir(), key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer, { mode: 0o600 });
  return { storageKey: key, fullPath: full };
}

export async function validateUpload(file) {
  if (!file) throw badRequest('No file uploaded');
  const mime = detectMime(file.buffer);
  if (!mime) throw badRequest('File type not allowed or not recognized', 'UNSUPPORTED_FILE');
  return mime;
}
