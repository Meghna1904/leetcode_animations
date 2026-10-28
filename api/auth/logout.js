import { hasForeignOrigin, sessionCookie } from '../_lib/session.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (hasForeignOrigin(req)) return res.status(403).json({ error: 'Request origin was rejected.' });
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  return res.status(200).json({ authenticated: false });
}
