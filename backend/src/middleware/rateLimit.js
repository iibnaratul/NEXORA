// Rate limiting (express-rate-limit). Keys prefer the authenticated user id
// so one account cannot dodge limits by rotating IPs.
// Limits are read from the environment per request (not at import), so tests
// can raise them without changing production defaults.
import rateLimit from 'express-rate-limit';

const key = (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`);
const handler = (req, res) => res.status(429).json({
  ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests — slow down and retry.' },
});
const envMax = (name, fallback) => () => Number(process.env[name] || fallback);

export const authLimiter = rateLimit({ windowMs: 60_000, max: envMax('AUTH_RATE_LIMIT_MAX', 10), keyGenerator: key, handler });
export const messageLimiter = rateLimit({ windowMs: 60_000, max: envMax('MESSAGE_RATE_LIMIT_MAX', 30), keyGenerator: key, handler });
export const uploadLimiter = rateLimit({ windowMs: 60_000, max: envMax('UPLOAD_RATE_LIMIT_MAX', 20), keyGenerator: key, handler });
export const deliveryLimiter = rateLimit({ windowMs: 3600_000, max: envMax('DELIVERY_RATE_LIMIT_MAX', 60), keyGenerator: key, handler });
export const apiLimiter = rateLimit({ windowMs: 60_000, max: envMax('API_RATE_LIMIT_MAX', 300), keyGenerator: key, handler });
