// Socket.IO realtime layer. Authentication = the same session cookie as HTTP.
// Authorization = membership, checked on join AND on every message event.
// Origin is checked against CORS_ORIGINS (or same-origin when unset).
// Per-socket message rate limiting: 30/minute.
import { Server } from 'socket.io';
import { loadSession } from '../middleware/auth.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { getConversationOr404, requireConversationAccess } from '../services/authz.js';

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      // Same-origin only by default (no ACAO headers for unlisted origins).
      // Note: this option governs response headers, not the handshake gate —
      // the session cookie (SameSite=Lax) plus per-event revalidation is the
      // actual authentication control. Cross-origin deployments must set
      // CORS_ORIGINS explicitly.
      origin: config.corsOrigins.length ? config.corsOrigins : false,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const session = await loadSession({ headers: { cookie: socket.handshake.headers.cookie || '' } });
      if (!session) return next(new Error('unauthorized'));
      socket.session = session;
      socket.user = session.user;
      next();
    } catch (e) { next(new Error('unauthorized')); }
  });

  // A socket's user snapshot must not outlive its session: logout, expiry,
  // deletion, and membership loss all happen after connect, so every
  // privileged event revalidates the session against the database first.
  async function revalidate(socket, ack) {
    const session = await loadSession({ headers: { cookie: socket.handshake.headers.cookie || '' } });
    if (!session) {
      ack?.({ ok: false, error: 'unauthorized' });
      socket.disconnect(true);
      return null;
    }
    socket.session = session;
    socket.user = session.user;
    return session.user;
  }

  io.on('connection', (socket) => {
    const user = socket.user;
    socket.join(`user:${user.id}`);
    let sentTimestamps = [];

    socket.on('conversation:join', async (conversationId, ack) => {
      try {
        const liveUser = await revalidate(socket, ack);
        if (!liveUser) return;
        const conv = await getConversationOr404(conversationId);
        await requireConversationAccess(conv, liveUser);
        socket.join(`conversation:${conversationId}`);
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message }); }
    });

    socket.on('conversation:leave', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });

    // Authenticated, membership-checked message send over the socket.
    // HTTP POST /messages remains the canonical path; this is the realtime one.
    socket.on('message:send', async (payload, ack) => {
      try {
        const liveUser = await revalidate(socket, ack);
        if (!liveUser) return;
        const now = Date.now();
        sentTimestamps = sentTimestamps.filter((t) => now - t < 60_000);
        if (sentTimestamps.length >= 30) return ack?.({ ok: false, error: 'Rate limited' });
        sentTimestamps.push(now);
        const conv = await getConversationOr404(payload.conversationId);
        await requireConversationAccess(conv, liveUser, { forSend: true });
        const { validate, schemas } = await import('../validation/schemas.js');
        const body = validate(schemas.sendMessage, payload);
        const { randomUUID } = await import('node:crypto');
        const { withTransaction } = await import('../db.js');
        const msg = await withTransaction(async (client) => {
          const q = (t, p) => client.query(t, p);
          const id = randomUUID();
          const { rows } = await q(
            `INSERT INTO messages (id, conversation_id, sender_id, body, reply_to_id, client_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [id, conv.id, liveUser.id, body.body, body.replyToId || null, body.clientId || null],
          );
          await q('UPDATE conversations SET updated_at = now() WHERE id = $1', [conv.id]);
          return rows[0];
        });
        const serialized = {
          id: msg.id, conversationId: conv.id, senderId: liveUser.id,
          senderNexoraId: liveUser.nexoraId, senderName: liveUser.displayName,
          senderAvatar: liveUser.avatarGlyph, body: msg.body, replyToId: msg.reply_to_id,
          editedAt: msg.edited_at, createdAt: msg.created_at, attachments: [],
        };
        io.to(`conversation:${conv.id}`).emit('message:new', serialized);
        ack?.({ ok: true, data: serialized });
      } catch (e) { ack?.({ ok: false, error: e.message }); }
    });

    socket.on('delivery:subscribe', async (deliveryId, ack) => {
      try {
        const liveUser = await revalidate(socket, ack);
        if (!liveUser) return;
        const { getDeliveryOr404, requireDeliveryAccess } = await import('../services/authz.js');
        const d = await getDeliveryOr404(deliveryId);
        await requireDeliveryAccess(d, liveUser, { courierQueueView: true });
        socket.join(`delivery:${deliveryId}`);
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message }); }
    });
  });

  return io;
}
