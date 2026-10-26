// NEXORA TRANSIT: parcel creation, atomic courier claim, server-validated
// state transitions, one-time handover codes, QR order references, disputes,
// and status history. Every transition is checked against the state machine
// and recorded; a modified client cannot skip steps.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { schemas, validate } from '../validation/schemas.js';
import {
  ok, created, asyncHandler, badRequest, forbidden, notFound, conflict,
  parsePagination, pageMeta, newPublicRef, newCode, encryptCode, decryptCode, codesEqual,
} from '../utils/helpers.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { deliveryLimiter } from '../middleware/rateLimit.js';
import {
  getDeliveryOr404, requireDeliveryAccess, audit,
} from '../services/authz.js';
import { resolveMapsProvider, MapsError } from '../services/maps/index.js';
import { canTransition, transitionNeedsCode, isTerminal } from '../services/deliveryMachine.js';
import { signedDownloadUrl } from '../services/storage.js';
import { auditDelivery } from './deliveryRequests.js';

export const deliveriesRouter = Router();
deliveriesRouter.use(requireAuth);

function publicDelivery(d, viewerRole) {
  // Queue viewers (couriers browsing open orders) never see instructions.
  const out = { ...d };
  if (viewerRole === 'courier-viewer') { delete out.instructions; }
  return out;
}

async function recordTransition(client, delivery, to, actorId) {
  const q = (t, p) => client.query(t, p);
  await q(
    'UPDATE deliveries SET status = $1, updated_at = now() WHERE id = $2',
    [to, delivery.id],
  );
  await q(
    'INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)',
    [randomUUID(), delivery.id, delivery.status, to, actorId],
  );
  await audit(q, actorId, 'delivery.transition', 'delivery', delivery.id, { from: delivery.status, to });
}

async function createChallenges(client, deliveryId) {
  const expiresAt = new Date(Date.now() + config.codeTtlHours * 3600_000);
  for (const stage of ['pickup', 'dropoff']) {
    await client.query(
      `INSERT INTO verification_challenges (id, delivery_id, stage, code_encrypted, expires_at, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), deliveryId, stage, encryptCode(newCode()), expiresAt, config.codeMaxAttempts],
    );
  }
  return expiresAt;
}

// POST /api/deliveries — create. By default publish=true puts it straight in
// the courier queue (original UX); publish=false leaves it CREATED.
deliveriesRouter.post('/', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.createDelivery, req.body);
  const delivery = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    const id = randomUUID();
    const { rows } = await q(
      `INSERT INTO deliveries (id, public_ref, sender_id, name, category, size, weight_kg,
         pickup_area, dropoff_area, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
         instructions, fee_offer, fragile, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'CREATED')
       RETURNING *`,
      [id, newPublicRef(), req.user.id, body.name, body.category, body.size, body.weightKg,
       body.pickupArea, body.dropoffArea, body.pickupLat ?? null, body.pickupLng ?? null,
       body.dropoffLat ?? null, body.dropoffLng ?? null, body.instructions, body.feeOffer, body.fragile],
    );
    const d = rows[0];
    await q('INSERT INTO delivery_participants (delivery_id, user_id, role) VALUES ($1, $2, \'sender\')',
      [id, req.user.id]);
    await q(
      'INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_id) VALUES ($1, $2, NULL, \'CREATED\', $3)',
      [randomUUID(), id, req.user.id],
    );
    await createChallenges(client, id);
    if (body.publish) {
      await recordTransition(client, d, 'SEARCHING_FOR_COURIER', req.user.id);
      d.status = 'SEARCHING_FOR_COURIER';
    }
    await audit(q, req.user.id, 'delivery.created', 'delivery', id, {});
    return d;
  });
  res.status(201).json({ ok: true, data: delivery });
}));

// GET /api/deliveries — ?view=mine|queue, ?status=, paginated.
deliveriesRouter.get('/', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  const view = req.query.view || 'mine';
  const status = req.query.status;
  let rows;
  if (view === 'queue') {
    const c = await query('SELECT 1 FROM courier_profiles WHERE user_id = $1', [req.user.id]);
    if (!c.rows.length && req.user.role !== 'admin') throw forbidden('Only couriers can browse the queue');
    const params = ['SEARCHING_FOR_COURIER'];
    let statusClause = '';
    if (status) { params.push(status); statusClause = 'AND status = $2'; }
    const r = await query(
      `SELECT * FROM deliveries WHERE status = $1 ${statusClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    rows = r.rows.map((d) => publicDelivery(d, 'courier-viewer'));
  } else {
    const params = [req.user.id];
    let statusClause = '';
    if (status) { params.push(status); statusClause = 'AND d.status = $2'; }
    const r = await query(
      `SELECT d.* FROM deliveries d JOIN delivery_participants p ON p.delivery_id = d.id
        WHERE p.user_id = $1 ${statusClause} ORDER BY d.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    rows = r.rows;
  }
  res.json({ ok: true, data: rows, meta: pageMeta(page, limit, rows.length) });
}));

// Marketplace enrichment for GET /:id (participants only, via
// requireDeliveryAccess above). Additive fields; courier deliveries get
// nulls. The drop-off photo URL is a short-lived signed URL issued via the
// existing private-file download route, which re-checks scope on download.
async function enrichDelivery(d) {
  const out = { ...d };
  const part = await query(
    `SELECT user_id FROM delivery_participants WHERE delivery_id = $1 AND role = 'recipient' LIMIT 1`,
    [d.id],
  );
  out.recipient_id = part.rows.length ? part.rows[0].user_id : null;
  // Frontend alignment: the buyer is the 'recipient' participant. Both
  // spellings are returned with the same value so no integration rework is
  // needed; recipient_id is canonical, buyer_id is the alias.
  out.buyer_id = out.recipient_id;
  out.dropoff_photo_url = d.dropoff_photo_file_id ? signedDownloadUrl(d.dropoff_photo_file_id) : null;
  out.dropoffPhotoUrl = out.dropoff_photo_url;
  out.dropoffPhotoFileId = d.dropoff_photo_file_id || null;
  out.dropoffLat = d.dropoff_lat !== null && d.dropoff_lat !== undefined ? Number(d.dropoff_lat) : null;
  out.dropoffLng = d.dropoff_lng !== null && d.dropoff_lng !== undefined ? Number(d.dropoff_lng) : null;
  out.dropoffCoordSource = d.dropoff_coord_source || null;
  out.dropoffArea = d.dropoff_area || null;
  const pay = await query('SELECT * FROM delivery_payments WHERE delivery_id = $1', [d.id]);
  // Payment record aliases: payment is canonical; payment_record and
  // cash_payment carry the same record (cash-on-pickup, record only).
  out.payment = pay.rows.length ? pay.rows[0] : null;
  out.payment_record = out.payment;
  out.cash_payment = out.payment;
  return out;
}

async function getMarketplaceBuyerId(d) {
  const part = await query(
    `SELECT user_id FROM delivery_participants WHERE delivery_id = $1 AND role = 'recipient' LIMIT 1`,
    [d.id],
  );
  if (part.rows.length) return part.rows[0].user_id;
  if (d.request_id) {
    const r = await query('SELECT requester_id FROM delivery_requests WHERE id = $1', [d.request_id]);
    if (r.rows.length) return r.rows[0].requester_id;
  }
  return null;
}

function requireMarketplace(d) {
  if (d.fulfillment !== 'marketplace') throw badRequest('Not a marketplace delivery');
}

function requireMarketplaceSeller(d, user) {
  requireMarketplace(d);
  if (d.sender_id !== user.id) throw forbidden('Only the seller can do this');
}

async function requireMarketplaceBuyer(d, user) {
  requireMarketplace(d);
  const buyerId = await getMarketplaceBuyerId(d);
  if (buyerId !== user.id) throw forbidden('Only the buyer can do this');
  return buyerId;
}

function emitMarketplaceUpdate(req, userIds, deliveryId, status) {
  const io = req.app.get('io');
  if (!io) return;
  for (const uid of new Set(userIds.filter(Boolean))) {
    io.to(`user:${uid}`).emit('delivery:update', { deliveryId, status });
  }
}

// ---- 005: system messages + pickup shares + ratings ----
// System messages announce arrival/exchange inside the linked conversation.
// They are plain rows with is_system=true (never editable/deletable, never
// reaction/reply targets — enforced in the messages router). The sender is
// the acting participant, so the row satisfies the sender FK without
// inventing a system user.
async function insertSystemMessage(q, conversationId, senderId, body) {
  const { rows } = await q(
    'INSERT INTO messages (id, conversation_id, sender_id, body, is_system) VALUES ($1, $2, $3, $4, TRUE) RETURNING *',
    [randomUUID(), conversationId, senderId, body],
  );
  await q('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return rows[0];
}
async function linkedConversationId(q, delivery) {
  if (!delivery.request_id) return null;
  const r = await q('SELECT conversation_id FROM delivery_requests WHERE id = $1', [delivery.request_id]);
  return r.rows.length ? r.rows[0].conversation_id : null;
}
async function emitSystemMessage(req, convId, msg, senderId) {
  const io = req.app.get('io');
  if (!io || !convId) return;
  const u = await query('SELECT nexora_id, display_name, avatar_glyph FROM users WHERE id = $1', [senderId]);
  const sender = u.rows[0] || {};
  io.to(`conversation:${convId}`).emit('message:new', {
    id: msg.id, conversationId: convId, senderId,
    senderNexoraId: sender.nexora_id, senderName: sender.display_name,
    senderAvatar: sender.avatar_glyph, body: msg.body, replyToId: null,
    editedAt: null, createdAt: msg.created_at, isSystem: true,
    reactions: [], replyCount: 0, parentSnippet: null, attachments: [],
  });
}
// Strict participant check for the 005 pickup/rating endpoints: the
// delivery_participants table only — no admin bypass, no queue-viewer.
async function requireStrictParticipant(deliveryId, userId) {
  const { rows } = await query(
    'SELECT role FROM delivery_participants WHERE delivery_id = $1 AND user_id = $2', [deliveryId, userId],
  );
  if (!rows.length) throw forbidden('You are not a participant in this delivery');
  return rows[0].role;
}
export async function reputationOf(userId) {
  const agg = await query(
    'SELECT AVG(stars)::float AS avg_stars, COUNT(*)::int AS n FROM delivery_ratings WHERE ratee_id = $1',
    [userId],
  );
  const done = await query(
    `SELECT COUNT(*)::int AS n FROM deliveries d JOIN delivery_participants p ON p.delivery_id = d.id
      WHERE p.user_id = $1 AND d.status = 'DELIVERED'`,
    [userId],
  );
  // avgStars is null when there are no ratings — never 0-as-a-score and
  // never a default. completedDeliveries counts real DELIVERED rows only.
  return {
    avgStars: agg.rows[0].n ? Number(agg.rows[0].avg_stars) : null,
    ratingsCount: agg.rows[0].n, completedDeliveries: done.rows[0].n,
  };
}

deliveriesRouter.get('/:id', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  const { role } = await requireDeliveryAccess(d, req.user, { courierQueueView: true });
  res.json({ ok: true, data: await enrichDelivery(publicDelivery(d, role)) });
}));

deliveriesRouter.get('/:id/history', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  await requireDeliveryAccess(d, req.user, { courierQueueView: true });
  const { rows } = await query(
    `SELECT h.*, u.nexora_id AS actor_nexora_id FROM delivery_status_history h
       JOIN users u ON u.id = h.actor_id WHERE h.delivery_id = $1 ORDER BY h.seq`,
    [d.id],
  );
  res.json({ ok: true, data: rows });
}));

// POST /api/deliveries/:id/claim — ATOMIC: exactly one courier wins, even
// under concurrent claims (the WHERE clause is the lock; no client lock needed).
deliveriesRouter.post('/:id/claim', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  const c = await query('SELECT 1 FROM courier_profiles WHERE user_id = $1', [req.user.id]);
  if (!c.rows.length && req.user.role !== 'admin') throw forbidden('Only registered couriers can claim orders');
  if (d.sender_id === req.user.id) throw forbidden('You cannot courier your own order');
  const result = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    const claimed = await q(
      `UPDATE deliveries SET status = 'ASSIGNED', courier_id = $2, updated_at = now()
        WHERE id = $1 AND status = 'SEARCHING_FOR_COURIER' AND courier_id IS NULL
        RETURNING *`,
      [d.id, req.user.id],
    );
    if (!claimed.rows.length) return null;
    await q('INSERT INTO courier_assignments (id, delivery_id, courier_id) VALUES ($1, $2, $3)',
      [randomUUID(), d.id, req.user.id]);
    await q('INSERT INTO delivery_participants (delivery_id, user_id, role) VALUES ($1, $2, \'courier\') ON CONFLICT DO NOTHING',
      [d.id, req.user.id]);
    await q(
      'INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_id) VALUES ($1, $2, \'SEARCHING_FOR_COURIER\', \'ASSIGNED\', $3)',
      [randomUUID(), d.id, req.user.id],
    );
    await audit(q, req.user.id, 'delivery.claimed', 'delivery', d.id, {});
    return claimed.rows[0];
  });
  if (!result) throw conflict('Order is no longer available to claim');
  req.app.get('io')?.to(`user:${d.sender_id}`).emit('delivery:update', { deliveryId: d.id, status: 'ASSIGNED' });
  res.json({ ok: true, data: result });
}));

// POST /api/deliveries/:id/step — courier advances the state machine.
// { to } must be a legal transition from the current state; code stages are
// handled by /verify, not here (a code is never accepted as a "step").
deliveriesRouter.post('/:id/step', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.transition, req.body);
  const d = await getDeliveryOr404(req.params.id);
  const { role } = await requireDeliveryAccess(d, req.user);
  // Participant role is authoritative: a marketplace buyer ('recipient')
  // must never inherit the sender's transitions (previously any
  // non-courier participant mapped to 'sender').
  const actorRole = req.user.role === 'admin' ? 'admin' : role;
  if (!canTransition(d.status, body.to, actorRole, d.fulfillment || 'courier')) {
    throw badRequest(`Cannot move from ${d.status} to ${body.to}`);
  }
  if (transitionNeedsCode(d.status, body.to, d.fulfillment || 'courier')) {
    throw badRequest(`This step requires a verified handover code — use /verify first`);
  }
  await withTransaction(async (client) => recordTransition(client, d, body.to, req.user.id));
  req.app.get('io')?.to(`user:${d.sender_id}`).emit('delivery:update', { deliveryId: d.id, status: body.to });
  res.json({ ok: true, data: { status: body.to } });
}));

// POST /api/deliveries/:id/verify — courier submits a one-time handover code.
// Rate-limited per challenge, attempt-counted, expiring, single-use, and the
// code is never logged. Success advances the state machine in the same
// transaction as marking the challenge used (no replay window).
deliveriesRouter.post('/:id/verify', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.verifyCode, req.body);
  const d = await getDeliveryOr404(req.params.id);
  const { role } = await requireDeliveryAccess(d, req.user);
  if (role !== 'courier' && req.user.role !== 'admin') throw forbidden('Only the assigned courier can verify');
  const expectedTo = body.stage === 'pickup' ? 'PICKUP_VERIFIED' : 'DROPOFF_VERIFIED';
  if (!canTransition(d.status, expectedTo, 'courier', d.fulfillment || 'courier')) {
    throw badRequest(`Cannot verify ${body.stage} from state ${d.status}`);
  }
  const out = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    // No SELECT ... FOR UPDATE: the claim on the challenge is the atomic
    // conditional UPDATE below, which is safe under concurrency in real
    // PostgreSQL and portable to the pg-mem test emulator.
    const ch = await q(
      'SELECT * FROM verification_challenges WHERE delivery_id = $1 AND stage = $2',
      [d.id, body.stage],
    );
    if (!ch.rows.length) throw notFound('Verification challenge not found');
    const challenge = ch.rows[0];
    if (challenge.used_at) throw badRequest('This code was already used', 'CODE_REUSED');
    if (new Date(challenge.expires_at) < new Date()) throw badRequest('This code has expired', 'CODE_EXPIRED');
    if (challenge.attempts >= challenge.max_attempts) throw badRequest('Too many attempts — code locked', 'CODE_LOCKED');
    const real = decryptCode(challenge.code_encrypted);
    if (!codesEqual(body.code, real)) {
      // NOTE: do NOT increment attempts inside this transaction. withTransaction
      // rolls back on throw, so an increment here would never persist and the
      // 5-attempt lockout could never engage (verified bug, 2026-10-25). The
      // caller commits the increment separately after this transaction returns.
      return { wrong: true };
    }
    // Atomic claim: only one concurrent verifier can flip used_at from NULL.
    const claimed = await q(
      'UPDATE verification_challenges SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id',
      [challenge.id],
    );
    if (!claimed.rows.length) throw badRequest('This code was already used', 'CODE_REUSED');
    await recordTransition(client, d, expectedTo, req.user.id);
    return { status: expectedTo };
  });
  if (out.wrong) {
    // Commit the failed attempt OUTSIDE the verify transaction: the transaction
    // above committed a no-op (only a SELECT ran), and a separate UPDATE here
    // is what makes the 5-attempt lockout actually engage. Guarded by
    // used_at IS NULL so a concurrently-consumed challenge is never incremented.
    await query(
      'UPDATE verification_challenges SET attempts = attempts + 1 WHERE delivery_id = $1 AND stage = $2 AND used_at IS NULL',
      [d.id, body.stage],
    );
    throw badRequest('Wrong code', 'CODE_WRONG');
  }
  req.app.get('io')?.to(`user:${d.sender_id}`).emit('delivery:update', { deliveryId: d.id, status: out.status });
  res.json({ ok: true, data: out });
}));

// GET /api/deliveries/:id/codes — sender only for courier deliveries. For
// marketplace deliveries the buyer is the code holder: the pickup code is
// issued to the buyer at READY_FOR_PICKUP, so the buyer (recipient) may view
// only the 'pickup' stage; the seller/admin keep the existing full view.
// Plaintext codes are decrypted here from server-side encrypted storage and
// never logged.
deliveriesRouter.get('/:id/codes', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  let buyerOnly = false;
  if (d.sender_id !== req.user.id && req.user.role !== 'admin') {
    if (d.fulfillment === 'marketplace' && (await getMarketplaceBuyerId(d)) === req.user.id) {
      buyerOnly = true;
    } else {
      throw forbidden('Only the sender can view handover codes');
    }
  }
  const { rows } = await query(
    'SELECT stage, code_encrypted, expires_at, used_at, attempts, max_attempts FROM verification_challenges WHERE delivery_id = $1',
    [d.id],
  );
  const codes = {};
  for (const r of rows) {
    if (buyerOnly && r.stage !== 'pickup') continue;
    codes[r.stage] = {
      code: r.used_at ? null : decryptCode(r.code_encrypted),
      expiresAt: r.expires_at, used: !!r.used_at, attemptsLeft: Math.max(0, r.max_attempts - r.attempts),
    };
  }
  res.json({ ok: true, data: codes });
}));

// ---- Marketplace fulfilment (Phase 1) ----
// Seller = deliveries.sender_id; buyer = 'recipient' participant (falling
// back to the linked request's requester_id). Mutations are seller-only or
// buyer-only exactly as specified; admins are NOT exempted here, unlike the
// legacy courier endpoints above.

// POST /api/deliveries/:id/prepare — seller only, CREATED -> PREPARED.
deliveriesRouter.post('/:id/prepare', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  requireMarketplaceSeller(d, req.user);
  if (!canTransition(d.status, 'PREPARED', 'sender', 'marketplace')) {
    throw badRequest(`Cannot prepare from state ${d.status}`);
  }
  const buyerId = await getMarketplaceBuyerId(d);
  await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    await recordTransition(client, d, 'PREPARED', req.user.id);
    await q('UPDATE deliveries SET prepared_at = now() WHERE id = $1', [d.id]);
    await auditDelivery(q, req.user.id, 'delivery.prepared',
      { requestId: d.request_id, deliveryId: d.id, oldValue: { status: 'CREATED' }, newValue: { status: 'PREPARED' } });
  });
  emitMarketplaceUpdate(req, [d.sender_id, buyerId], d.id, 'PREPARED');
  res.json({ ok: true, data: { status: 'PREPARED' } });
}));

// PATCH /api/deliveries/:id/dropoff — seller only, PREPARED or
// READY_FOR_PICKUP. Stores the pin; the first pin set (from PREPARED) moves
// the order to READY_FOR_PICKUP and issues a fresh one-time 'pickup'
// challenge to the buyer. Later edits keep the status and audit old/new.
// dropoffPhotoFileId is the file id returned by the existing upload route
// POST /api/files/deliveries/:id/photo (response field `id`); the file must
// be owned by the seller and scoped to this delivery (delivery_photo) or to
// the linked conversation (message scope), in which case it is re-scoped to
// this delivery so both participants can download it via the signed URL.
// dropoffArea is a coarse label only and is NEVER converted to coordinates;
// dropoffCoordSource is 'user-supplied' unless the caller explicitly passes
// 'gps' (i.e. the coordinates came from the one-shot GPS reading).
deliveriesRouter.patch('/:id/dropoff', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.dropoff, req.body);
  const d = await getDeliveryOr404(req.params.id);
  requireMarketplaceSeller(d, req.user);
  if (!['PREPARED', 'READY_FOR_PICKUP'].includes(d.status)) {
    throw badRequest(`Cannot set a drop-off point from state ${d.status}`);
  }
  const buyerId = await getMarketplaceBuyerId(d);
  let photoFileId = d.dropoff_photo_file_id;
  if (body.dropoffPhotoFileId) {
    const f = await query('SELECT * FROM private_file_metadata WHERE id = $1', [body.dropoffPhotoFileId]);
    if (!f.rows.length) throw notFound('Drop-off photo file not found');
    const file = f.rows[0];
    if (file.owner_id !== req.user.id) throw forbidden('Drop-off photo must be your upload');
    const isDeliveryPhoto = file.scope_type === 'delivery_photo' && file.scope_id === d.id;
    let isConversationUpload = false;
    if (!isDeliveryPhoto && file.scope_type === 'message' && d.request_id) {
      const r = await query('SELECT conversation_id FROM delivery_requests WHERE id = $1', [d.request_id]);
      isConversationUpload = r.rows.length && r.rows[0].conversation_id === file.scope_id;
    }
    if (!isDeliveryPhoto && !isConversationUpload) {
      throw forbidden('Drop-off photo must be uploaded for this delivery or its conversation');
    }
    if (!file.mime_type.startsWith('image/')) throw badRequest('Drop-off photo must be an image');
    photoFileId = file.id;
  }
  const oldPin = { lat: d.dropoff_lat, lng: d.dropoff_lng, area: d.dropoff_area, photoFileId: d.dropoff_photo_file_id, source: d.dropoff_coord_source };
  const newPin = { lat: body.dropoffLat, lng: body.dropoffLng, area: body.dropoffArea ?? d.dropoff_area, photoFileId, source: body.dropoffCoordSource };
  const firstSet = d.status === 'PREPARED';
  await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    // Re-scope a conversation upload to this delivery so the signed-URL
    // download authorization (delivery_participants) covers the buyer too.
    if (body.dropoffPhotoFileId && photoFileId === body.dropoffPhotoFileId) {
      await q(`UPDATE private_file_metadata SET scope_type = 'delivery_photo', scope_id = $2
        WHERE id = $1 AND scope_type = 'message'`, [photoFileId, d.id]);
    }
    await q(
      `UPDATE deliveries SET dropoff_lat = $2, dropoff_lng = $3, dropoff_area = $4,
         dropoff_photo_file_id = $5, dropoff_coord_source = $6, updated_at = now() WHERE id = $1`,
      [d.id, body.dropoffLat, body.dropoffLng, newPin.area, photoFileId, body.dropoffCoordSource],
    );
    if (firstSet) {
      await recordTransition(client, { ...d, status: 'PREPARED' }, 'READY_FOR_PICKUP', req.user.id);
      const existing = await q(
        'SELECT id FROM verification_challenges WHERE delivery_id = $1 AND stage = \'pickup\'', [d.id],
      );
      if (!existing.rows.length) {
        const expiresAt = new Date(Date.now() + config.codeTtlHours * 3600_000);
        await q(
          `INSERT INTO verification_challenges (id, delivery_id, stage, code_encrypted, expires_at, max_attempts)
           VALUES ($1, $2, 'pickup', $3, $4, $5)`,
          [randomUUID(), d.id, encryptCode(newCode()), expiresAt, config.codeMaxAttempts],
        );
      }
    }
    await auditDelivery(q, req.user.id, firstSet ? 'delivery.ready_for_pickup' : 'delivery.dropoff_updated',
      { requestId: d.request_id, deliveryId: d.id, oldValue: oldPin, newValue: newPin });
  });
  emitMarketplaceUpdate(req, [d.sender_id, buyerId], d.id, firstSet ? 'READY_FOR_PICKUP' : d.status);
  res.json({ ok: true, data: { status: firstSet ? 'READY_FOR_PICKUP' : d.status, dropoff: newPin } });
}));

// POST /api/deliveries/:id/arrive — buyer only, READY_FOR_PICKUP. Records
// arrival; the status does not change. 005: also posts a "Buyer has arrived
// at the drop-off point" system message into the linked conversation.
deliveriesRouter.post('/:id/arrive', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  const buyerId = await requireMarketplaceBuyer(d, req.user);
  if (d.status !== 'READY_FOR_PICKUP') throw badRequest(`Cannot arrive from state ${d.status}`);
  const sys = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    await q('UPDATE deliveries SET arrived_at = now(), updated_at = now() WHERE id = $1', [d.id]);
    await auditDelivery(q, req.user.id, 'delivery.arrived',
      { requestId: d.request_id, deliveryId: d.id, oldValue: { arrivedAt: d.arrived_at }, newValue: { status: 'READY_FOR_PICKUP' } });
    const convId = await linkedConversationId(q, d);
    if (!convId) return null;
    const msg = await insertSystemMessage(q, convId, req.user.id, 'Buyer has arrived at the drop-off point');
    return { convId, msg };
  });
  if (sys) await emitSystemMessage(req, sys.convId, sys.msg, req.user.id);
  emitMarketplaceUpdate(req, [d.sender_id, buyerId], d.id, 'READY_FOR_PICKUP');
  res.json({ ok: true, data: { arrived: true, status: 'READY_FOR_PICKUP' } });
}));

// POST /api/deliveries/:id/handover — seller only, READY_FOR_PICKUP. The
// seller submits the one-time 'pickup' code the buyer shows. Verification
// reuses the existing challenge rules (single-use, TTL, attempt lockout;
// failed attempts are committed outside the verify transaction, as in
// /verify, so the lockout can actually engage). On success the order is
// DELIVERED and a cash payment RECORD is inserted (payer = buyer, payee =
// seller, amount = delivery price, method 'cash'). No money moves in-app;
// the response carries recordOnly: true and must not be read otherwise.
deliveriesRouter.post('/:id/handover', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.handover, req.body);
  const d = await getDeliveryOr404(req.params.id);
  requireMarketplaceSeller(d, req.user);
  if (!canTransition(d.status, 'DELIVERED', 'sender', 'marketplace')) {
    throw badRequest(`Cannot hand over from state ${d.status}`);
  }
  const buyerId = await getMarketplaceBuyerId(d);
  const out = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    const ch = await q(
      'SELECT * FROM verification_challenges WHERE delivery_id = $1 AND stage = $2',
      [d.id, 'pickup'],
    );
    if (!ch.rows.length) throw notFound('Pickup verification challenge not found');
    const challenge = ch.rows[0];
    if (challenge.used_at) throw badRequest('This code was already used', 'CODE_REUSED');
    if (new Date(challenge.expires_at) < new Date()) throw badRequest('This code has expired', 'CODE_EXPIRED');
    if (challenge.attempts >= challenge.max_attempts) throw badRequest('Too many attempts — code locked', 'CODE_LOCKED');
    if (!codesEqual(body.code, decryptCode(challenge.code_encrypted))) return { wrong: true };
    const claimed = await q(
      'UPDATE verification_challenges SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id',
      [challenge.id],
    );
    if (!claimed.rows.length) throw badRequest('This code was already used', 'CODE_REUSED');
    await recordTransition(client, d, 'DELIVERED', req.user.id);
    const amountMinor = d.price_minor !== null && d.price_minor !== undefined ? Number(d.price_minor) : 0;
    const pay = await q(
      `INSERT INTO delivery_payments (id, delivery_id, payer_id, payee_id, amount_minor, currency, method)
       VALUES ($1, $2, $3, $4, $5, 'BDT', 'cash') RETURNING *`,
      [randomUUID(), d.id, buyerId, d.sender_id, amountMinor],
    );
    await auditDelivery(q, req.user.id, 'delivery.handover',
      { requestId: d.request_id, deliveryId: d.id, oldValue: { status: 'READY_FOR_PICKUP' },
        newValue: { status: 'DELIVERED', paymentAmountMinor: amountMinor, paymentMethod: 'cash', recordOnly: true } });
    // 005: "Item exchanged" system message into the linked conversation.
    let sys = null;
    const convId = await linkedConversationId(q, d);
    if (convId) {
      const msg = await insertSystemMessage(q, convId, req.user.id, 'Item exchanged');
      sys = { convId, msg };
    }
    return { payment: pay.rows[0], sys };
  });
  if (out.wrong) {
    await query(
      'UPDATE verification_challenges SET attempts = attempts + 1 WHERE delivery_id = $1 AND stage = $2 AND used_at IS NULL',
      [d.id, 'pickup'],
    );
    throw badRequest('Wrong code', 'CODE_WRONG');
  }
  if (out.sys) await emitSystemMessage(req, out.sys.convId, out.sys.msg, req.user.id);
  emitMarketplaceUpdate(req, [d.sender_id, buyerId], d.id, 'DELIVERED');
  res.json({ ok: true, data: { status: 'DELIVERED', payment: out.payment, payment_record: out.payment, cash_payment: out.payment, recordOnly: true } });
}));

// ---- 005: time-limited pickup-only live location ----
// POST /api/deliveries/:id/share-location — marketplace participant only,
// ONLY while READY_FOR_PICKUP. One one-shot reading (the frontend reuses
// the permission-first mountGpsButton pattern); expires in 30 minutes.
// Re-sharing replaces the previous row, so only the latest share is stored.
// No watchPosition, no background tracking, no history endpoint.
deliveriesRouter.post('/:id/share-location', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.shareLocation, req.body);
  const d = await getDeliveryOr404(req.params.id);
  requireMarketplace(d);
  await requireStrictParticipant(d.id, req.user.id);
  if (d.status !== 'READY_FOR_PICKUP') {
    throw badRequest(`Live pickup location can only be shared while the order is ready for pickup (now ${d.status})`);
  }
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    await q('DELETE FROM pickup_location_shares WHERE delivery_id = $1', [d.id]);
    await q(
      'INSERT INTO pickup_location_shares (id, delivery_id, sharer_id, lat, lng, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [randomUUID(), d.id, req.user.id, body.lat, body.lng, expiresAt],
    );
  });
  res.status(201).json({ ok: true, data: { deliveryId: d.id, sharerId: req.user.id, lat: body.lat, lng: body.lng, expiresAt } });
}));

// GET /api/deliveries/:id/pickup-location — participants only. Cleanup on
// read: expired rows are deleted and never returned. After DELIVERED (or
// with no valid share) the answer is { share: null } — never a stale pin.
deliveriesRouter.get('/:id/pickup-location', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  requireMarketplace(d);
  await requireStrictParticipant(d.id, req.user.id);
  await query('DELETE FROM pickup_location_shares WHERE delivery_id = $1 AND expires_at <= now()', [d.id]);
  if (d.status === 'DELIVERED' || d.status === 'CANCELLED') {
    return res.json({ ok: true, data: { share: null } });
  }
  const { rows } = await query(
    'SELECT * FROM pickup_location_shares WHERE delivery_id = $1 ORDER BY created_at DESC LIMIT 1', [d.id],
  );
  if (!rows.length) return res.json({ ok: true, data: { share: null } });
  const s = rows[0];
  res.json({ ok: true, data: { share: { deliveryId: d.id, sharerId: s.sharer_id, lat: Number(s.lat), lng: Number(s.lng), expiresAt: s.expires_at } } });
}));

// ---- 005: reputation from real deliveries only ----
// POST /api/deliveries/:id/ratings — DELIVERED only, participant rates a
// different participant, one rating per rater per delivery. No score is
// ever stored as an aggregate: delivery_ratings holds raw rows and the
// reputation aggregate is computed on read (see users.js).
deliveriesRouter.post('/:id/ratings', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.deliveryRating, req.body);
  const d = await getDeliveryOr404(req.params.id);
  await requireStrictParticipant(d.id, req.user.id);
  if (d.status !== 'DELIVERED') throw badRequest('Ratings are only allowed after delivery');
  const parts = await query(
    'SELECT user_id FROM delivery_participants WHERE delivery_id = $1 AND user_id <> $2', [d.id, req.user.id],
  );
  if (!parts.rows.length) throw badRequest('There is no other participant to rate');
  // For marketplace deliveries the other participant is exactly the buyer/
  // seller counterpart; for courier deliveries the counterpart set is the
  // other participants. Rating one counterpart per delivery is enforced by
  // UNIQUE(delivery_id, rater_id); when several counterparts exist the
  // request must name one — but the 005 contract is the two-party case, so
  // with exactly one counterpart that party is the ratee.
  if (parts.rows.length !== 1) throw badRequest('This delivery does not have exactly one other participant to rate');
  const rateeId = parts.rows[0].user_id;
  try {
    const { rows } = await query(
      `INSERT INTO delivery_ratings (id, delivery_id, rater_id, ratee_id, stars, comment)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [randomUUID(), d.id, req.user.id, rateeId, body.stars, body.comment ?? null],
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (e) {
    if (e.code === '23505') throw conflict('You have already rated this delivery');
    throw e;
  }
}));

deliveriesRouter.get('/:id/ratings', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  await requireStrictParticipant(d.id, req.user.id);
  const { rows } = await query(
    `SELECT r.*, u.nexora_id AS rater_nexora_id, v.nexora_id AS ratee_nexora_id
       FROM delivery_ratings r JOIN users u ON u.id = r.rater_id JOIN users v ON v.id = r.ratee_id
      WHERE r.delivery_id = $1 ORDER BY r.created_at`,
    [d.id],
  );
  res.json({ ok: true, data: rows });
}));

// GET /api/deliveries/:id/qr — PNG QR encoding ONLY the public order reference.
// The QR alone never authorizes anything; verification still needs the code.
deliveriesRouter.get('/:id/qr', asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  await requireDeliveryAccess(d, req.user, { courierQueueView: true });
  const png = await QRCode.toBuffer(d.public_ref, { type: 'png', margin: 1, width: 240 });
  res.type('png').send(png);
}));

// POST /api/deliveries/:id/cancel — sender (or admin) before pickup is verified.
deliveriesRouter.post('/:id/cancel', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  const { role } = await requireDeliveryAccess(d, req.user);
  const actorRole = req.user.role === 'admin' ? 'admin' : (role === 'sender' ? 'sender' : 'courier');
  if (!canTransition(d.status, 'CANCELLED', actorRole, d.fulfillment || 'courier')) {
    throw badRequest(`Cannot cancel from state ${d.status}`);
  }
  await withTransaction(async (client) => recordTransition(client, d, 'CANCELLED', req.user.id));
  res.json({ ok: true, data: { status: 'CANCELLED' } });
}));

// POST /api/deliveries/:id/dispute — any participant, non-terminal states.
deliveriesRouter.post('/:id/dispute', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.dispute, req.body);
  const d = await getDeliveryOr404(req.params.id);
  await requireDeliveryAccess(d, req.user);
  if (isTerminal(d.status)) throw badRequest('Cannot dispute a finished delivery');
  await query('UPDATE deliveries SET disputed = TRUE, dispute_reason = $2 WHERE id = $1', [d.id, body.reason]);
  await audit(query, req.user.id, 'delivery.disputed', 'delivery', d.id, { reason: body.reason });
  res.json({ ok: true, data: { disputed: true } });
}));

deliveriesRouter.post('/:id/dispute/resolve', requireCsrf, asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') throw forbidden('Admin only');
  const d = await getDeliveryOr404(req.params.id);
  await query('UPDATE deliveries SET disputed = FALSE, dispute_reason = NULL WHERE id = $1', [d.id]);
  await audit(query, req.user.id, 'delivery.dispute_resolved', 'delivery', d.id, {});
  res.json({ ok: true, data: { disputed: false } });
}));

// GET /api/deliveries/:id/route — real provider route, or an honest
// unavailable state. Never a fabricated route, distance, or ETA.
//
// Coordinate resolution, in precedence order, per endpoint:
//   1. Explicit query coordinates: ?pickupLat=&pickupLng=&dropoffLat=&dropoffLng=
//      (user-supplied; validated below, echoed back as user-supplied).
//   2. Explicit place names: ?pickup=&dropoff= (geocoded server-side via the
//      provider; a name that resolves to nothing is a 404, not a guess).
//   3. The delivery's stored pickup_lat/lng and dropoff_lat/lng.
// The delivery's coarse pickup_area/dropoff_area strings are NEVER
// auto-geocoded: they are deliberately coarse, and turning them into precise
// coordinates would present a guess as a location.
// A pair is all-or-nothing: one half of a pair without the other is a 400.
// Rate-limited with the existing delivery limiter (60/hour per user, same
// pattern as the other delivery endpoints); the global API limiter also
// applies. Provider failures map to generic 502/503 responses — no provider
// internals, URLs, or key material ever reach the client.
function parseQueryCoord(raw, name) {
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (raw === '' || !Number.isFinite(v)) {
    throw badRequest(`${name} must be a finite number`);
  }
  if (name.endsWith('Lat') && (v < -90 || v > 90)) throw badRequest(`${name} must be between -90 and 90`);
  if (name.endsWith('Lng') && (v < -180 || v > 180)) throw badRequest(`${name} must be between -180 and 180`);
  return v;
}

function requirePair(lat, lng, label) {
  const one = lat !== undefined || lng !== undefined;
  const both = lat !== undefined && lng !== undefined;
  if (one && !both) throw badRequest(`Both ${label} latitude and longitude are required`);
  return both ? { lat, lng } : null;
}

deliveriesRouter.get('/:id/route', deliveryLimiter, asyncHandler(async (req, res) => {
  const d = await getDeliveryOr404(req.params.id);
  await requireDeliveryAccess(d, req.user, { courierQueueView: true });
  const resolved = resolveMapsProvider();
  if (resolved.status === 'unconfigured') {
    return res.status(503).json({
      ok: false,
      error: { code: 'MAPS_NOT_CONFIGURED', message: 'No maps/geocoding provider is configured. Set MAPS_PROVIDER to enable routes.' },
    });
  }
  if (resolved.status === 'unknown') {
    return res.status(503).json({
      ok: false,
      error: { code: 'MAPS_NOT_IMPLEMENTED', message: 'The configured maps provider is not supported.' },
    });
  }
  const provider = resolved.provider;
  const qPickup = requirePair(
    parseQueryCoord(req.query.pickupLat, 'pickupLat'),
    parseQueryCoord(req.query.pickupLng, 'pickupLng'), 'pickup');
  const qDropoff = requirePair(
    parseQueryCoord(req.query.dropoffLat, 'dropoffLat'),
    parseQueryCoord(req.query.dropoffLng, 'dropoffLng'), 'dropoff');

  // Resolve each endpoint; geocoding happens only for an explicit ?pickup= /
  // ?dropoff= place name, and only after the unconfigured check above.
  async function resolveEndpoint(queryCoords, queryName, storedLat, storedLng, label) {
    if (queryCoords) return { ...queryCoords, source: 'user-supplied' };
    if (typeof queryName === 'string' && queryName.trim()) {
      if (queryName.trim().length > 200) throw badRequest(`${label} place search must be 1..200 characters`);
      let hit;
      try {
        hit = await provider.geocode(queryName.trim());
      } catch (e) {
        if (e instanceof MapsError && e.code === 'TIMEOUT') {
          return res.status(503).json({ ok: false, error: { code: 'MAPS_TIMEOUT', message: 'The maps provider timed out. Please try again.' } });
        }
        throw e;
      }
      if (hit === null) throw notFound(`${label} place was not found`, 'PLACE_NOT_FOUND');
      return { lat: hit.lat, lng: hit.lng, source: 'geocoded', displayName: hit.displayName };
    }
    if (storedLat !== null && storedLat !== undefined && storedLng !== null && storedLng !== undefined) {
      return { lat: Number(storedLat), lng: Number(storedLng), source: 'delivery' };
    }
    return null;
  }

  let from, to;
  try {
    from = await resolveEndpoint(qPickup, req.query.pickup, d.pickup_lat, d.pickup_lng, 'Pickup');
    // A geocode timeout already sent its response; stop here.
    if (res.headersSent) return undefined;
    to = await resolveEndpoint(qDropoff, req.query.dropoff, d.dropoff_lat, d.dropoff_lng, 'Dropoff');
    if (res.headersSent) return undefined;
  } catch (e) {
    if (e instanceof MapsError) {
      if (e.code === 'TIMEOUT') {
        return res.status(503).json({ ok: false, error: { code: 'MAPS_TIMEOUT', message: 'The maps provider timed out. Please try again.' } });
      }
      return res.status(502).json({ ok: false, error: { code: 'MAPS_PROVIDER_ERROR', message: 'The maps provider is unavailable. Please try again later.' } });
    }
    throw e;
  }
  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      error: { code: 'ROUTE_COORDS_MISSING', message: 'This delivery has no coordinates stored. Supply pickup and drop-off coordinates or place names to calculate a route.' },
    });
  }
  let route;
  try {
    route = await provider.route(from, to);
  } catch (e) {
    if (e instanceof MapsError) {
      if (e.code === 'TIMEOUT') {
        return res.status(503).json({ ok: false, error: { code: 'MAPS_TIMEOUT', message: 'The maps provider timed out. Please try again.' } });
      }
      if (e.code === 'INVALID_COORDINATES') {
        return res.status(400).json({ ok: false, error: { code: 'INVALID_COORDINATES', message: 'Coordinates must be finite numbers with latitude in -90..90 and longitude in -180..180.' } });
      }
      return res.status(502).json({ ok: false, error: { code: 'MAPS_PROVIDER_ERROR', message: 'The maps provider is unavailable. Please try again later.' } });
    }
    throw e;
  }
  return res.json({
    ok: true,
    data: {
      deliveryId: d.id,
      from: { lat: from.lat, lng: from.lng, source: from.source, ...(from.displayName ? { displayName: from.displayName } : {}) },
      to: { lat: to.lat, lng: to.lng, source: to.source, ...(to.displayName ? { displayName: to.displayName } : {}) },
      provider: route.provider,
      profile: route.profile,
      distanceMeters: route.distanceMeters,
      distanceKm: route.distanceKm,
      durationSeconds: route.durationSeconds,
      durationMinutes: route.durationMinutes,
      geometry: route.geometry,
      attribution: route.attribution,
    },
  });
}));

export default deliveriesRouter;
