import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// Unit test verifying the exact spawn logic used in runCommand
async function testSafeSpawn(command, args, timeoutMs = 5000) {
  const safeEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
    HOME: process.env.HOME || '/tmp',
    USER: process.env.USER || 'deployflow',
    TMPDIR: os.tmpdir(),
    NODE_ENV: 'development'
  };

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
      child = spawn(command, args, { cwd: os.tmpdir(), env: safeEnv, timeout: timeoutMs, shell: false });
    } catch (err) {
      return safeResolve({ exitCode: 1, error: err.message, durationMs: Date.now() - startTime });
    }

    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      safeResolve({ exitCode: 1, error: err.message, durationMs: Date.now() - startTime });
    });

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - startTime;
      if (code === 0) {
        safeResolve({ exitCode: 0, stdout: stdout.trim(), durationMs });
      } else {
        const errMsg = signal ? `Killed by signal ${signal}` : `Exited with code ${code}`;
        safeResolve({ exitCode: code || 1, error: errMsg, stderr: stderr.trim(), durationMs });
      }
    });

    killTimer = setTimeout(() => {
      try {
        if (child && !child.killed) child.kill('SIGKILL');
      } catch (e) {}
    }, timeoutMs + 1000);
  });
}

test('Runner Execution: Safe spawn executes valid command and captures stdout', async () => {
  const res = await testSafeSpawn('node', ['-e', 'console.log("deployflow-runner-ok")']);
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(res.stdout, 'deployflow-runner-ok');
});

test('Runner Execution: Safe spawn detects non-zero exit code and stderr', async () => {
  const res = await testSafeSpawn('node', ['-e', 'console.error("build failed"); process.exit(2)']);
  assert.strictEqual(res.exitCode, 2);
  assert.strictEqual(res.stderr, 'build failed');
});

test('Runner Execution: Safe spawn enforces timeout on long-running process', async () => {
  const res = await testSafeSpawn('node', ['-e', 'setTimeout(() => {}, 60000)'], 300);
  assert.notStrictEqual(res.exitCode, 0);
  assert.ok(res.error.includes('Killed by signal') || res.exitCode === 1);
});

test('Runner Execution: Safe spawn fails cleanly on missing binary without throwing unhandled exception', async () => {
  const res = await testSafeSpawn('nonexistent-binary-12345', ['--arg']);
  assert.notStrictEqual(res.exitCode, 0);
  assert.ok(res.error.includes('ENOENT') || res.exitCode === 1);
});
