// Marketplace delivery requests: a conversation participant asks another
// participant (the seller) for an item. The seller accepts (creating a
// marketplace delivery), declines, or the request is edited/cancelled while
// still open. All reads/writes enforce conversation membership in SQL;
// non-participants get 403, unauthenticated requests get 401 via requireAuth.
// Socket.IO: there is no pre-existing request event pattern (deliveries use
// 'delivery:update' to user rooms; see routes/deliveries.js), so request-only
// lifecycle changes emit nothing and the frontend refetches. Accept emits
// 'delivery:update' for the new delivery from the deliveries-side code path
// via the shared emit helper below.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { schemas, validate } from '../validation/schemas.js';
import {
  asyncHandler, badRequest, forbidden, notFound,
  parsePagination, pageMeta, newPublicRef,
} from '../utils/helpers.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { deliveryLimiter } from '../middleware/rateLimit.js';
import {
  getConversationOr404, assertUuid, audit,
} from '../services/authz.js';
import { canTransition } from '../services/deliveryMachine.js';

export const deliveryRequestsRouter = Router();
deliveryRequestsRouter.use(requireAuth);

export async function getDeliverySettings(conversationId) {
  const { rows } = await query(
    'SELECT * FROM conversation_delivery_settings WHERE conversation_id = $1',
    [conversationId],
  );
  if (!rows.length) return { enabled: true, allowRequests: 'any_member' };
  return { enabled: rows[0].enabled, allowRequests: rows[0].allow_requests };
}

async function requireConversationMember(conversationId, userId) {
  const { rows } = await query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId],
  );
  if (!rows.length) throw forbidden('You are not a member of this conversation');
  return { role: rows[0].role };
}

async function getRequestOr404(id) {
  assertUuid(id);
  const { rows } = await query('SELECT * FROM delivery_requests WHERE id = $1', [id]);
  if (!rows.length) throw notFound('Delivery request not found');
  return rows[0];
}

export async function auditDelivery(clientOrQuery, actorId, action, { requestId = null, deliveryId = null, oldValue = {}, newValue = {} } = {}) {
  const q = typeof clientOrQuery === 'function' ? clientOrQuery : (t, p) => query(t, p);
  await q(
    'INSERT INTO delivery_audit (id, request_id, delivery_id, actor_id, action, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)',
    [randomUUID(), requestId, deliveryId, actorId, action, JSON.stringify(oldValue), JSON.stringify(newValue)],
  );
}

function emitDeliveryUpdate(req, userIds, deliveryId, status) {
  const io = req.app.get('io');
  if (!io) return;
  for (const uid of new Set(userIds)) {
    io.to(`user:${uid}`).emit('delivery:update', { deliveryId, status });
  }
}

// POST /api/delivery-requests — create. Requester and target must both be
// conversation members; in a DM the target must be the other participant
// (self-requests are rejected outright). Disabled conversations reject with 403.
deliveryRequestsRouter.post('/', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const body = validate(schemas.createDeliveryRequest, req.body);
  const conv = await getConversationOr404(body.conversationId);
  await requireConversationMember(conv.id, req.user.id);
  if (body.targetId === req.user.id) throw badRequest('You cannot request a delivery from yourself');
  await requireConversationMember(conv.id, body.targetId);
  const settings = await getDeliverySettings(conv.id);
  if (!settings.enabled) throw forbidden('Delivery requests are disabled in this conversation');
  const id = randomUUID();
  const { rows } = await query(
    `INSERT INTO delivery_requests (id, conversation_id, requester_id, target_id, title, description, price_minor, note, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'REQUESTED') RETURNING *`,
    [id, conv.id, req.user.id, body.targetId, body.title, body.description,
     body.priceMinor ?? null, body.note ?? null],
  );
  await auditDelivery(query, req.user.id, 'request.created',
    { requestId: id, oldValue: {}, newValue: { status: 'REQUESTED', priceMinor: body.priceMinor ?? null } });
  res.status(201).json({ ok: true, data: rows[0] });
}));

// GET /api/delivery-requests?conversationId=... — participants only.
deliveryRequestsRouter.get('/', asyncHandler(async (req, res) => {
  const conversationId = req.query.conversationId;
  if (!conversationId) throw badRequest('conversationId is required');
  const conv = await getConversationOr404(conversationId);
  await requireConversationMember(conv.id, req.user.id);
  const { page, limit, offset } = parsePagination(req);
  const { rows } = await query(
    'SELECT * FROM delivery_requests WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [conv.id, limit, offset],
  );
  const total = await query(
    'SELECT COUNT(*)::int AS n FROM delivery_requests WHERE conversation_id = $1', [conv.id],
  );
  res.json({ ok: true, data: rows, meta: pageMeta(page, limit, total.rows[0].n) });
}));

deliveryRequestsRouter.get('/:id', asyncHandler(async (req, res) => {
  const r = await getRequestOr404(req.params.id);
  await requireConversationMember(r.conversation_id, req.user.id);
  res.json({ ok: true, data: r });
}));

// POST /api/delivery-requests/:id/accept — target/seller only, REQUESTED.
// Creates the marketplace delivery (sender = seller, recipient = requester
// via delivery_participants), links it, and audits both sides. Deliveries
// columns that a request cannot supply (category/size/areas) take neutral
// defaults; the drop-off area is replaced when the seller sets the pin.
deliveryRequestsRouter.post('/:id/accept', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const r = await getRequestOr404(req.params.id);
  if (r.target_id !== req.user.id) throw forbidden('Only the seller can accept this request');
  if (r.status !== 'REQUESTED') throw badRequest(`Cannot accept a request in state ${r.status}`);
  const out = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    const deliveryId = randomUUID();
    const { rows } = await q(
      `INSERT INTO deliveries (id, public_ref, sender_id, name, category, size, weight_kg,
         pickup_area, dropoff_area, instructions, fee_offer, fragile, status,
         fulfillment, request_id, price_minor)
       VALUES ($1, $2, $3, $4, 'Other', 'Medium (box)', 0,
         'Not set yet', 'Not set yet', $5, 0, FALSE, 'CREATED',
         'marketplace', $6, $7)
       RETURNING *`,
      [deliveryId, newPublicRef(), r.target_id, r.title,
       (r.description || '').slice(0, 300), r.id, r.price_minor],
    );
    const d = rows[0];
    await q('INSERT INTO delivery_participants (delivery_id, user_id, role) VALUES ($1, $2, \'sender\'), ($1, $3, \'recipient\')',
      [deliveryId, r.target_id, r.requester_id]);
    await q(
      'INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_id) VALUES ($1, $2, NULL, \'CREATED\', $3)',
      [randomUUID(), deliveryId, req.user.id],
    );
    await audit(q, req.user.id, 'delivery.created', 'delivery', deliveryId, { fulfillment: 'marketplace' });
    const updated = await q(
      `UPDATE delivery_requests SET status = 'ACCEPTED', delivery_id = $2, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [r.id, deliveryId],
    );
    await auditDelivery(q, req.user.id, 'request.accepted',
      { requestId: r.id, deliveryId, oldValue: { status: 'REQUESTED' }, newValue: { status: 'ACCEPTED' } });
    await auditDelivery(q, req.user.id, 'delivery.created',
      { requestId: r.id, deliveryId, oldValue: {}, newValue: { status: 'CREATED', fulfillment: 'marketplace' } });
    return { request: updated.rows[0], delivery: d };
  });
  emitDeliveryUpdate(req, [out.request.requester_id, out.request.target_id], out.delivery.id, 'CREATED');
  res.json({ ok: true, data: { ...out.request, delivery: out.delivery } });
}));

// POST /api/delivery-requests/:id/decline — target only, REQUESTED (terminal).
deliveryRequestsRouter.post('/:id/decline', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const r = await getRequestOr404(req.params.id);
  if (r.target_id !== req.user.id) throw forbidden('Only the seller can decline this request');
  if (r.status !== 'REQUESTED') throw badRequest(`Cannot decline a request in state ${r.status}`);
  const { rows } = await query(
    `UPDATE delivery_requests SET status = 'DECLINED', updated_at = now() WHERE id = $1 RETURNING *`,
    [r.id],
  );
  await auditDelivery(query, req.user.id, 'request.declined',
    { requestId: r.id, oldValue: { status: 'REQUESTED' }, newValue: { status: 'DECLINED' } });
  res.json({ ok: true, data: rows[0] });
}));

// PATCH /api/delivery-requests/:id — REQUESTED only. Requester may edit
// title/description/priceMinor/note; seller/target may edit priceMinor/note
// only (title/description edits by the seller are 403).
deliveryRequestsRouter.patch('/:id', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const r = await getRequestOr404(req.params.id);
  const body = validate(schemas.updateDeliveryRequest, req.body);
  const isRequester = r.requester_id === req.user.id;
  const isSeller = r.target_id === req.user.id;
  if (!isRequester && !isSeller) throw forbidden('Only the requester or seller can edit this request');
  if (r.status !== 'REQUESTED') throw badRequest(`Cannot edit a request in state ${r.status}`);
  if (isSeller && !isRequester && (body.title !== undefined || body.description !== undefined)) {
    throw forbidden('The seller may only edit price and note');
  }
  const sets = [];
  const params = [];
  const oldValue = {};
  const newValue = {};
  const fieldMap = [
    ['title', 'title'], ['description', 'description'],
    ['priceMinor', 'price_minor'], ['note', 'note'],
  ];
  for (const [bodyKey, col] of fieldMap) {
    if (body[bodyKey] !== undefined) {
      params.push(body[bodyKey] ?? null);
      sets.push(`${col} = $${params.length}`);
      oldValue[col] = r[col];
      newValue[col] = body[bodyKey] ?? null;
    }
  }
  if (!sets.length) throw badRequest('Nothing to update');
  params.push(r.id);
  const { rows } = await query(
    `UPDATE delivery_requests SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params,
  );
  await auditDelivery(query, req.user.id, 'request.updated',
    { requestId: r.id, oldValue, newValue });
  res.json({ ok: true, data: rows[0] });
}));

// POST /api/delivery-requests/:id/cancel — requester or seller. REQUESTED
// cancels the request alone; ACCEPTED cancels the linked delivery too when
// it is still pre-pickup (CREATED/PREPARED/READY_FOR_PICKUP). A DELIVERED
// order cannot be cancelled this way.
deliveryRequestsRouter.post('/:id/cancel', requireCsrf, deliveryLimiter, asyncHandler(async (req, res) => {
  const r = await getRequestOr404(req.params.id);
  const isRequester = r.requester_id === req.user.id;
  const isSeller = r.target_id === req.user.id;
  if (!isRequester && !isSeller) throw forbidden('Only the requester or seller can cancel this request');
  if (r.status === 'REQUESTED') {
    const { rows } = await query(
      `UPDATE delivery_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *`,
      [r.id],
    );
    await auditDelivery(query, req.user.id, 'request.cancelled',
      { requestId: r.id, oldValue: { status: 'REQUESTED' }, newValue: { status: 'CANCELLED' } });
    return res.json({ ok: true, data: rows[0] });
  }
  if (r.status !== 'ACCEPTED' || !r.delivery_id) {
    throw badRequest(`Cannot cancel a request in state ${r.status}`);
  }
  const dRes = await query('SELECT * FROM deliveries WHERE id = $1', [r.delivery_id]);
  if (!dRes.rows.length) throw badRequest('Linked delivery not found');
  const d = dRes.rows[0];
  if (d.status === 'DELIVERED') throw badRequest('Cannot cancel a delivered order');
  const out = await withTransaction(async (client) => {
    const q = (t, p) => client.query(t, p);
    if (d.status !== 'CANCELLED') {
      if (!canTransition(d.status, 'CANCELLED', 'sender', 'marketplace')) {
        throw badRequest(`Cannot cancel a delivery in state ${d.status}`);
      }
      await q('UPDATE deliveries SET status = $1, updated_at = now() WHERE id = $2', ['CANCELLED', d.id]);
      await q(
        'INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, \'CANCELLED\', $4)',
        [randomUUID(), d.id, d.status, req.user.id],
      );
      await audit(q, req.user.id, 'delivery.transition', 'delivery', d.id, { from: d.status, to: 'CANCELLED' });
      await auditDelivery(q, req.user.id, 'delivery.cancelled',
        { requestId: r.id, deliveryId: d.id, oldValue: { status: d.status }, newValue: { status: 'CANCELLED' } });
    }
    const { rows } = await q(
      `UPDATE delivery_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *`,
      [r.id],
    );
    await auditDelivery(q, req.user.id, 'request.cancelled',
      { requestId: r.id, deliveryId: d.id, oldValue: { status: 'ACCEPTED' }, newValue: { status: 'CANCELLED' } });
    return rows[0];
  });
  emitDeliveryUpdate(req, [r.requester_id, r.target_id], d.id, 'CANCELLED');
  res.json({ ok: true, data: out });
}));

export default deliveryRequestsRouter;
