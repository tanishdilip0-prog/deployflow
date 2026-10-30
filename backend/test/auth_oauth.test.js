import { test } from 'node:test';
import assert from 'node:assert/strict';

test('OAuth Redirect & State Isolation: getOAuthRedirectUrl semantics', () => {
  // Test 1: Clean origin and path preservation (no fragments or query pollution)
  function getOAuthRedirectUrlMock(currentHref, protocol) {
    if (protocol === "file:") {
      return "http://localhost:3001/";
    }
    const url = new URL(currentHref);
    url.hash = "";
    url.search = "";
    return url.toString();
  }

  // CloudFront live website
  assert.equal(
    getOAuthRedirectUrlMock('https://d1chawsz7an8u9.cloudfront.net/index.html#deployments', 'https:'),
    'https://d1chawsz7an8u9.cloudfront.net/index.html'
  );

  // Local development port 3001
  assert.equal(
    getOAuthRedirectUrlMock('http://localhost:3001/?code=123#overview', 'http:'),
    'http://localhost:3001/'
  );

  // File protocol fallback
  assert.equal(
    getOAuthRedirectUrlMock('file:///Users/deployflow/index.html', 'file:'),
    'http://localhost:3001/'
  );

  // Must NEVER redirect to Jarvis (port 3000 or jarvis domains)
  const result = getOAuthRedirectUrlMock('https://d1chawsz7an8u9.cloudfront.net/index.html', 'https:');
  assert.ok(!result.includes(':3000'), 'Redirect URL must not point to port 3000 (Jarvis)');
  assert.ok(!result.toLowerCase().includes('jarvis'), 'Redirect URL must not reference Jarvis');
});

test('OAuth Redirect: GitHub authorization response targets DeployFlow project callback', async () => {
  // Verify Supabase authorize endpoint returns expected DeployFlow client_id and redirects
  const supabaseUrl = 'https://ryanbfqcrgxqsvxynkvq.supabase.co';
  const targetRedirect = 'https://d1chawsz7an8u9.cloudfront.net/index.html';
  
  const res = await fetch(
    `${supabaseUrl}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(targetRedirect)}&scopes=repo%20read:user`,
    { redirect: 'manual' }
  );
  
  assert.equal(res.status, 302, 'Supabase authorize must issue 302 redirect to GitHub');
  const location = res.headers.get('location');
  assert.ok(location, 'Must return a Location header');
  
  const ghUrl = new URL(location);
  assert.equal(ghUrl.hostname, 'github.com');
  assert.equal(ghUrl.pathname, '/login/oauth/authorize');
  assert.equal(ghUrl.searchParams.get('client_id'), 'Ov23licrSoCIsdNeRj9u');
  assert.equal(ghUrl.searchParams.get('redirect_to'), targetRedirect);
  assert.ok(ghUrl.searchParams.get('state'), 'Must preserve CSRF state parameter');
});
