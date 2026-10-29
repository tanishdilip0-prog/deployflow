import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  parseDestination,
  deployToS3,
  invalidateCloudFront,
  validateCloudFrontRouting
} from '../src/aws.js';

test('Multi-Project: parseDestination parses buckets and subfolder prefixes safely', () => {
  // Bucket only
  const d1 = parseDestination('my-production-bucket');
  assert.deepEqual(d1, {
    bucket: 'my-production-bucket',
    prefix: '',
    fullKey: d1.fullKey
  });
  assert.equal(d1.fullKey('index.html'), 'index.html');

  // Bucket with prefix
  const d2 = parseDestination('deployflow-automation/projects/studypilot');
  assert.equal(d2.bucket, 'deployflow-automation');
  assert.equal(d2.prefix, 'projects/studypilot');
  assert.equal(d2.fullKey('index.html'), 'projects/studypilot/index.html');
  assert.equal(d2.fullKey('/assets/app.js'), 'projects/studypilot/assets/app.js');

  // s3:// protocol stripping
  const d3 = parseDestination('s3://my-shared-bucket/app1/');
  assert.equal(d3.bucket, 'my-shared-bucket');
  assert.equal(d3.prefix, 'app1');

  // Directory traversal rejection
  assert.equal(parseDestination('my-bucket/../secret'), null);
  assert.equal(parseDestination('my-bucket/app/../../etc'), null);

  // Invalid bucket names
  assert.equal(parseDestination('UPPERCASE-BUCKET'), null);
  assert.equal(parseDestination('bucket..double-dot'), null);
  assert.equal(parseDestination(''), null);
  assert.equal(parseDestination(null), null);
});

test('Multi-Project Isolation: S3 uploads for separate projects never overwrite each other', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-test-multiproject-'));
  const project1Dir = path.join(tmpDir, 'project1');
  const project2Dir = path.join(tmpDir, 'project2');

  await fs.mkdir(project1Dir, { recursive: true });
  await fs.mkdir(project2Dir, { recursive: true });

  await fs.writeFile(path.join(project1Dir, 'index.html'), '<html>Project 1</html>');
  await fs.writeFile(path.join(project2Dir, 'index.html'), '<html>Project 2</html>');

  const s3PutCalls = [];
  const mockS3Client = {
    send: async (command) => {
      s3PutCalls.push({
        bucket: command.input.Bucket,
        key: command.input.Key,
        body: command.input.Body.toString()
      });
      return {};
    }
  };

  // Deploy Project 1 to root of dedicated bucket
  const res1 = await deployToS3(project1Dir, 'project-1-bucket', {
    prefix: '',
    s3Client: mockS3Client
  });

  // Deploy Project 2 to isolated prefix in shared bucket
  const res2 = await deployToS3(project2Dir, 'shared-bucket', {
    prefix: 'projects/studypilot',
    s3Client: mockS3Client
  });

  // Deploy Project 3 to separate prefix in same shared bucket
  const res3 = await deployToS3(project1Dir, 'shared-bucket', {
    prefix: 'projects/deployflow',
    s3Client: mockS3Client
  });

  try {
    assert.equal(res1.uploadedKeys[0], 'index.html');
    assert.equal(res2.uploadedKeys[0], 'projects/studypilot/index.html');
    assert.equal(res3.uploadedKeys[0], 'projects/deployflow/index.html');

    // Verify Project 1 and Project 2 targets do not collide
    assert.notEqual(s3PutCalls[0].bucket, s3PutCalls[1].bucket);
    assert.notEqual(s3PutCalls[1].key, s3PutCalls[2].key);

    // Verify key isolation within shared bucket
    const sharedKeys = s3PutCalls.filter((c) => c.bucket === 'shared-bucket').map((c) => c.key);
    assert.ok(sharedKeys.includes('projects/studypilot/index.html'));
    assert.ok(sharedKeys.includes('projects/deployflow/index.html'));
    assert.ok(!sharedKeys.includes('index.html'), 'Shared bucket root was not polluted');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Multi-Project: CloudFront invalidation is scoped to project prefix', async () => {
  const invalidationCalls = [];
  const mockCfClient = {
    send: async (command) => {
      invalidationCalls.push(command.input.InvalidationBatch.Paths.Items);
      return { Invalidation: { Id: 'test-invalidation-id' } };
    }
  };

  // Full root project invalidation
  await invalidateCloudFront('E123456789012', ['/*'], { cfClient: mockCfClient });
  assert.deepEqual(invalidationCalls[0], ['/*']);

  // Project with prefix only invalidates its own folder
  await invalidateCloudFront('E123456789012', ['/studypilot/*', '/studypilot'], { cfClient: mockCfClient });
  assert.deepEqual(invalidationCalls[1], ['/studypilot/*', '/studypilot']);
});

test('Multi-Project: CloudFront origin validation flags cross-project origin mismatches', async () => {
  const mockCfClient = {
    send: async (command) => {
      return {
        Distribution: {
          DistributionConfig: {
            Origins: {
              Items: [
                {
                  Id: 'deployflow-origin',
                  DomainName: 'deployflow-automation.s3.us-east-1.amazonaws.com',
                  OriginPath: ''
                }
              ]
            }
          }
        }
      };
    }
  };

  // Matching bucket
  const match = await validateCloudFrontRouting('E123456789012', 'deployflow-automation', '', { cfClient: mockCfClient });
  assert.equal(match.valid, true);

  // Mismatched bucket (Project 2 tries to use Project 1 distribution)
  const mismatch = await validateCloudFrontRouting('E123456789012', 'dilipan-cloud-resume-2026-unique', '', { cfClient: mockCfClient });
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.reason, /not match target S3 bucket/);
});
