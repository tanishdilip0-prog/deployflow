import path from 'node:path';
import fs from 'node:fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import { config } from './config.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.map': 'application/json'
};

export async function getFilesRecursively(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const subFiles = await getFilesRecursively(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      if (entry.name === '.DS_Store') continue;
      files.push(fullPath);
    }
  }
  return files;
}

export function getS3Client(options = {}) {
  const region = options.region || config.awsRegion || 'us-east-1';
  const clientConfig = { region };

  if (config.awsAccessKeyId && config.awsSecretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
      ...(config.awsSessionToken ? { sessionToken: config.awsSessionToken } : {})
    };
  } else if (config.awsProfile) {
    clientConfig.profile = config.awsProfile;
  }

  return new S3Client(clientConfig);
}

export function getCloudFrontClient(options = {}) {
  const region = options.region || 'us-east-1';
  const clientConfig = { region };

  if (config.awsAccessKeyId && config.awsSecretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
      ...(config.awsSessionToken ? { sessionToken: config.awsSessionToken } : {})
    };
  } else if (config.awsProfile) {
    clientConfig.profile = config.awsProfile;
  }

  return new CloudFrontClient(clientConfig);
}

export function parseDestination(destination) {
  if (!destination || typeof destination !== 'string') return null;
  const clean = destination.trim().replace(/^s3:\/\//i, '').replace(/^\/+|\/+$/g, '');
  if (!clean) return null;

  const parts = clean.split('/').map((p) => p.trim()).filter(Boolean);
  const bucket = parts[0];
  const prefix = parts.slice(1).join('/');

  // AWS S3 bucket naming validation
  const S3_BUCKET_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
  if (
    bucket.length < 3 ||
    bucket.length > 63 ||
    !S3_BUCKET_REGEX.test(bucket) ||
    bucket.includes('..') ||
    bucket.includes('.-') ||
    bucket.includes('-.') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(bucket)
  ) {
    return null;
  }

  // Prefix validation: prevent directory traversal
  if (prefix && (prefix.includes('..') || prefix.startsWith('/') || prefix.endsWith('/'))) {
    return null;
  }

  return {
    bucket,
    prefix,
    fullKey: (relPath) => (prefix ? `${prefix}/${relPath.replace(/^\/+/, '')}` : relPath.replace(/^\/+/, ''))
  };
}

export async function deployToS3(sourceDir, bucketName, options = {}) {
  const logFn = options.onLog || (() => {});
  const s3 = options.s3Client || getS3Client({ region: options.region });
  const region = options.region || config.awsRegion || 'us-east-1';
  const rawPrefix = options.prefix || '';
  const prefix = typeof rawPrefix === 'string' ? rawPrefix.replace(/^\/+|\/+$/g, '') : '';

  const files = await getFilesRecursively(sourceDir);
  if (files.length === 0) {
    throw new Error(`No files found to deploy in output directory: ${sourceDir}`);
  }

  const destinationLabel = prefix ? `s3://${bucketName}/${prefix}` : `s3://${bucketName}`;
  await logFn(`Found ${files.length} build asset(s) to upload to ${destinationLabel}...`);

  let uploadedCount = 0;
  const uploadedKeys = [];

  for (const filePath of files) {
    const relativeKey = path.relative(sourceDir, filePath).split(path.sep).join('/');
    const destinationKey = prefix ? `${prefix}/${relativeKey}` : relativeKey;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const body = await fs.readFile(filePath);

    let cacheControl = 'public, max-age=300';
    if (ext === '.html') {
      cacheControl = 'public, max-age=0, must-revalidate';
    } else if (/\.[a-f0-9]{8,}\./.test(relativeKey) || relativeKey.startsWith('assets/')) {
      cacheControl = 'public, max-age=31536000, immutable';
    }

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: destinationKey,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl
    });

    await s3.send(command);
    uploadedCount++;
    uploadedKeys.push(destinationKey);
  }

  const websiteEndpoint = region === 'us-east-1'
    ? `http://${bucketName}.s3-website-us-east-1.amazonaws.com/`
    : `http://${bucketName}.s3-website.${region}.amazonaws.com/`;
  const s3Url = prefix
    ? `https://${bucketName}.s3.${region}.amazonaws.com/${prefix}/index.html`
    : `https://${bucketName}.s3.${region}.amazonaws.com/index.html`;

  return {
    success: true,
    uploadedCount,
    uploadedKeys,
    bucket: bucketName,
    prefix,
    region,
    websiteUrl: prefix ? `${websiteEndpoint}${prefix}/` : websiteEndpoint,
    s3Url
  };
}

export async function invalidateCloudFront(distributionId, paths = ['/*'], options = {}) {
  if (!distributionId) return { skipped: true };
  const logFn = options.onLog || (() => {});
  const cf = options.cfClient || getCloudFrontClient();

  try {
    await logFn(`Requesting CloudFront cache invalidation for distribution ${distributionId}...`);
    const callerRef = `deployflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cmd = new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: callerRef,
        Paths: {
          Quantity: paths.length,
          Items: paths
        }
      }
    });

    const res = await cf.send(cmd);
    const invalidationId = res.Invalidation?.Id || 'submitted';
    await logFn(`CloudFront cache invalidation created (ID: ${invalidationId})`);
    return { success: true, invalidationId };
  } catch (err) {
    await logFn(`CloudFront invalidation note: ${err.message}. S3 deployment remains active.`, 'warn');
    return { success: false, warning: err.message };
  }
}

export async function getDistributionOrigins(distributionId, options = {}) {
  if (!distributionId) return [];
  const cf = options.cfClient || getCloudFrontClient();
  try {
    const cmd = new GetDistributionCommand({ Id: distributionId });
    const res = await cf.send(cmd);
    const origins = res.Distribution?.DistributionConfig?.Origins?.Items || [];
    return origins.map((o) => ({
      id: o.Id,
      domainName: (o.DomainName || '').toLowerCase(),
      originPath: (o.OriginPath || '').replace(/^\/+|\/+$/g, '')
    }));
  } catch (err) {
    return null;
  }
}

export async function validateCloudFrontRouting(distributionId, targetBucket, prefix = '', options = {}) {
  if (!distributionId || !targetBucket) {
    return { valid: true, skipped: true };
  }
  const logFn = options.onLog || (() => {});
  const origins = await getDistributionOrigins(distributionId, options);

  if (origins === null) {
    // Read permission denied or non-fatal inspection issue
    return { valid: true, unverified: true };
  }

  if (origins.length === 0) {
    return {
      valid: false,
      reason: `Distribution ${distributionId} has no origins configured.`
    };
  }

  const cleanBucket = targetBucket.toLowerCase();
  const matchingOrigin = origins.find((o) => o.domainName.includes(cleanBucket));

  if (!matchingOrigin) {
    const configuredOrigins = origins.map((o) => o.domainName).join(', ');
    const reason = `CloudFront distribution ${distributionId} origins (${configuredOrigins}) do not match target S3 bucket "${cleanBucket}". Serving from this distribution would serve another project's files.`;
    await logFn(reason, 'warn');
    return {
      valid: false,
      reason,
      configuredOrigins: origins
    };
  }

  // If prefix is specified, check if origin path or routing covers it
  if (prefix && matchingOrigin.originPath && matchingOrigin.originPath !== prefix) {
    await logFn(`Note: Distribution origin path "${matchingOrigin.originPath}" differs from project prefix "${prefix}". Verify path patterns.`, 'info');
  }

  return {
    valid: true,
    matchingOrigin
  };
}

export async function getCloudFrontDomain(distributionId, options = {}) {
  if (!distributionId) return null;
  const logFn = options.onLog || (() => {});
  const cf = options.cfClient || getCloudFrontClient();

  try {
    const cmd = new GetDistributionCommand({ Id: distributionId });
    const res = await cf.send(cmd);
    const domain = res.Distribution?.DomainName;
    if (domain) {
      const cleanDomain = domain.trim().toLowerCase();
      await logFn(`Resolved CloudFront distribution ${distributionId} to public domain: ${cleanDomain}`);
      return cleanDomain;
    }
    await logFn(`Distribution ${distributionId} has no domain name configured`, 'warn');
    return null;
  } catch (err) {
    await logFn(`Failed to resolve CloudFront domain for ${distributionId}: ${err.message}`, 'warn');
    return null;
  }
}

export async function verifyDeploymentUrl(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return {
      verified: res.status >= 200 && res.status < 400,
      status: res.status,
      statusText: res.statusText
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      verified: false,
      error: err.name === 'AbortError' ? `Request timed out after ${timeoutMs}ms` : err.message
    };
  }
}
