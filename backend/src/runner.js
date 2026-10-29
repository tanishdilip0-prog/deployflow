import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { supabase } from './db.js';
import { config } from './config.js';
import { deployToS3, invalidateCloudFront, verifyDeploymentUrl, getCloudFrontDomain } from './aws.js';

let isRunning = false;
let pollingInterval = null;

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._\/-]{1,100}$/;

// Consistently resolve deployed directory relative to project backend
const DEPLOYED_ROOT = path.resolve(import.meta.dirname, '..', 'deployed');
if (!fsSync.existsSync(DEPLOYED_ROOT)) {
  fsSync.mkdirSync(DEPLOYED_ROOT, { recursive: true });
}

async function addLog(deploymentId, stage, level, message) {
  try {
    await supabase.from('deployment_logs').insert({
      deployment_id: deploymentId,
      stage: stage || null,
      level: level || 'info',
      message: String(message).slice(0, 1000)
    });
  } catch (err) {
    console.error('Failed to write deployment log:', err.message);
  }
}

async function updateStage(deploymentId, name, status, exitCode = null, durationMs = null) {
  try {
    const updateData = { status };
    if (status === 'running') {
      updateData.started_at = new Date().toISOString();
    } else if (['success', 'failed', 'skipped'].includes(status)) {
      updateData.completed_at = new Date().toISOString();
      if (exitCode !== null) updateData.exit_code = exitCode;
      if (durationMs !== null) updateData.duration_ms = durationMs;
    }
    await supabase
      .from('deployment_stages')
      .update(updateData)
      .eq('deployment_id', deploymentId)
      .eq('name', name);
  } catch (err) {
    console.error(`Failed to update stage ${name}:`, err.message);
  }
}

// Executes a command with spawn (shell: false) in an isolated environment with sanitized variables.
// Accepts either an array of arguments or a validated string.
async function runCommand(cmdOrArgs, cwd, deploymentId, stage, timeoutMs = 180000) {
  const localBin = path.join(cwd, 'node_modules', '.bin');
  const nodeBin = path.dirname(process.execPath);
  const safeEnv = {
    PATH: `${localBin}:${nodeBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin'}`,
    HOME: process.env.HOME || '/tmp',
    USER: process.env.USER || 'deployflow',
    TMPDIR: os.tmpdir(),
    NODE_ENV: 'development'
  };

  let command;
  let args;
  let displayCmd;

  if (Array.isArray(cmdOrArgs)) {
    command = cmdOrArgs[0];
    args = cmdOrArgs.slice(1);
    displayCmd = cmdOrArgs.join(' ');
  } else {
    displayCmd = String(cmdOrArgs).trim();
    const parts = displayCmd.split(/\s+/);
    command = parts.shift();
    args = parts;
  }

  await addLog(deploymentId, stage, 'info', `$ ${displayCmd}`);
  const startTime = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    const safeResolve = (res) => {
      if (!settled) {
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(res);
      }
    };

    let child;
    try {
      child = spawn(command, args, { cwd, env: safeEnv, timeout: timeoutMs, shell: false });
    } catch (spawnErr) {
      addLog(deploymentId, stage, 'error', `Failed to start process: ${spawnErr.message}`);
      return safeResolve({ exitCode: 1, error: spawnErr.message, durationMs: Date.now() - startTime });
    }

    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (data) => { stdout += data.toString(); });
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => { stderr += data.toString(); });
    }

    child.on('error', (err) => {
      addLog(deploymentId, stage, 'error', `Spawn error: ${err.message}`);
      safeResolve({ exitCode: 1, error: err.message, durationMs: Date.now() - startTime });
    });

    child.on('close', async (code, signal) => {
      const logPromises = [];
      if (stdout.trim()) {
        const lines = stdout.trim().split('\n').slice(-30);
        for (const line of lines) {
          if (line.trim()) logPromises.push(addLog(deploymentId, stage, 'info', line.trim()));
        }
      }
      if (stderr.trim()) {
        const lines = stderr.trim().split('\n').slice(-10);
        for (const line of lines) {
          if (line.trim()) logPromises.push(addLog(deploymentId, stage, 'warn', line.trim()));
        }
      }
      await Promise.allSettled(logPromises);

      const durationMs = Date.now() - startTime;
      if (code === 0) {
        safeResolve({ exitCode: 0, durationMs });
      } else {
        const errMsg = signal
          ? `Process terminated by signal ${signal} (execution timed out or killed)`
          : `Command failed with code ${code}`;
        await addLog(deploymentId, stage, 'error', errMsg);
        safeResolve({ exitCode: code || 1, error: errMsg, durationMs });
      }
    });

    // Enforce hard process termination fallback if graceful shutdown fails
    killTimer = setTimeout(() => {
      try {
        if (child && !child.killed) {
          child.kill('SIGKILL');
        }
      } catch (e) {}
    }, timeoutMs + 5000);
  });
}

async function processDeployment(deployment) {
  const depId = deployment.id;
  const startedAt = Date.now();
  const workDir = path.join(os.tmpdir(), 'deployflow-builds', depId);

  console.log(`[DeployFlow Runner] Starting execution for deployment ${depId}`);

  // Fetch repository & configuration
  const { data: repo, error: repoErr } = await supabase
    .from('repositories')
    .select('full_name, branch')
    .eq('id', deployment.repository_id)
    .single();

  if (repoErr || !repo || !repo.full_name || !NAME_PATTERN.test(repo.full_name)) {
    await supabase.from('deployments').update({
      status: 'failed',
      error_summary: 'Associated repository invalid or not found',
      completed_at: new Date().toISOString()
    }).eq('id', depId);
    return;
  }

  const targetBranch = deployment.branch || repo.branch || 'main';
  if (!BRANCH_PATTERN.test(targetBranch) || targetBranch.startsWith('-')) {
    await supabase.from('deployments').update({
      status: 'failed',
      error_summary: `Invalid branch name: ${targetBranch}`,
      completed_at: new Date().toISOString()
    }).eq('id', depId);
    return;
  }

  const { data: configRow } = await supabase
    .from('deployment_configurations')
    .select('*')
    .eq('repository_id', deployment.repository_id)
    .maybeSingle();

  const cfg = configRow || {
    install_command: 'npm ci',
    test_command: 'npm test',
    build_command: 'npm run build',
    output_dir: 'dist'
  };

  try {
    await fs.mkdir(workDir, { recursive: true });

    // ==========================================
    // STAGE 1: CHECKOUT
    // ==========================================
    await supabase.from('deployments').update({
      status: 'cloning',
      started_at: new Date().toISOString()
    }).eq('id', depId);
    await updateStage(depId, 'checkout', 'running');
    await addLog(depId, 'checkout', 'info', `Checking out ${repo.full_name} (${targetBranch})...`);

    const stage1Start = Date.now();
    const cloneUrl = `https://github.com/${repo.full_name}.git`;
    const cloneArgs = ['git', 'clone', '--depth', '1', '--branch', targetBranch, cloneUrl, '.'];
    const cloneRes = await runCommand(cloneArgs, workDir, depId, 'checkout');

    if (cloneRes.exitCode !== 0) {
      await updateStage(depId, 'checkout', 'failed', cloneRes.exitCode, cloneRes.durationMs);
      await supabase.from('deployments').update({
        status: 'failed',
        error_summary: `Git checkout failed: ${cloneRes.error}`,
        completed_at: new Date().toISOString()
      }).eq('id', depId);
      return;
    }
    await updateStage(depId, 'checkout', 'success', 0, Date.now() - stage1Start);

    // Inspect repository structure
    const hasPackageJson = fsSync.existsSync(path.join(workDir, 'package.json'));
    let pkg = {};
    if (hasPackageJson) {
      try {
        pkg = JSON.parse(await fs.readFile(path.join(workDir, 'package.json'), 'utf8'));
      } catch (e) {}
    }

    // ==========================================
    // STAGE 2: INSTALL
    // ==========================================
    await supabase.from('deployments').update({ status: 'installing' }).eq('id', depId);
    await updateStage(depId, 'install', 'running');

    if (hasPackageJson) {
      let installCmd = cfg.install_command || 'npm install --force --include=dev';
      if (installCmd === 'npm ci') {
        installCmd = 'npm install --force --include=dev';
      } else if (!installCmd.includes('--force')) {
        installCmd += ' --force --include=dev';
      }
      const installRes = await runCommand(installCmd, workDir, depId, 'install');
      if (installRes.exitCode !== 0) {
        await updateStage(depId, 'install', 'failed', installRes.exitCode, installRes.durationMs);
        await supabase.from('deployments').update({
          status: 'failed',
          error_summary: `Install stage failed: ${installRes.error}`,
          completed_at: new Date().toISOString()
        }).eq('id', depId);
        return;
      }
      await updateStage(depId, 'install', 'success', 0, installRes.durationMs);
    } else {
      await addLog(depId, 'install', 'info', 'No package.json found. Skipping dependency installation.');
      await updateStage(depId, 'install', 'skipped', 0, 50);
    }

    // ==========================================
    // STAGE 3: TEST
    // ==========================================
    await supabase.from('deployments').update({ status: 'testing' }).eq('id', depId);
    await updateStage(depId, 'test', 'running');

    const hasTestScript = Boolean(pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified'));
    if (hasTestScript) {
      const testCmd = cfg.test_command || 'npm test';
      const testRes = await runCommand(testCmd, workDir, depId, 'test');
      if (testRes.exitCode !== 0) {
        await updateStage(depId, 'test', 'failed', testRes.exitCode, testRes.durationMs);
        await supabase.from('deployments').update({
          status: 'failed',
          error_summary: `Tests failed with exit code ${testRes.exitCode}`,
          completed_at: new Date().toISOString()
        }).eq('id', depId);
        return;
      }
      await updateStage(depId, 'test', 'success', 0, testRes.durationMs);
    } else {
      await addLog(depId, 'test', 'info', 'No test suite specified. Skipping automated tests.');
      await updateStage(depId, 'test', 'skipped', 0, 50);
    }

    // ==========================================
    // STAGE 4: BUILD
    // ==========================================
    await supabase.from('deployments').update({ status: 'building' }).eq('id', depId);
    await updateStage(depId, 'build', 'running');

    const hasBuildScript = Boolean(pkg.scripts && pkg.scripts.build);
    if (hasBuildScript) {
      const buildCmd = cfg.build_command || 'npm run build';
      const buildRes = await runCommand(buildCmd, workDir, depId, 'build');
      if (buildRes.exitCode !== 0) {
        await updateStage(depId, 'build', 'failed', buildRes.exitCode, buildRes.durationMs);
        await supabase.from('deployments').update({
          status: 'failed',
          error_summary: `Build failed: ${buildRes.error}`,
          completed_at: new Date().toISOString()
        }).eq('id', depId);
        return;
      }
      await updateStage(depId, 'build', 'success', 0, buildRes.durationMs);
    } else {
      await addLog(depId, 'build', 'info', 'Static site without build script; using repository root.');
      await updateStage(depId, 'build', 'skipped', 0, 50);
    }

    // ==========================================
    // STAGE 5: DEPLOY
    // ==========================================
    await supabase.from('deployments').update({ status: 'deploying' }).eq('id', depId);
    await updateStage(depId, 'deploy', 'running');
    const stage5Start = Date.now();

    // Concurrency protection: verify this deployment is not superseded by a newer successful deployment
    const { data: newerDeployments } = await supabase
      .from('deployments')
      .select('id, created_at, commit_sha')
      .eq('repository_id', deployment.repository_id)
      .eq('branch', targetBranch)
      .eq('status', 'success')
      .gt('created_at', deployment.created_at)
      .limit(1);

    if (newerDeployments && newerDeployments.length > 0) {
      const newer = newerDeployments[0];
      await addLog(depId, 'deploy', 'warn', `A newer deployment (${newer.id.slice(0, 8)} for commit ${newer.commit_sha.slice(0, 7)}) has already been deployed to AWS. Preserving latest production release.`);
      await updateStage(depId, 'deploy', 'skipped', 0, Date.now() - stage5Start);
      await updateStage(depId, 'verify', 'skipped', 0, 10);
      await supabase.from('deployments').update({
        status: 'success',
        deployment_url: null,
        error_summary: 'Superseded by newer commit deployment',
        completed_at: new Date().toISOString()
      }).eq('id', depId);
      return;
    }

    // Determine output folder safely (prevent directory traversal)
    const rawOutput = (cfg.output_dir || 'dist').trim();
    const resolvedCandidate = path.resolve(workDir, rawOutput);
    let sourceOutput;
    if (resolvedCandidate.startsWith(workDir + path.sep) && fsSync.existsSync(resolvedCandidate)) {
      sourceOutput = resolvedCandidate;
    } else if (fsSync.existsSync(path.join(workDir, 'dist'))) {
      sourceOutput = path.join(workDir, 'dist');
    } else if (fsSync.existsSync(path.join(workDir, 'build'))) {
      sourceOutput = path.join(workDir, 'build');
    } else if (fsSync.existsSync(path.join(workDir, 'public'))) {
      sourceOutput = path.join(workDir, 'public');
    } else {
      sourceOutput = workDir;
    }

    let deploymentUrl;
    const targetBucket = cfg.s3_bucket || config.defaultS3Bucket;

    if (targetBucket) {
      await addLog(depId, 'deploy', 'info', `Deploying build artifacts from ${path.basename(sourceOutput)} to AWS S3 bucket: ${targetBucket}...`);
      try {
        const s3Result = await deployToS3(sourceOutput, targetBucket, {
          onLog: (msg, lvl) => addLog(depId, 'deploy', lvl || 'info', msg)
        });
        await addLog(depId, 'deploy', 'info', `Successfully uploaded ${s3Result.uploadedCount} file(s) to s3://${targetBucket}`);

        const targetDistId = cfg.cloudfront_distribution_id || config.defaultCloudFrontDistributionId;
        if (targetDistId) {
          await invalidateCloudFront(targetDistId, ['/*'], {
            onLog: (msg, lvl) => addLog(depId, 'deploy', lvl || 'info', msg)
          });
          const cfDomain = await getCloudFrontDomain(targetDistId, {
            onLog: (msg, lvl) => addLog(depId, 'deploy', lvl || 'info', msg)
          });
          if (cfDomain) {
            deploymentUrl = `https://${cfDomain}/`;
          } else {
            deploymentUrl = s3Result.websiteUrl;
            await addLog(depId, 'deploy', 'warn', `CloudFront domain lookup failed; falling back to S3 endpoint: ${deploymentUrl}`);
          }
        } else {
          deploymentUrl = s3Result.websiteUrl;
        }

        await addLog(depId, 'deploy', 'info', `Deployment published to AWS target: ${deploymentUrl}`);
        await updateStage(depId, 'deploy', 'success', 0, Date.now() - stage5Start);
      } catch (deployErr) {
        await addLog(depId, 'deploy', 'error', `AWS S3 deployment failed: ${deployErr.message}`);
        await updateStage(depId, 'deploy', 'failed', 1, Date.now() - stage5Start);
        await supabase.from('deployments').update({
          status: 'failed',
          error_summary: `AWS deployment error: ${deployErr.message}`,
          completed_at: new Date().toISOString()
        }).eq('id', depId);
        return;
      }
    } else {
      const targetDeployDir = path.join(DEPLOYED_ROOT, depId);
      await fs.mkdir(targetDeployDir, { recursive: true });
      await addLog(depId, 'deploy', 'info', `No AWS S3 bucket configured for repository; publishing artifacts to local target...`);
      await fs.cp(sourceOutput, targetDeployDir, {
        recursive: true,
        filter: (src) => !src.includes('node_modules') && !src.includes('.git')
      });
      deploymentUrl = `http://localhost:${config.port}/deployed/${depId}/index.html`;
      await addLog(depId, 'deploy', 'info', `Artifacts published to local preview: ${deploymentUrl}`);
      await updateStage(depId, 'deploy', 'success', 0, Date.now() - stage5Start);
    }

    // ==========================================
    // STAGE 6: VERIFY
    // ==========================================
    await updateStage(depId, 'verify', 'running');
    const stage6Start = Date.now();
    await addLog(depId, 'verify', 'info', `Verifying deployment health at ${deploymentUrl}...`);

    let verified = false;
    let verifyError = null;

    if (targetBucket) {
      const probe = await verifyDeploymentUrl(deploymentUrl);
      if (probe.verified) {
        verified = true;
        await addLog(depId, 'verify', 'info', `AWS deployment verified: HTTP ${probe.status} OK (${Date.now() - stage6Start}ms)`);
      } else {
        const indexUrl = new URL('index.html', deploymentUrl).toString();
        const indexProbe = await verifyDeploymentUrl(indexUrl);
        if (indexProbe.verified) {
          verified = true;
          deploymentUrl = indexUrl;
          await addLog(depId, 'verify', 'info', `AWS deployment verified via index entrypoint: HTTP ${indexProbe.status} OK (${Date.now() - stage6Start}ms)`);
        } else {
          const s3DirectUrl = `https://${targetBucket}.s3.${config.awsRegion || 'us-east-1'}.amazonaws.com/index.html`;
          const directProbe = await verifyDeploymentUrl(s3DirectUrl);
          if (directProbe.verified) {
            verified = true;
            await addLog(depId, 'verify', 'info', `Verification passed via direct S3 endpoint: HTTP ${directProbe.status} OK (${Date.now() - stage6Start}ms)`);
          } else {
            verifyError = probe.error || `HTTP probe returned status ${probe.status}`;
          }
        }
      }
    } else {
      const targetDeployDir = path.join(DEPLOYED_ROOT, depId);
      const hasIndex = fsSync.existsSync(path.join(targetDeployDir, 'index.html'));
      if (!hasIndex) {
        const files = await fs.readdir(targetDeployDir).catch(() => []);
        verifyError = `Verification failed: No index.html found in deployed artifacts (${files.length} assets found). Check build output_dir.`;
      } else {
        try {
          const probe = await fetch(deploymentUrl);
          if (probe.status === 200) {
            verified = true;
            await addLog(depId, 'verify', 'info', `Verification passed: HTTP 200 OK (${Date.now() - stage6Start}ms)`);
          } else {
            verifyError = `HTTP probe returned status ${probe.status}`;
          }
        } catch (e) {
          verified = hasIndex;
          await addLog(depId, 'verify', 'info', `File system verified: index.html is present in ${targetDeployDir}`);
        }
      }
    }

    if (!verified) {
      await addLog(depId, 'verify', 'error', `Verification failed: ${verifyError}`);
      await updateStage(depId, 'verify', 'failed', 1, Date.now() - stage6Start);
      await supabase.from('deployments').update({
        status: 'failed',
        error_summary: verifyError || 'Verification failed: Deployed application unreachable',
        completed_at: new Date().toISOString()
      }).eq('id', depId);
      return;
    }

    await updateStage(depId, 'verify', 'success', 0, Date.now() - stage6Start);

    // ==========================================
    // FINAL SUCCESS TRANSITION
    // ==========================================
    const totalDuration = Date.now() - startedAt;
    await supabase.from('deployments').update({
      status: 'success',
      deployment_url: deploymentUrl,
      build_duration_ms: totalDuration,
      completed_at: new Date().toISOString(),
      error_summary: null
    }).eq('id', depId);

    await addLog(depId, 'verify', 'info', `✓ Deployment ${depId.slice(0, 8)} succeeded in ${Math.round(totalDuration / 1000)}s!`);
    console.log(`[DeployFlow Runner] Deployment ${depId} SUCCEEDED in ${totalDuration}ms`);

  } catch (err) {
    console.error(`[DeployFlow Runner] Unhandled error during deployment ${depId}:`, err);
    await addLog(depId, null, 'error', `Fatal runner error: ${err.message}`);
    try {
      await supabase.from('deployments').update({
        status: 'failed',
        error_summary: `Internal runner error: ${err.message}`,
        completed_at: new Date().toISOString()
      }).eq('id', depId);
    } catch (dbErr) {}
  } finally {
    // Clean up temporary workspace safely: ensure workDir is within os.tmpdir()/deployflow-builds
    try {
      const expectedBase = path.join(os.tmpdir(), 'deployflow-builds');
      if (workDir.startsWith(expectedBase + path.sep)) {
        await fs.rm(workDir, { recursive: true, force: true });
      }
    } catch (e) {}
  }
}

// Queue processor
export async function processQueue() {
  if (isRunning) return;
  isRunning = true;

  try {
    let hasMore = true;
    while (hasMore) {
      const { data: queue, error } = await supabase
        .from('deployments')
        .select('*')
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1);

      if (error) {
        console.error('[DeployFlow Runner] Failed to poll queue:', error.message);
        break;
      }

      if (queue && queue.length > 0) {
        // Atomically claim the deployment to prevent duplicate execution across workers/intervals
        const { data: claimed, error: claimErr } = await supabase
          .from('deployments')
          .update({ status: 'cloning', started_at: new Date().toISOString() })
          .eq('id', queue[0].id)
          .eq('status', 'queued')
          .select('*')
          .maybeSingle();

        if (claimErr || !claimed) {
          if (claimErr) console.error('[DeployFlow Runner] Claim failed:', claimErr.message);
          continue; // Already claimed or state changed
        }

        await processDeployment(claimed);
      } else {
        hasMore = false;
      }
    }
  } catch (err) {
    console.error('[DeployFlow Runner] Queue processing error:', err.message);
  } finally {
    isRunning = false;
  }
}

export async function startRunner(intervalMs = 4000) {
  if (pollingInterval) return;
  console.log('[DeployFlow Runner] Background CI/CD worker started.');

  // Clean up any stale in-progress deployments from a previous server restart/crash
  try {
    const activeStatuses = ['cloning', 'installing', 'testing', 'building', 'deploying'];
    const { data: stale } = await supabase
      .from('deployments')
      .update({
        status: 'failed',
        error_summary: 'Deployment interrupted by server restart',
        completed_at: new Date().toISOString()
      })
      .in('status', activeStatuses)
      .select('id');
    if (stale && stale.length > 0) {
      console.log(`[DeployFlow Runner] Recovered ${stale.length} stale deployments from server restart.`);
    }
  } catch (err) {
    console.error('[DeployFlow Runner] Error during startup recovery:', err.message);
  }

  processQueue();
  pollingInterval = setInterval(processQueue, intervalMs);
}

export function stopRunner() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

export function triggerRunner() {
  setTimeout(processQueue, 50);
}
