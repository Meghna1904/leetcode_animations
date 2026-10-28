import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'dsa_hub_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export function syncConfigured() {
  return Boolean(process.env.DATABASE_URL && process.env.SYNC_SESSION_SECRET?.length >= 32);
}

function sign(payload) {
  return createHmac('sha256', process.env.SYNC_SESSION_SECRET || '').update(payload).digest('base64url');
}

export function issueSession(userId) {
  const expiry = String(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  const payload = `${userId}.${expiry}`;
  return `${payload}.${sign(payload)}`;
}

export function sessionUserId(req) {
  if (!syncConfigured()) return null;
  const cookies = String(req.headers.cookie || '').split(';');
  const token = cookies.map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;

  const [userId, expiry, signature, extra] = token.split('.');
  if (!userId || !expiry || !signature || extra !== undefined || !/^\d+$/.test(expiry) || Number(expiry) <= Date.now() / 1000) return null;
  const expected = Buffer.from(sign(`${userId}.${expiry}`));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? userId : null;
}

export function hasSession(req) {
  return Boolean(sessionUserId(req));
}

export function sessionCookie(req, value, maxAge = SESSION_TTL_SECONDS) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '');
  const secure = process.env.VERCEL === '1' || forwardedProto.split(',')[0] === 'https';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function hasForeignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const requestHost = req.headers['x-forwarded-host'] || req.headers.host;
  try { return new URL(origin).host !== requestHost; } catch { return true; }
}

export function parseJsonBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body);
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}
