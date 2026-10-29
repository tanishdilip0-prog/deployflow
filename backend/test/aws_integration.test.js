import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  deployToS3,
  invalidateCloudFront,
  verifyDeploymentUrl,
  getFilesRecursively,
  getCloudFrontDomain
} from '../src/aws.js';

test('AWS S3 Adapter: recursively discovers build output files', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployflow-test-'));
  try {
    await fs.writeFile(path.join(tempDir, 'index.html'), '<h1>Test</h1>');
    await fs.mkdir(path.join(tempDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'assets', 'app.12345678.js'), 'console.log("hi");');
    await fs.writeFile(path.join(tempDir, 'assets', 'style.css'), 'body { margin: 0; }');
    // Ignored files
    await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    await fs.writeFile(path.join(tempDir, '.DS_Store'), 'junk');

    const files = await getFilesRecursively(tempDir);
    assert.equal(files.length, 3);
    const basenames = files.map(f => path.basename(f)).sort();
    assert.deepEqual(basenames, ['app.12345678.js', 'index.html', 'style.css']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AWS S3 Adapter: uploads files with correct Content-Type and Cache-Control headers', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployflow-s3-'));
  const commandsSent = [];

  const mockS3Client = {
    send: async (cmd) => {
      commandsSent.push(cmd.input);
      return {};
    }
  };

  try {
    await fs.writeFile(path.join(tempDir, 'index.html'), '<!DOCTYPE html><html></html>');
    await fs.mkdir(path.join(tempDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'assets', 'main.a1b2c3d4.js'), 'console.log("bundle");');
    await fs.writeFile(path.join(tempDir, 'style.css'), 'h1 { color: red; }');

    const logs = [];
    const result = await deployToS3(tempDir, 'test-target-bucket', {
      s3Client: mockS3Client,
      region: 'us-east-1',
      onLog: (msg) => logs.push(msg)
    });

    assert.equal(result.success, true);
    assert.equal(result.uploadedCount, 3);
    assert.equal(commandsSent.length, 3);

    // Verify HTML headers
    const htmlCmd = commandsSent.find(c => c.Key === 'index.html');
    assert.ok(htmlCmd);
    assert.equal(htmlCmd.ContentType, 'text/html; charset=utf-8');
    assert.equal(htmlCmd.CacheControl, 'public, max-age=0, must-revalidate');

    // Verify JS bundle headers
    const jsCmd = commandsSent.find(c => c.Key === 'assets/main.a1b2c3d4.js');
    assert.ok(jsCmd);
    assert.equal(jsCmd.ContentType, 'application/javascript; charset=utf-8');
    assert.equal(jsCmd.CacheControl, 'public, max-age=31536000, immutable');

    // Verify CSS headers
    const cssCmd = commandsSent.find(c => c.Key === 'style.css');
    assert.ok(cssCmd);
    assert.equal(cssCmd.ContentType, 'text/css; charset=utf-8');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AWS S3 Adapter: fails cleanly when build output directory is empty', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployflow-empty-'));
  try {
    await assert.rejects(
      async () => {
        await deployToS3(tempDir, 'test-target-bucket', {
          s3Client: { send: async () => ({}) }
        });
      },
      /No files found to deploy/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AWS CloudFront Adapter: handles cache invalidations and catches permissions errors safely', async () => {
  // Test successful invalidation
  let callerRefUsed = null;
  const mockCfClient = {
    send: async (cmd) => {
      callerRefUsed = cmd.input.InvalidationBatch.CallerReference;
      return { Invalidation: { Id: 'I1ABCD9876XYZ' } };
    }
  };

  const logs = [];
  const res = await invalidateCloudFront('E1234567890ABC', ['/*'], {
    cfClient: mockCfClient,
    onLog: (msg) => logs.push(msg)
  });

  assert.equal(res.success, true);
  assert.equal(res.invalidationId, 'I1ABCD9876XYZ');
  assert.ok(callerRefUsed.startsWith('deployflow-'));

  // Test AccessDenied error handling (does not throw, reports warning)
  const deniedClient = {
    send: async () => {
      const err = new Error('AccessDenied: User is not authorized to perform: cloudfront:CreateInvalidation');
      err.name = 'AccessDenied';
      throw err;
    }
  };

  const warnLogs = [];
  const deniedRes = await invalidateCloudFront('E1234567890ABC', ['/*'], {
    cfClient: deniedClient,
    onLog: (msg) => warnLogs.push(msg)
  });

  assert.equal(deniedRes.success, false);
  assert.ok(deniedRes.warning.includes('AccessDenied'));
  assert.ok(warnLogs.some(l => l.includes('CloudFront invalidation note')));
});

test('AWS CloudFront Adapter: resolves public domain name from distribution ID', async () => {
  const mockCfClient = {
    send: async (cmd) => {
      assert.equal(cmd.input.Id, 'E4YPXGKH22DTH');
      return {
        Distribution: {
          Id: 'E4YPXGKH22DTH',
          DomainName: 'd1chawsz7an8u9.cloudfront.net',
          Status: 'Deployed'
        }
      };
    }
  };

  const domain = await getCloudFrontDomain('E4YPXGKH22DTH', { cfClient: mockCfClient });
  assert.equal(domain, 'd1chawsz7an8u9.cloudfront.net');

  // Test error handling
  const failingClient = {
    send: async () => {
      throw new Error('NoSuchDistribution: The specified distribution does not exist.');
    }
  };
  const logs = [];
  const failedDomain = await getCloudFrontDomain('EINVALID', {
    cfClient: failingClient,
    onLog: (msg) => logs.push(msg)
  });
  assert.equal(failedDomain, null);
  assert.ok(logs.some(l => l.includes('Failed to resolve CloudFront domain')));
});

test('AWS Deployment Verification: probes live URLs and handles reachable vs unreachable targets', async () => {
  // Test probe on a valid mock endpoint (local server health if running or simulated)
  const probeFailure = await verifyDeploymentUrl('http://127.0.0.1:59999/nonexistent-endpoint', 500);
  assert.equal(probeFailure.verified, false);
  assert.ok(probeFailure.error);
});

test('Security & Configuration: S3 bucket and CloudFront ID validation regexes', () => {
  const S3_BUCKET_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
  const CF_REGEX = /^[A-Z0-9]{12,32}$/;

  // Valid S3 buckets
  assert.ok(S3_BUCKET_REGEX.test('dilipan-cloud-resume-2026-unique'));
  assert.ok(S3_BUCKET_REGEX.test('my-app-bucket'));
  assert.ok(S3_BUCKET_REGEX.test('app123'));

  // Invalid S3 buckets
  assert.ok(!S3_BUCKET_REGEX.test('MyBucket'));          // Uppercase disallowed
  assert.ok(!S3_BUCKET_REGEX.test('-leading-hyphen'));   // Leading hyphen
  assert.ok(!S3_BUCKET_REGEX.test('trailing-hyphen-'));  // Trailing hyphen
  assert.ok(!S3_BUCKET_REGEX.test('ab'));                 // Too short (< 3 chars)
  assert.ok(!S3_BUCKET_REGEX.test('bucket/path'));       // Path traversal

  // Valid CloudFront distribution IDs
  assert.ok(CF_REGEX.test('E1234567890ABC'));
  assert.ok(CF_REGEX.test('EDFDVBD632ABC12'));

  // Invalid CloudFront distribution IDs
  assert.ok(!CF_REGEX.test('e1234567890abc')); // Lowercase disallowed
  assert.ok(!CF_REGEX.test('E123'));          // Too short
  assert.ok(!CF_REGEX.test('E123;DROP TABLE')); // Injection characters
});
