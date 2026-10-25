// Courier registration + availability, and admin endpoints. Courier capability
// is a profile row plus the users.role flag; admins manage roles and reports.
import { Router } from 'express';
import { query } from '../db.js';
import { schemas, validate } from '../validation/schemas.js';
import { asyncHandler, forbidden, parsePagination, pageMeta } from '../utils/helpers.js';
import { requireAuth, requireCsrf, requireRole } from '../middleware/auth.js';
import { audit } from '../services/authz.js';

export const couriersRouter = Router();
couriersRouter.use(requireAuth);

couriersRouter.post('/register', requireCsrf, asyncHandler(async (req, res) => {
  const { rows } = await query(
    'INSERT INTO courier_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING *',
    [req.user.id],
  );
  await query("UPDATE users SET role = 'courier' WHERE id = $1 AND role = 'user'", [req.user.id]);
  await audit(query, req.user.id, 'courier.registered', 'user', req.user.id, {});
  res.json({ ok: true, data: { registered: true, profile: rows[0] || null } });
}));

couriersRouter.patch('/me/availability', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.setAvailability, req.body);
  const { rows } = await query(
    'UPDATE courier_profiles SET available = $1, vehicle = $2, updated_at = now() WHERE user_id = $3 RETURNING *',
    [body.available, body.vehicle, req.user.id],
  );
  if (!rows.length) throw forbidden('Register as a courier first');
  res.json({ ok: true, data: rows[0] });
}));

couriersRouter.get('/me', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM courier_profiles WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true, data: rows[0] || null });
}));

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

adminRouter.get('/reports', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  const { rows } = await query(
    'SELECT * FROM reports ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset],
  );
  res.json({ ok: true, data: rows, meta: pageMeta(page, limit, rows.length) });
}));

adminRouter.patch('/reports/:id', requireCsrf, asyncHandler(async (req, res) => {
  const status = req.body.status;
  if (!['open', 'reviewed', 'dismissed'].includes(status)) {
    return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status' } });
  }
  await query('UPDATE reports SET status = $1 WHERE id = $2', [status, req.params.id]);
  await audit(query, req.user.id, 'admin.report_status', 'report', req.params.id, { status });
  res.json({ ok: true, data: { status } });
}));

adminRouter.post('/users/:id/role', requireCsrf, asyncHandler(async (req, res) => {
  const body = validate(schemas.setRole, req.body);
  if (req.params.id === req.user.id) {
    return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Admins cannot change their own role' } });
  }
  const { rows } = await query('UPDATE users SET role = $1, updated_at = now() WHERE id = $2 RETURNING id, role', [body.role, req.params.id]);
  if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
  await audit(query, req.user.id, 'admin.role_change', 'user', req.params.id, { role: body.role });
  res.json({ ok: true, data: rows[0] });
}));

adminRouter.get('/audit', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  const { rows } = await query(
    'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset],
  );
  res.json({ ok: true, data: rows, meta: pageMeta(page, limit, rows.length) });
}));

export default couriersRouter;
