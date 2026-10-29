import { Router } from 'express';
import { supabase } from '../db.js';
import { fail, isUuid, pageParams, serverError } from '../util.js';
import { parseDestination } from '../aws.js';

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

  const repoIds = (data || []).map((r) => r.id);
  let enrichedData = data || [];

  if (repoIds.length > 0) {
    // Fetch project configurations
    const { data: configs } = await supabase
      .from('deployment_configurations')
      .select('*')
      .in('repository_id', repoIds);

    const configMap = new Map((configs || []).map((c) => [c.repository_id, c]));

    // Fetch latest deployment per repository
    const { data: latestDeps } = await supabase
      .from('deployments')
      .select('id, repository_id, status, commit_sha, commit_message, branch, deployment_url, created_at, completed_at')
      .in('repository_id', repoIds)
      .order('created_at', { ascending: false });

    const depMap = new Map();
    for (const dep of (latestDeps || [])) {
      if (!depMap.has(dep.repository_id)) depMap.set(dep.repository_id, dep);
    }

    enrichedData = data.map((r) => ({
      ...r,
      config: configMap.get(r.id) || null,
      latest_deployment: depMap.get(r.id) || null
    }));
  }

  res.json({ ok: true, data: enrichedData, total: count, limit, offset });
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

router.get('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 400, 'invalid repository id');
  const { data, error } = await supabase
    .from('repositories')
    .select('id, full_name, branch, created_at')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .maybeSingle();
  if (error) return serverError(res, 'get repository', error);
  if (!data) return fail(res, 404, 'Repository not found');
  res.json({ ok: true, data });
});

router.get('/:id/config', async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 400, 'invalid repository id');
  const { data: repo, error: repoErr } = await supabase
    .from('repositories')
    .select('id')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .maybeSingle();
  if (repoErr) return serverError(res, 'check repo', repoErr);
  if (!repo) return fail(res, 404, 'Repository not found');

  const { data, error } = await supabase
    .from('deployment_configurations')
    .select('*')
    .eq('repository_id', req.params.id)
    .maybeSingle();
  if (error) return serverError(res, 'get config', error);
  res.json({ ok: true, data: data || {} });
});

router.patch('/:id/config', async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 400, 'invalid repository id');
  const { data: repo, error: repoErr } = await supabase
    .from('repositories')
    .select('id')
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id)
    .maybeSingle();
  if (repoErr) return serverError(res, 'check repo', repoErr);
  if (!repo) return fail(res, 404, 'Repository not found');

  const { install_command, test_command, build_command, output_dir, s3_bucket, cloudfront_distribution_id } = req.body || {};
  const updates = { updated_at: new Date().toISOString() };
  const DISALLOWED_CHARS = /[;&|`$<>\n\r\0]/;

  // Validate s3_bucket – allows dedicated bucket or bucket with prefix (e.g. "bucket/prefix")
  if (s3_bucket !== undefined) {
    if (s3_bucket === null || (typeof s3_bucket === 'string' && s3_bucket.trim().length === 0)) {
      updates.s3_bucket = null;
    } else if (typeof s3_bucket === 'string') {
      const parsed = parseDestination(s3_bucket);
      if (!parsed) {
        return fail(res, 400, 's3_bucket must be a valid AWS S3 bucket name (e.g. "my-bucket") or bucket with prefix (e.g. "my-bucket/projects/app")');
      }
      const normalized = parsed.prefix ? `${parsed.bucket}/${parsed.prefix}` : parsed.bucket;

      // Destination collision check: prevent two repositories under the same owner from overwriting each other
      const { data: otherConfigs } = await supabase
        .from('deployment_configurations')
        .select('repository_id, s3_bucket')
        .eq('s3_bucket', normalized)
        .neq('repository_id', req.params.id);

      if (otherConfigs && otherConfigs.length > 0) {
        return fail(res, 409, `Destination "${normalized}" is already assigned to another repository. Use a unique S3 bucket or subfolder prefix to avoid overwriting files.`);
      }

      updates.s3_bucket = normalized;
    } else {
      return fail(res, 400, 's3_bucket must be a string or null');
    }
  }

  // Validate output_dir – relative path without directory traversal
  if (output_dir !== undefined) {
    if (output_dir === null || typeof output_dir !== 'string') {
      return fail(res, 400, 'output_dir must be a string');
    }
    const cleanOut = output_dir.trim();
    if (cleanOut.includes('..') || cleanOut.startsWith('/') || cleanOut.startsWith('\\')) {
      return fail(res, 400, 'output_dir cannot contain directory traversal (..) or leading slashes');
    }
    updates.output_dir = cleanOut;
  }

  // Validate cloudfront_distribution_id – AWS CloudFront format
  if (cloudfront_distribution_id !== undefined) {
    if (cloudfront_distribution_id === null || (typeof cloudfront_distribution_id === 'string' && cloudfront_distribution_id.trim().length === 0)) {
      updates.cloudfront_distribution_id = null;
    } else if (typeof cloudfront_distribution_id === 'string') {
      const distId = cloudfront_distribution_id.trim().toUpperCase();
      const CF_REGEX = /^[A-Z0-9]{12,32}$/;
      if (!CF_REGEX.test(distId)) {
        return fail(res, 400, 'cloudfront_distribution_id must be 12-32 uppercase alphanumeric characters');
      }
      updates.cloudfront_distribution_id = distId;
    } else {
      return fail(res, 400, 'cloudfront_distribution_id must be a string or null');
    }
  }

  // Validate install_command – allow only safe npm commands without shell metacharacters
  if (typeof install_command === 'string' && install_command.trim().length > 0) {
    const cmd = install_command.trim();
    if (cmd.length > 200 || DISALLOWED_CHARS.test(cmd)) {
      return fail(res, 400, 'install_command contains unsafe characters');
    }
    const safeInstall = /^npm\s+(ci|install|i)(\s+[\w\-./=@]+)*$/i;
    const safeRun = /^npm\s+run\s+[a-zA-Z0-9_-]+$/i;
    if (safeInstall.test(cmd) || safeRun.test(cmd)) {
      updates.install_command = cmd;
    } else {
      return fail(res, 400, 'install_command must be a valid npm install/ci or npm run <script>');
    }
  }

  // Validate test_command – allow only safe npm test or npm run <script>
  if (typeof test_command === 'string' && test_command.trim().length > 0) {
    const cmd = test_command.trim();
    if (cmd.length > 200 || DISALLOWED_CHARS.test(cmd)) {
      return fail(res, 400, 'test_command contains unsafe characters');
    }
    const safeTest = /^npm\s+test(\s+[\w\-./=@]+)*$/i;
    const safeRun = /^npm\s+run\s+[a-zA-Z0-9_-]+$/i;
    if (safeTest.test(cmd) || safeRun.test(cmd)) {
      updates.test_command = cmd;
    } else {
      return fail(res, 400, 'test_command must be a valid npm test or npm run <script>');
    }
  }

  // Validate build_command – allow only safe npm run <script>
  if (typeof build_command === 'string' && build_command.trim().length > 0) {
    const cmd = build_command.trim();
    if (cmd.length > 200 || DISALLOWED_CHARS.test(cmd)) {
      return fail(res, 400, 'build_command contains unsafe characters');
    }
    const safeRun = /^npm\s+run\s+[a-zA-Z0-9_-]+$/i;
    if (safeRun.test(cmd)) {
      updates.build_command = cmd;
    } else {
      return fail(res, 400, 'build_command must be a valid npm run <script>');
    }
  }

  // Validate output_dir – relative directory only, no path traversal
  if (typeof output_dir === 'string' && output_dir.trim().length > 0) {
    const dir = output_dir.trim();
    const SAFE_DIR = /^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*$/;
    if (dir.length > 100 || !SAFE_DIR.test(dir) || dir.includes('..')) {
      return fail(res, 400, 'output_dir must be a relative directory name without path traversal');
    }
    updates.output_dir = dir;
  }

  const { data, error } = await supabase
    .from('deployment_configurations')
    .update(updates)
    .eq('repository_id', req.params.id)
    .select('*')
    .single();
  if (error) return serverError(res, 'update config', error);
  res.json({ ok: true, data });
});

router.delete('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 400, 'invalid repository id');
  const { error } = await supabase
    .from('repositories')
    .delete()
    .eq('id', req.params.id)
    .eq('owner_id', req.user.id);
  if (error) return serverError(res, 'delete repository', error);
  res.json({ ok: true, deleted: true });
});

export default router;
