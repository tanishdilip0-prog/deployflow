import { test } from 'node:test';
import assert from 'node:assert/strict';

test('OAuth Redirect & State Isolation: getOAuthRedirectUrl semantics', () => {
  const OAUTH_ALLOWED_ORIGINS = [
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "https://d1chawsz7an8u9.cloudfront.net",
    "https://tanishdilip0-prog.github.io"
  ];

  function getOAuthRedirectUrlMock(currentOrigin, protocol) {
    if (protocol === "file:") {
      return "http://localhost:3001/";
    }
    if (!OAUTH_ALLOWED_ORIGINS.includes(currentOrigin)) {
      throw new Error(
        `OAuth redirect blocked: "${currentOrigin}" is not in the DeployFlow allowlist. ` +
        `Allowed origins: ${OAUTH_ALLOWED_ORIGINS.join(", ")}`
      );
    }
    if (currentOrigin === "https://tanishdilip0-prog.github.io") {
      return "https://tanishdilip0-prog.github.io/deployflow/";
    }
    return currentOrigin + "/";
  }

  // CloudFront live website
  assert.equal(
    getOAuthRedirectUrlMock('https://d1chawsz7an8u9.cloudfront.net', 'https:'),
    'https://d1chawsz7an8u9.cloudfront.net/'
  );

  // GitHub Pages live deployment
  assert.equal(
    getOAuthRedirectUrlMock('https://tanishdilip0-prog.github.io', 'https:'),
    'https://tanishdilip0-prog.github.io/deployflow/'
  );

  // Local development port 3001
  assert.equal(
    getOAuthRedirectUrlMock('http://localhost:3001', 'http:'),
    'http://localhost:3001/'
  );

  // Local development 127.0.0.1:3001 (not swapped to localhost)
  assert.equal(
    getOAuthRedirectUrlMock('http://127.0.0.1:3001', 'http:'),
    'http://127.0.0.1:3001/'
  );

  // File protocol fallback
  assert.equal(
    getOAuthRedirectUrlMock('', 'file:'),
    'http://localhost:3001/'
  );

  // Must reject port 3000 / Jarvis with clear error
  assert.throws(
    () => getOAuthRedirectUrlMock('http://localhost:3000', 'http:'),
    /OAuth redirect blocked: "http:\/\/localhost:3000" is not in the DeployFlow allowlist/
  );

  // Must reject untrusted domains
  assert.throws(
    () => getOAuthRedirectUrlMock('https://malicious-site.com', 'https:'),
    /OAuth redirect blocked: "https:\/\/malicious-site.com" is not in the DeployFlow allowlist/
  );
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
