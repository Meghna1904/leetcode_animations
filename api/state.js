import { getDatabase } from './_lib/database.js';
import { hasForeignOrigin, sessionUserId, parseJsonBody } from './_lib/session.js';

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const EMPTY_STATE = { questionProgress: {}, animations: [], deletedAnimationIds: [], dailyStudyLog: {}, dailyPracticePlan: {} };
const BUILTIN_MISTAKE_TYPES = ['concept', 'edge-case', 'complexity', 'implementation', 'misread'];
let schemaReady;

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
    if (!id || !isObject(record) || record.id !== id || typeof record.completed !== 'boolean') return false;
    if (!Number.isInteger(record.attempts) || record.attempts < 1) return false;
    if (record.postponeCount !== undefined && (!Number.isInteger(record.postponeCount) || record.postponeCount < 0 || record.postponeCount > 2)) return false;
    if (record.postponedUntil !== undefined && record.postponedUntil !== null && (!Number.isFinite(record.postponedUntil) || record.postponedUntil <= 0)) return false;
    if (!Number.isFinite(record.lastMinutes) || record.lastMinutes < 1 || record.lastMinutes > 1440) return false;
    if (!Number.isInteger(record.toughness) || record.toughness < 1 || record.toughness > 5) return false;
    if (typeof record.usedHint !== 'boolean') return false;
    if (!Number.isFinite(record.intervalDays) || record.intervalDays < 1 || record.intervalDays > 90) return false;
    if (!Number.isFinite(record.lastAt) || record.lastAt <= 0) return false;
    if (record.completed ? (!Number.isFinite(record.dueAt) || record.dueAt <= 0) : record.dueAt !== null) return false;
    return Array.isArray(record.history) && record.history.length <= 20 && record.history.every(attempt =>
      isObject(attempt) && Number.isFinite(attempt.at) && attempt.at > 0 &&
      Number.isFinite(attempt.minutes) && attempt.minutes >= 1 && attempt.minutes <= 1440 &&
      Number.isInteger(attempt.toughness) && attempt.toughness >= 1 && attempt.toughness <= 5 &&
      typeof attempt.usedHint === 'boolean' && ['solve', 'review'].includes(attempt.mode) &&
      (attempt.outcome === undefined || ['independent', 'hint', 'solution'].includes(attempt.outcome)) &&
      (attempt.solvedWithoutHelp === undefined || typeof attempt.solvedWithoutHelp === 'boolean') &&
      (attempt.usedSolution === undefined || typeof attempt.usedSolution === 'boolean') &&
      (attempt.intervalDays === undefined || (Number.isFinite(attempt.intervalDays) && attempt.intervalDays >= 1 && attempt.intervalDays <= 90)) &&
      (attempt.mistakeCategories === undefined || (Array.isArray(attempt.mistakeCategories) && attempt.mistakeCategories.length <= 5 && attempt.mistakeCategories.every(category =>
        BUILTIN_MISTAKE_TYPES.includes(category) || (typeof category === 'string' && /^custom:.{1,40}$/i.test(category))
      ))) &&
      (attempt.mistakeCauses === undefined || (Array.isArray(attempt.mistakeCauses) && attempt.mistakeCauses.length <= 10 && attempt.mistakeCauses.every(cause => typeof cause === 'string' && cause.trim().length > 0 && cause.length <= 160))) &&
      (attempt.schedule === undefined || (isObject(attempt.schedule) &&
        typeof attempt.schedule.firstAttempt === 'boolean' &&
        Number.isFinite(attempt.schedule.baseDays) && attempt.schedule.baseDays >= 1 && attempt.schedule.baseDays <= 90 &&
        Number.isFinite(attempt.schedule.ratingFactor) && attempt.schedule.ratingFactor > 0 &&
        Number.isFinite(attempt.schedule.timeFactor) && attempt.schedule.timeFactor > 0 &&
        Number.isFinite(attempt.schedule.hintFactor) && attempt.schedule.hintFactor > 0
      ))
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

function validDailyStudyLog(log) {
  if (log === undefined) return true;
  if (!isObject(log) || Object.keys(log).length > 5000) return false;
  return Object.entries(log).every(([day, topics]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(topics) && topics.length <= 100 &&
    topics.every(index => Number.isInteger(index) && index >= 0 && index < 1000)
  );
}

function validDailyPracticePlan(plan) {
  if (plan === undefined) return true;
  if (!isObject(plan) || Object.keys(plan).length > 5000) return false;
  return Object.entries(plan).every(([day, entry]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) && isObject(entry) &&
    Number.isFinite(entry.updatedAt) && entry.updatedAt > 0 &&
    Array.isArray(entry.questionIds) && entry.questionIds.length <= 100 &&
    entry.questionIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 500)
  );
}

function validateState(value) {
  if (!isObject(value) || !validProgress(value.questionProgress) || !validAnimations(value.animations) || !validDailyStudyLog(value.dailyStudyLog) || !validDailyPracticePlan(value.dailyPracticePlan)) return false;
  const validDeletedIds = value.deletedAnimationIds === undefined ||
    (Array.isArray(value.deletedAnimationIds) && value.deletedAnimationIds.length <= 10000 && value.deletedAnimationIds.every(id => typeof id === 'string'));
  return validDeletedIds;
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

  const dailyStudyLog = {};
  for (const source of [current?.dailyStudyLog, incoming.dailyStudyLog]) {
    if (!isObject(source)) continue;
    for (const [day, topics] of Object.entries(source)) {
      if (!Array.isArray(topics)) continue;
      dailyStudyLog[day] = [...new Set([...(dailyStudyLog[day] || []), ...topics])];
    }
  }
  const dailyPracticePlan = { ...(current?.dailyPracticePlan || {}) };
  for (const [day, entry] of Object.entries(incoming.dailyPracticePlan || {})) {
    if (!dailyPracticePlan[day] || entry.updatedAt >= dailyPracticePlan[day].updatedAt) dailyPracticePlan[day] = entry;
  }

  return {
    questionProgress,
    animations: [...animationsById.values()],
    deletedAnimationIds: [...deletedAnimationIds],
    dailyStudyLog,
    dailyPracticePlan,
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

