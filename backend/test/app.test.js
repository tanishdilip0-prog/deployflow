import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

test('API Server: Core routes and authentication requirements', async () => {
  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Health check returns 200 and expected payload
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.strictEqual(healthJson.ok, true);
    assert.strictEqual(healthJson.service, 'deployflow-api');

    // 2. Config endpoint returns ok and configured credentials structure
    const configRes = await fetch(`${baseUrl}/api/config`);
    assert.strictEqual(configRes.status, 200);
    const configJson = await configRes.json();
    assert.strictEqual(configJson.ok, true);
    assert.ok(typeof configJson.supabaseUrl === 'string');

    // 3. Unknown API route returns 404
    const notFoundRes = await fetch(`${baseUrl}/api/nonexistent-endpoint`);
    assert.strictEqual(notFoundRes.status, 404);
    const notFoundJson = await notFoundRes.json();
    assert.strictEqual(notFoundJson.ok, false);
    assert.strictEqual(notFoundJson.error, 'Not found');

    // 4. Sensitive routes require Bearer token
    const unauthDeployments = await fetch(`${baseUrl}/api/deployments`);
    assert.strictEqual(unauthDeployments.status, 401);
    const unauthDepJson = await unauthDeployments.json();
    assert.strictEqual(unauthDepJson.ok, false);
    assert.strictEqual(unauthDepJson.error, 'Missing bearer token');

    const unauthRepos = await fetch(`${baseUrl}/api/repositories`);
    assert.strictEqual(unauthRepos.status, 401);
    const unauthRepoJson = await unauthRepos.json();
    assert.strictEqual(unauthRepoJson.ok, false);
    assert.strictEqual(unauthRepoJson.error, 'Missing bearer token');

    const unauthGitHub = await fetch(`${baseUrl}/api/github/repos`);
    assert.strictEqual(unauthGitHub.status, 401);

    // 5. Invalid JSON body produces 400 Bad Request
    const badJsonRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not valid json{'
    });
    assert.strictEqual(badJsonRes.status, 400);
    const badJson = await badJsonRes.json();
    assert.strictEqual(badJson.ok, false);
    assert.strictEqual(badJson.error, 'Request body is not valid JSON');

    // 6. Login route rejects missing fields
    const emptyLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(emptyLoginRes.status, 400);

    // 7. Webhook route without secret header returns 401
    const webhookRes = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'refs/heads/main' })
    });
    assert.strictEqual(webhookRes.status, 401);

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
