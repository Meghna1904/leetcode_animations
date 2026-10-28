import { getDatabase } from '../_lib/database.js';
import { sessionUserId, syncConfigured } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  res.setHeader('Cache-Control', 'no-store');
  const userId = sessionUserId(req);
  if (!userId || !syncConfigured()) return res.status(200).json({ configured: syncConfigured(), authenticated: false });
  try {
    const sql = getDatabase();
    const rows = await sql`SELECT username FROM dsa_hub_users WHERE id = ${userId} LIMIT 1`;
    if (!rows.length) return res.status(200).json({ configured: true, authenticated: false });
    res.status(200).json({ configured: true, authenticated: true, username: rows[0].username });
  } catch {
    res.status(503).json({ error: 'Could not verify the sync account.' });
  }
}
