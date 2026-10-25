// Health + configuration status. Reports what IS and IS NOT configured —
// never claims a provider exists when it does not.
import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';

export const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
  let db = 'down';
  try { await query('SELECT 1'); db = 'up'; } catch { /* reported, not thrown */ }
  res.json({
    ok: true,
    data: {
      status: db === 'up' ? 'ok' : 'degraded',
      version: '1.0.0',
      database: db,
      storage: { provider: config.storageProvider, configured: config.storageProvider === 'local' },
      maps: { provider: config.mapsProvider || null, configured: !!config.mapsProvider },
      realtime: 'socket.io',
      payments: { configured: false, note: 'No payment integration — fees are informational only.' },
      push: { configured: false },
      e2ee: { enabled: false, note: 'Messages are protected by TLS in production, not end-to-end encrypted.' },
    },
  });
});

export default healthRouter;
