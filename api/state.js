import { neon } from '@neondatabase/serverless';
import { hasForeignOrigin, sessionUserId, parseJsonBody } from './_lib/session.js';

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const EMPTY_STATE = { questionProgress: {}, animations: [], deletedAnimationIds: [] };
let database;
let schemaReady;

function getDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  if (!database) database = neon(process.env.DATABASE_URL);
  return database;
}

async function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = sql`CREATE TABLE IF NOT EXISTS dsa_hub_user_sync_state (
      id text PRIMARY KEY,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function validProgress(progress) {
  if (!isObject(progress)) return false;
  return Object.entries(progress).every(([id, record]) => {
    if (!id || !isObject(record) || record.id !== id || record.completed !== true) return false;
    if (!Number.isInteger(record.attempts) || record.attempts < 1) return false;
    if (!Number.isFinite(record.lastMinutes) || record.lastMinutes < 1 || record.lastMinutes > 1440) return false;
    if (!Number.isInteger(record.toughness) || record.toughness < 1 || record.toughness > 5) return false;
    if (typeof record.usedHint !== 'boolean') return false;
    if (!Number.isFinite(record.intervalDays) || record.intervalDays < 1 || record.intervalDays > 90) return false;
    if (!Number.isFinite(record.lastAt) || record.lastAt <= 0 || !Number.isFinite(record.dueAt) || record.dueAt <= 0) return false;
    return Array.isArray(record.history) && record.history.length <= 20 && record.history.every(attempt =>
      isObject(attempt) && Number.isFinite(attempt.at) && attempt.at > 0 &&
      Number.isFinite(attempt.minutes) && attempt.minutes >= 1 && attempt.minutes <= 1440 &&
      Number.isInteger(attempt.toughness) && attempt.toughness >= 1 && attempt.toughness <= 5 &&
      typeof attempt.usedHint === 'boolean' && ['solve', 'review'].includes(attempt.mode)
    );
  });
}

function validAnimations(animations) {
  return Array.isArray(animations) && animations.every(animation =>
    isObject(animation) && typeof animation.id === 'string' && animation.id.length > 0 &&
    typeof animation.title === 'string' && typeof animation.desc === 'string' &&
    typeof animation.html === 'string' && animation.html.length > 0 &&
    Number.isFinite(animation.ts) && animation.ts > 0 &&
    (animation.questionRef === undefined || animation.questionRef === null || typeof animation.questionRef === 'string')
  );
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateState(value) {
  if (!isObject(value) || !validProgress(value.questionProgress) || !validAnimations(value.animations)) return false;
  return value.deletedAnimationIds === undefined ||
    (Array.isArray(value.deletedAnimationIds) && value.deletedAnimationIds.length <= 10000 && value.deletedAnimationIds.every(id => typeof id === 'string'));
}

function mergeState(current, incoming) {
  const questionProgress = { ...(current?.questionProgress || {}) };
  for (const [id, record] of Object.entries(incoming.questionProgress)) {
    if (!questionProgress[id] || record.lastAt > questionProgress[id].lastAt) questionProgress[id] = record;
  }

  const deletedAnimationIds = new Set([
    ...(Array.isArray(current?.deletedAnimationIds) ? current.deletedAnimationIds : []),
    ...(Array.isArray(incoming.deletedAnimationIds) ? incoming.deletedAnimationIds : []),
  ]);
  const animationsById = new Map();
  for (const animation of [...(current?.animations || []), ...incoming.animations]) {
    if (deletedAnimationIds.has(animation.id)) continue;
    const existing = animationsById.get(animation.id);
    if (!existing || animation.ts > existing.ts) animationsById.set(animation.id, animation);
  }

  return {
    questionProgress,
    animations: [...animationsById.values()],
    deletedAnimationIds: [...deletedAnimationIds],
  };
}

function sendState(res, state, updatedAt = null) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ state, updatedAt });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  if (req.method === 'PUT' && hasForeignOrigin(req)) return res.status(403).json({ error: 'Request origin was rejected.' });
  const userId = sessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in to sync.' });

  try {
    const sql = getDatabase();
    await ensureSchema(sql);

    if (req.method === 'GET') {
      const rows = await sql`SELECT state, updated_at FROM dsa_hub_user_sync_state WHERE id = ${userId} LIMIT 1`;
      if (!rows.length) return sendState(res, EMPTY_STATE);
      return sendState(res, rows[0].state, rows[0].updated_at);
    }

    const body = parseJsonBody(req);
    const serialized = JSON.stringify(body.state);
    if (Buffer.byteLength(serialized || '', 'utf8') > MAX_STATE_BYTES) {
      return res.status(413).json({ error: 'Your saved data is too large to sync in one request.' });
    }
    if (!validateState(body.state)) return res.status(400).json({ error: 'The sync data is invalid.' });

    const rows = await sql`SELECT state FROM dsa_hub_user_sync_state WHERE id = ${userId} LIMIT 1`;
    const merged = mergeState(rows[0]?.state || EMPTY_STATE, body.state);
    const saved = await sql`
      INSERT INTO dsa_hub_user_sync_state (id, state, updated_at)
      VALUES (${userId}, ${JSON.stringify(merged)}::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
      RETURNING state, updated_at
    `;
    return sendState(res, saved[0].state, saved[0].updated_at);
  } catch (error) {
    console.error('Cloud sync request failed:', error);
    return res.status(500).json({ error: 'Could not reach the sync database.' });
  }
}
