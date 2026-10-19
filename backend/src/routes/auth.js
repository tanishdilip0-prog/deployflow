import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';

const anon = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts, try again later' },
});

const router = Router();

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (
    typeof email !== 'string' || typeof password !== 'string' ||
    !email || !password || email.length > 254 || password.length > 200
  ) {
    return res.status(400).json({ ok: false, error: 'email and password are required' });
  }
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  }
  res.json({
    ok: true,
    access_token: data.session.access_token,
    expires_at: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email },
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

export default router;