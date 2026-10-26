// NEXORA backend entrypoint. Serves the API under /api and the frontend
// statically from frontend/ (same origin, so cookie auth just works).
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { query } from './db.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import conversationsRouter, { messagesRouter } from './routes/conversations.js';
import deliveriesRouter from './routes/deliveries.js';
import deliveryRequestsRouter from './routes/deliveryRequests.js';
import filesRouter from './routes/files.js';
import couriersRouter, { adminRouter } from './routes/couriers.js';
import healthRouter from './routes/health.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { createSocketServer } from './realtime/socket.js';

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  }));
  // Default is same-origin only: with CORS_ORIGINS unset, no Access-Control
  // headers are emitted (previously: reflect any Origin with credentials).
  // Cross-origin deployments must set CORS_ORIGINS explicitly.
  app.use(cors({
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use('/api', apiLimiter);
  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/deliveries', deliveriesRouter);
  app.use('/api/delivery-requests', deliveryRequestsRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/couriers', couriersRouter);
  app.use('/api/admin', adminRouter);

  // Static frontend (same origin).
  const frontendDir = path.join(config.root, 'frontend');
  if (fs.existsSync(frontendDir)) app.use(express.static(frontendDir));

  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown API route' } });
  });

  // Central error handler: safe messages only, no stack traces to clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    // 500s must never echo the underlying error code: database errors carry
    // Postgres codes (22P02, 42601, ...) that leak internals to clients.
    const code = status >= 500 ? 'INTERNAL_ERROR' : (err.code || 'INTERNAL_ERROR');
    if (status >= 500) console.error('[nexora]', err);
    res.status(status).json({
      ok: false,
      error: { code, message: status >= 500 ? 'Internal server error' : err.message },
    });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  app.set('io', io);
  server.listen(config.port, async () => {
    try { await query('SELECT 1'); console.log(`[nexora] API up on :${config.port} (database: up)`); }
    catch { console.log(`[nexora] API up on :${config.port} (database: DOWN — set DATABASE_URL and run npm run migrate)`); }
  });
}
