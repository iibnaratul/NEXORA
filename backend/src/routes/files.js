// Private file uploads/downloads. Uploads are authorized, signature-checked,
// and stored under opaque keys. Downloads require BOTH a valid signed URL
// (short-lived) AND a fresh authorization check — a leaked URL alone is not
// enough after expiry, and an unexpired URL still cannot escape its scope.
import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { config, storageDir } from '../config.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../utils/helpers.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import { upload, validateUpload, storePrivateFile } from '../middleware/upload.js';
import { requireFileAccess } from '../services/authz.js';
import { verifyDownloadSignature, signedDownloadUrl } from '../services/storage.js';
import { getConversationOr404, requireConversationAccess, assertUuid } from '../services/authz.js';

// Filenames are untrusted metadata: NUL/control bytes break the Postgres
// text insert (500) and can corrupt the download disposition header.
function safeOriginalName(name) {
  return String(name || '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 200);
}

export const filesRouter = Router();

// Upload for a conversation (message attachment). The file is scoped to the
// conversation; attaching it to a message is a separate, authorized step.
filesRouter.post('/conversations/:id/upload', requireAuth, requireCsrf, uploadLimiter, upload.single('file'),
  asyncHandler(async (req, res) => {
    const conv = await getConversationOr404(req.params.id);
    await requireConversationAccess(conv, req.user, { forSend: true });
    const mime = await validateUpload(req.file);
    const { storageKey } = await storePrivateFile(req.file.buffer, mime);
    const id = randomUUID();
    await query(
      `INSERT INTO private_file_metadata (id, owner_id, original_name, mime_type, size_bytes, storage_key, scope_type, scope_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'message', $7)`,
      [id, req.user.id, safeOriginalName(req.file.originalname), mime, req.file.size, storageKey, conv.id],
    );
    res.status(201).json({ ok: true, data: { id, mimeType: mime, downloadUrl: signedDownloadUrl(id) } });
  }));

// Parcel photo for a delivery (sender, before pickup is verified).
// This is the ONE photo upload route the frontend reuses for marketplace
// drop-off photos: POST /api/files/deliveries/:id/photo (mounted under
// /api/files, upload.single('file')). The response field carrying the file
// id is `id`; the frontend passes that id as dropoffPhotoFileId to
// PATCH /api/deliveries/:id/dropoff. For marketplace deliveries the upload
// sets dropoff_photo_file_id (not the courier parcel photo_file_id); for
// courier deliveries it sets photo_file_id exactly as before.
filesRouter.post('/deliveries/:id/photo', requireAuth, requireCsrf, uploadLimiter, upload.single('file'),
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id);
    const { rows } = await query('SELECT * FROM deliveries WHERE id = $1', [req.params.id]);
    if (!rows.length) throw notFound('Delivery not found');
    const d = rows[0];
    if (d.sender_id !== req.user.id && req.user.role !== 'admin') {
      throw forbidden('Only the sender can add a parcel photo');
    }
    if (['PICKUP_VERIFIED', 'IN_TRANSIT', 'DROPOFF_VERIFIED', 'DELIVERED', 'CANCELLED'].includes(d.status)) {
      throw badRequest('Parcel photo can no longer be changed at this stage');
    }
    const mime = await validateUpload(req.file);
    if (!mime.startsWith('image/')) throw badRequest('Parcel photo must be an image');
    const { storageKey } = await storePrivateFile(req.file.buffer, mime);
    const id = randomUUID();
    await query(
      `INSERT INTO private_file_metadata (id, owner_id, original_name, mime_type, size_bytes, storage_key, scope_type, scope_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'delivery_photo', $7)`,
      [id, req.user.id, safeOriginalName(req.file.originalname), mime, req.file.size, storageKey, d.id],
    );
    if (d.fulfillment === 'marketplace') {
      await query('UPDATE deliveries SET dropoff_photo_file_id = $1, updated_at = now() WHERE id = $2', [id, d.id]);
    } else {
      await query('UPDATE deliveries SET photo_file_id = $1, updated_at = now() WHERE id = $2', [id, d.id]);
    }
    res.status(201).json({ ok: true, data: { id, mimeType: mime, downloadUrl: signedDownloadUrl(id) } });
  }));

// Signed-URL issuance (re-issue after expiry) — authorization checked here too.
filesRouter.get('/:id/url', requireAuth, asyncHandler(async (req, res) => {
  assertUuid(req.params.id);
  const { rows } = await query('SELECT * FROM private_file_metadata WHERE id = $1', [req.params.id]);
  if (!rows.length) throw notFound('File not found');
  await requireFileAccess(rows[0], req.user);
  res.json({ ok: true, data: { downloadUrl: signedDownloadUrl(rows[0].id) } });
}));

// Download: signature + expiry + authorization, then stream. No auth cookie
// is needed here (the signature is the bearer), which is why expiry is short.
filesRouter.get('/:id/download', asyncHandler(async (req, res) => {
  assertUuid(req.params.id);
  const { rows } = await query('SELECT * FROM private_file_metadata WHERE id = $1', [req.params.id]);
  if (!rows.length) throw notFound('File not found');
  const file = rows[0];
  if (!verifyDownloadSignature(file.id, req.query.exp, req.query.sig)) {
    return res.status(403).json({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Download link is invalid or expired' } });
  }
  // The signature alone is not authorization: the requester must still be in
  // scope. The download URL is issued to an authenticated user, so require a
  // valid session here as well and re-check scope.
  const { loadSession } = await import('../middleware/auth.js');
  const session = await loadSession(req);
  if (!session) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  try {
    await requireFileAccess(file, session.user);
  } catch (e) {
    return res.status(e.status || 403).json({ ok: false, error: { code: e.code || 'FORBIDDEN', message: e.message } });
  }
  const full = path.join(storageDir(), file.storage_key);
  try {
    const data = await fs.readFile(full);
    res.type(file.mime_type);
    res.set('Content-Disposition', `attachment; filename="${file.original_name.replace(/["\r\n\u0000-\u001F\u007F]/g, '')}"`);
    res.set('Cache-Control', 'private, no-store');
    res.send(data);
  } catch {
    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Stored file is missing' } });
  }
}));

export default filesRouter;
