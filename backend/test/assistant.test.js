import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/routes/assistant.js';
import { createApp } from '../src/app.js';

test('Assistant Security: secret redaction removes credentials and tokens', () => {
  const sampleWithSecrets = `
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
aws_secret_access_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzAB
supabase_service_role_key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy.sig
All clear!
`;

  const redacted = redactSecrets(sampleWithSecrets);

  assert.doesNotMatch(redacted, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(redacted, /wJalrXUtnFEMI/);
  assert.doesNotMatch(redacted, /ghp_1234567890/);
  assert.match(redacted, /\[REDACTED_AWS_KEY\]/);
  assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(redacted, /\[REDACTED_JWT\]/);
  assert.match(redacted, /All clear!/);
});

test('Assistant API: GET /api/assistant/status returns local Ollama status', async () => {
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/assistant/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.online, 'boolean');
    assert.equal(typeof body.configuredModel, 'string');
    assert.ok(Array.isArray(body.availableModels));
    assert.ok(typeof body.setupInstructions === 'string');
  } finally {
    server.close();
  }
});

test('Assistant API: POST /api/assistant/chat validates inputs and enforces safety', async () => {
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Missing message
    const emptyRes = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(emptyRes.status, 400);

    // Whitespace message
    const blankRes = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' })
    });
    assert.equal(blankRes.status, 400);

    // Oversized message
    const hugeRes = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(2005) })
    });
    assert.equal(hugeRes.status, 400);

    // When Ollama is offline, returns 503 with setup instructions (no cloud fallback)
    const validRes = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Explain my pipeline' })
    });
    // In test environment without Ollama daemon running, must return 503
    assert.equal(validRes.status, 503);
    const body = await validRes.json();
    assert.equal(body.ok, false);
    assert.match(body.details, /No cloud AI providers are used/);
    assert.ok(body.setupInstructions.includes('brew install ollama'));
  } finally {
    server.close();
  }
});
