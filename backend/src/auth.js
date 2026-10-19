import { supabase } from './db.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing bearer token' });
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    }
    req.user = { id: data.user.id, email: data.user.email };
    next();
  } catch (err) {
    console.error('Auth check failed:', err.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}