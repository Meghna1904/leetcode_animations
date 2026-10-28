import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getDatabase } from '../_lib/database.js';
import { hasForeignOrigin, issueSession, parseJsonBody, sessionCookie, syncConfigured } from '../_lib/session.js';

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 64;
let schemaReady;

async function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = Promise.all([
      sql`CREATE TABLE IF NOT EXISTS dsa_hub_users (
        id text PRIMARY KEY,
        username text NOT NULL UNIQUE,
        password_salt text NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      sql`CREATE TABLE IF NOT EXISTS dsa_hub_user_sync_state (
        id text PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    ]).catch(error => { schemaReady = null; throw error; });
  }
  await schemaReady;
}

function safeEqualHex(left, right) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (hasForeignOrigin(req)) return res.status(403).json({ error: 'Request origin was rejected.' });
  if (!syncConfigured()) return res.status(503).json({ error: 'Cloud sync needs DATABASE_URL and SYNC_SESSION_SECRET (at least 32 characters) in Vercel.' });

  try {
    const { action, username, password } = parseJsonBody(req);
    const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
    if (!/^[a-z0-9_]{3,32}$/.test(normalizedUsername)) return res.status(400).json({ error: 'Username must be 3–32 letters, numbers, or underscores.' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 256) return res.status(400).json({ error: 'Password must be 10–256 characters.' });
    if (!['register', 'login'].includes(action)) return res.status(400).json({ error: 'Choose create account or sign in.' });

    const sql = getDatabase();
    await ensureSchema(sql);
    let user;
    if (action === 'register') {
      const userId = randomBytes(18).toString('base64url');
      const salt = randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, PASSWORD_BYTES, { N: 16384, r: 8, p: 1 })).toString('hex');
      try {
        const rows = await sql`INSERT INTO dsa_hub_users (id, username, password_salt, password_hash)
          VALUES (${userId}, ${normalizedUsername}, ${salt}, ${hash}) RETURNING id, username`;
        user = rows[0];
      } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
        throw error;
      }
    } else {
      const rows = await sql`SELECT id, username, password_salt, password_hash FROM dsa_hub_users WHERE username = ${normalizedUsername} LIMIT 1`;
      const record = rows[0];
      const candidate = record ? (await scrypt(password, record.password_salt, PASSWORD_BYTES, { N: 16384, r: 8, p: 1 })).toString('hex') : '';
      if (!record || !safeEqualHex(candidate, record.password_hash)) return res.status(401).json({ error: 'Username or password is incorrect.' });
      user = record;
    }

    res.setHeader('Set-Cookie', sessionCookie(req, issueSession(user.id)));
    return res.status(200).json({ authenticated: true, username: user.username });
  } catch (error) {
    console.error('Account sign-in failed:', error);
    return res.status(500).json({ error: 'Could not complete account sign-in.' });
  }
}
