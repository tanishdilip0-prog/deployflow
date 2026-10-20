import { Router } from 'express';
import crypto from 'node:crypto';
import { supabase } from '../db.js';
import { config } from '../config.js';

const router = Router();
const STAGES = ['checkout', 'install', 'test', 'build', 'deploy', 'verify'];

function validSignature(raw, header) {
  const expected = 'sha256=' + crypto.createHmac('sha256', config.githubWebhookSecret).update(raw).digest('hex');
  const a = Buffer.from(header || '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/github', async (req, res) => {
  if (config.githubWebhookSecret.length < 16) {
    return res.status(503).json({ ok: false, error: 'Webhook secret not configured' });
  }
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !validSignature(raw, req.get('x-hub-signature-256'))) {
    return res.status(401).json({ ok: false, error: 'Invalid signature' });
  }

  const event = req.get('x-github-event');
  const delivery = req.get('x-github-delivery');
  if (!delivery || delivery.length > 100) {
    return res.status(400).json({ ok: false, error: 'Missing delivery id' });
  }
  if (event === 'ping') return res.json({ ok: true, pong: true });
  if (event !== 'push') return res.status(202).json({ ok: true, ignored: event });

  let p;
  try { p = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ ok: false, error: 'Invalid JSON' }); }

  const fullName = p.repository?.full_name;
  const branch = typeof p.ref === 'string' && p.ref.startsWith('refs/heads/') ? p.ref.slice(11) : null;
  const sha = p.after;
  if (!fullName || !branch || p.deleted || !/^[0-9a-f]{40}$/.test(sha || '') || /^0+$/.test(sha)) {
    return res.status(202).json({ ok: true, ignored: 'not a branch push' });
  }

  const { data: repos, error: repoErr } = await supabase
    .from('repositories').select('id').eq('full_name', fullName).eq('branch', branch);
  if (repoErr) {
    console.error('webhook repo lookup:', repoErr.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
  if (!repos.length) return res.status(202).json({ ok: true, ignored: 'repository not connected' });

  const claim = await supabase.from('webhook_deliveries')
    .insert({ delivery_id: delivery, event, repository_id: repos[0].id });
  if (claim.error) {
    if (claim.error.code === '23505') return res.json({ ok: true, duplicate: true });
    console.error('webhook claim:', claim.error.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }

  try {
    const message = typeof p.head_commit?.message === 'string' ? p.head_commit.message.slice(0, 500) : null;
    for (const repo of repos) {
      const { data: dep, error } = await supabase.from('deployments')
        .insert({ repository_id: repo.id, commit_sha: sha, commit_message: message, branch, trigger_source: 'webhook' })
        .select('id').single();
      if (error) throw error;
      const st = await supabase.from('deployment_stages')
        .insert(STAGES.map((name) => ({ deployment_id: dep.id, name })));
      if (st.error) throw st.error;
      const lg = await supabase.from('deployment_logs')
        .insert({ deployment_id: dep.id, level: 'info', message: 'Deployment queued by GitHub push' });
      if (lg.error) throw lg.error;
    }
  } catch (e) {
    console.error('webhook failed:', e.message);
    await supabase.from('webhook_deliveries').delete().eq('delivery_id', delivery);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
  res.status(202).json({ ok: true, deployments: repos.length });
});

export default router;