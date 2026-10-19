import { Router } from 'express';
import { supabase } from '../db.js';
import { fail, pageParams, serverError } from '../util.js';

const router = Router();
const NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;

router.get('/', async (req, res) => {
  const { limit, offset } = pageParams(req.query);
  const { data, error, count } = await supabase
    .from('repositories')
    .select('id, full_name, branch, created_at', { count: 'exact' })
    .eq('owner_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return serverError(res, 'list repositories', error);
  res.json({ ok: true, data, total: count, limit, offset });
});

router.post('/', async (req, res) => {
  const { full_name, branch = 'main' } = req.body || {};
  if (typeof full_name !== 'string' || !NAME.test(full_name)) {
    return fail(res, 400, 'full_name must look like owner/repo');
  }
  if (typeof branch !== 'string' || !BRANCH.test(branch)) {
    return fail(res, 400, 'branch is not valid');
  }

  const { data, error } = await supabase
    .from('repositories')
    .insert({ owner_id: req.user.id, full_name, branch })
    .select('id, full_name, branch, created_at')
    .single();
  if (error) {
    if (error.code === '23505') return fail(res, 409, 'Repository already added');
    if (error.code === '23503') return fail(res, 409, 'User profile not found');
    return serverError(res, 'create repository', error);
  }

  const cfg = await supabase
    .from('deployment_configurations')
    .insert({ repository_id: data.id });
  if (cfg.error) return serverError(res, 'create configuration', cfg.error);

  res.status(201).json({ ok: true, data });
});

export default router;