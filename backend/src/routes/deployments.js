import { Router } from 'express';
import { supabase } from '../db.js';
import { fail, isUuid, pageParams, serverError } from '../util.js';
import { triggerRunner } from '../runner.js';

const router = Router();
const SHA = /^[0-9a-f]{7,40}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;
const STATUSES = ['queued', 'cloning', 'installing', 'testing', 'building',
  'deploying', 'success', 'failed', 'cancelled'];
const STAGES = ['checkout', 'install', 'test', 'build', 'deploy', 'verify'];

async function ownedRepo(repoId, userId) {
  const { data, error } = await supabase
    .from('repositories')
    .select('id, branch')
    .eq('id', repoId)
    .eq('owner_id', userId)
    .maybeSingle();
  return { repo: data, error };
}

async function ownedDeployment(id, userId) {
  const { data: dep, error } = await supabase
    .from('deployments').select('*').eq('id', id).maybeSingle();
  if (error) return { error };
  if (!dep) return {};
  const { repo, error: repoError } = await ownedRepo(dep.repository_id, userId);
  if (repoError) return { error: repoError };
  return repo ? { dep } : {};
}

router.get('/', async (req, res) => {
  const { limit, offset } = pageParams(req.query);
  const { status } = req.query;
  const repositoryId = req.query.repository_id?.toLowerCase();
  if (status !== undefined && !STATUSES.includes(status)) {
    return fail(res, 400, 'invalid status');
  }
  if (repositoryId !== undefined && !isUuid(repositoryId)) {
    return fail(res, 400, 'invalid repository_id');
  }

  const repos = await supabase
    .from('repositories').select('id').eq('owner_id', req.user.id);
  if (repos.error) return serverError(res, 'list repos', repos.error);

  let ids = repos.data.map((r) => r.id);
  if (repositoryId) ids = ids.filter((id) => id === repositoryId);
  if (ids.length === 0) {
    return res.json({ ok: true, data: [], total: 0, limit, offset });
  }

  let query = supabase
    .from('deployments').select('*', { count: 'exact' }).in('repository_id', ids);
  if (status) query = query.eq('status', status);
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return serverError(res, 'list deployments', error);
  res.json({ ok: true, data, total: count, limit, offset });
});

router.post('/', async (req, res) => {
  const { commit_message = null, branch } = req.body || {};
  const repositoryId = req.body?.repository_id?.toLowerCase?.();
  let sha = req.body?.commit_sha?.toLowerCase?.() || '0000000';
  if (!isUuid(repositoryId)) return fail(res, 400, 'repository_id is required');
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    sha = '0000000';
  }
  if (commit_message !== null &&
      (typeof commit_message !== 'string' || commit_message.length > 500)) {
    return fail(res, 400, 'commit_message must be text up to 500 characters');
  }
  if (branch !== undefined && (typeof branch !== 'string' || !BRANCH.test(branch))) {
    return fail(res, 400, 'branch is not valid');
  }

  const { repo, error } = await ownedRepo(repositoryId, req.user.id);
  if (error) return serverError(res, 'check repository', error);
  if (!repo) return fail(res, 404, 'Repository not found');

  const { data: dep, error: depError } = await supabase
    .from('deployments')
    .insert({
      repository_id: repositoryId,
      commit_sha: sha,
      commit_message,
      branch: branch || repo.branch,
      trigger_source: 'manual',
    })
    .select('*')
    .single();
  if (depError) return serverError(res, 'create deployment', depError);

  const stages = await supabase
    .from('deployment_stages')
    .insert(STAGES.map((name) => ({ deployment_id: dep.id, name })));
  const log = await supabase
    .from('deployment_logs')
    .insert({ deployment_id: dep.id, level: 'info', message: 'Deployment queued' });
  if (stages.error || log.error) {
    return serverError(res, 'create stages/logs', stages.error || log.error);
  }

  triggerRunner();
  res.status(201).json({ ok: true, data: dep });
});

router.get('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 400, 'invalid deployment id');
  const { dep, error } = await ownedDeployment(req.params.id.toLowerCase(), req.user.id);
  if (error) return serverError(res, 'get deployment', error);
  if (!dep) return fail(res, 404, 'Deployment not found');

  const { data: stages, error: stageError } = await supabase
    .from('deployment_stages').select('*').eq('deployment_id', dep.id);
  if (stageError) return serverError(res, 'get stages', stageError);
  stages.sort((a, b) => STAGES.indexOf(a.name) - STAGES.indexOf(b.name));
  res.json({ ok: true, data: { ...dep, stages } });
});

router.get('/:id/logs', async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 400, 'invalid deployment id');
  const { dep, error } = await ownedDeployment(req.params.id.toLowerCase(), req.user.id);
  if (error) return serverError(res, 'get deployment', error);
  if (!dep) return fail(res, 404, 'Deployment not found');

  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const { data, error: logError } = await supabase
    .from('deployment_logs')
    .select('id, stage, level, message, created_at')
    .eq('deployment_id', dep.id)
    .gt('id', after)
    .order('id', { ascending: true })
    .limit(limit);
  if (logError) return serverError(res, 'get logs', logError);
  res.json({ ok: true, data });
});

router.post('/:id/retry', async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 400, 'invalid deployment id');
  const { dep, error } = await ownedDeployment(req.params.id.toLowerCase(), req.user.id);
  if (error) return serverError(res, 'get deployment', error);
  if (!dep) return fail(res, 404, 'Deployment not found');

  const { data: newDep, error: depError } = await supabase
    .from('deployments')
    .insert({
      repository_id: dep.repository_id,
      commit_sha: dep.commit_sha,
      commit_message: dep.commit_message ? `Retry: ${dep.commit_message}` : 'Retry deployment',
      branch: dep.branch,
      trigger_source: 'retry',
    })
    .select('*')
    .single();
  if (depError) return serverError(res, 'create retry deployment', depError);

  await supabase
    .from('deployment_stages')
    .insert(STAGES.map((name) => ({ deployment_id: newDep.id, name })));
  await supabase
    .from('deployment_logs')
    .insert({ deployment_id: newDep.id, level: 'info', message: `Deployment queued (retry of ${dep.id.slice(0, 8)})` });

  triggerRunner();
  res.status(201).json({ ok: true, data: newDep });
});

router.post('/:id/cancel', async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 400, 'invalid deployment id');
  const { dep, error } = await ownedDeployment(req.params.id.toLowerCase(), req.user.id);
  if (error) return serverError(res, 'get deployment', error);
  if (!dep) return fail(res, 404, 'Deployment not found');

  if (['success', 'failed', 'cancelled'].includes(dep.status)) {
    return fail(res, 400, `Cannot cancel deployment in '${dep.status}' state`);
  }

  const { data: updated, error: updateError } = await supabase
    .from('deployments')
    .update({
      status: 'cancelled',
      error_summary: 'Deployment cancelled by user',
      completed_at: new Date().toISOString()
    })
    .eq('id', dep.id)
    .select('*')
    .single();
  if (updateError) return serverError(res, 'cancel deployment', updateError);

  await supabase
    .from('deployment_logs')
    .insert({ deployment_id: dep.id, level: 'warn', message: 'Deployment cancelled by user' });

  res.json({ ok: true, data: updated });
});

export default router;
