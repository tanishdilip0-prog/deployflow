const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const port = num(process.env.PORT, 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid PORT in .env');
  process.exit(1);
}

const missing = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error('Missing in .env: ' + missing.join(', '));
  process.exit(1);
}

try {
  new URL(process.env.SUPABASE_URL);
} catch {
  console.error('SUPABASE_URL in .env is not a valid URL');
  process.exit(1);
}

export const config = {
  port,
  env: process.env.NODE_ENV || 'development',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:3001',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  awsRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  awsProfile: process.env.AWS_PROFILE || '',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  awsSessionToken: process.env.AWS_SESSION_TOKEN || '',
  defaultS3Bucket: process.env.AWS_S3_BUCKET || '',
  defaultCloudFrontDistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID || '',
  ollamaHost: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim().replace(/\/$/, ''),
  ollamaModel: (process.env.OLLAMA_MODEL || 'llama3.2').trim(),
};