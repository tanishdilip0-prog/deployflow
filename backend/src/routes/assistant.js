import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { supabase } from '../db.js';
import { isUuid, fail } from '../util.js';

const router = Router();

// Redact any sensitive tokens, secrets, or keys from logs or inputs
export function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  return text
    // GitHub personal access tokens
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    // AWS Access Key IDs
    .replace(/\b(AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    // JWT tokens
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    // AWS Secret Access Keys / generic key assignments
    .replace(/(aws_secret_access_key|secret_key|password|token|bearer|api_key|secret)\s*[:=]\s*['"]?(?!\[REDACTED)[A-Za-z0-9\/+=_-]{16,}['"]?/gi, '$1=[REDACTED]')
    // Supabase anon / service role keys
    .replace(/supabase_service_role_key\s*[:=]\s*[^\s]+/gi, 'supabase_service_role_key=[REDACTED]')
    // Generic authorization headers
    .replace(/Bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

// Optional auth helper: attaches user if valid token present, otherwise null
async function identifyUser(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user) {
      return { id: data.user.id, email: data.user.email };
    }
  } catch {
    // Ignore invalid token, treated as unauthenticated
  }
  return null;
}

// System prompt for the enterprise DeployFlow CI/CD Assistant
function getSystemPrompt(deploymentContext) {
  return `You are the DeployFlow AI Assistant, an expert enterprise DevOps engineer, AWS cloud architect, and CI/CD advisor for the DeployFlow automated continuous deployment platform.

DEPLOYFLOW PLATFORM OVERVIEW:
DeployFlow is an automated continuous deployment platform that connects GitHub repositories to AWS cloud infrastructure via an isolated multi-project six-stage runner and Supabase persistence.

THE SIX PIPELINE STAGES:
1. 'checkout': Clones repository into an isolated temporary workspace (/tmp/deployflow-builds/<depId>) with shallow depth.
2. 'install': Inspects package.json. Executes dependency installation ('npm install --force --include=dev' or configured command). Marks skipped if no package file.
3. 'test': Executes project test script if defined in package.json. If tests fail, deployment halts immediately.
4. 'build': Executes project build script ('npm run build') or resolves root static assets.
5. 'deploy': Uploads build output to Amazon S3 (scoped to project prefix or bucket) with correct MIME types and Cache-Control headers (HTML: no-cache, assets: immutable). Triggers scoped Amazon CloudFront cache invalidation.
6. 'verify': Probes public HTTPS CloudFront URL to verify live HTTP 200 availability.

STRICT OPERATIONAL & SECURITY GUARDRAILS:
1. You are strictly an ADVISORY assistant. You can NEVER execute terminal commands, run shell scripts, alter code files, or modify AWS or Supabase cloud resources. Never output commands framed as auto-executable.
2. Ground all diagnosis in actual deployment logs, exit codes, and telemetry. Clearly differentiate verified facts from diagnostic hypotheses.
3. If the user asks in Tanglish (Tamil + English mixture) or asks to explain in Tanglish, reply helpfully in conversational Tanglish.
4. Keep answers professional, structured, technically rigorous, and focused on CI/CD best practices.

${deploymentContext ? `CURRENT DEPLOYMENT TELEMETRY CONTEXT:\n${deploymentContext}\n` : ''}`;
}

// Format deployment metadata, stages, and logs into a clean context string
async function fetchDeploymentContext(depId, user) {
  if (!isUuid(depId)) return null;

  // Fetch deployment record
  const { data: dep, error: depErr } = await supabase
    .from('deployments')
    .select('id, repository_id, status, branch, commit_sha, commit_message, deployment_url, build_duration_ms, error_summary, created_at, completed_at')
    .eq('id', depId)
    .maybeSingle();

  if (depErr || !dep) return null;

  // Authorization check: if user is authenticated, ensure repo belongs to them
  if (user) {
    const { data: repo } = await supabase
      .from('repositories')
      .select('owner_id, full_name')
      .eq('id', dep.repository_id)
      .maybeSingle();

    if (repo && repo.owner_id !== user.id) {
      return null; // Not authorized to view this deployment
    }
  }

  // Fetch stages
  const { data: stages } = await supabase
    .from('deployment_stages')
    .select('name, status, exit_code, duration_ms')
    .eq('deployment_id', depId);

  // Fetch logs (capped to recent 50 entries, with secret redaction)
  const { data: logs } = await supabase
    .from('deployment_logs')
    .select('stage, level, message, created_at')
    .eq('deployment_id', depId)
    .order('created_at', { ascending: true })
    .limit(50);

  const cleanLogs = (logs || []).map((l) => `[${l.stage || 'init'}][${l.level}] ${redactSecrets(l.message)}`).join('\n');

  return `Deployment ID: ${dep.id}
Status: ${dep.status}
Branch: ${dep.branch}
Commit: ${dep.commit_sha} (${dep.commit_message || 'No commit message'})
Target URL: ${dep.deployment_url || 'None'}
Duration: ${dep.build_duration_ms ? `${Math.round(dep.build_duration_ms / 1000)}s` : 'N/A'}
Error Summary: ${dep.error_summary || 'None'}
Stages:
${(stages || []).map((s) => `- ${s.name}: ${s.status.toUpperCase()} (exit: ${s.exit_code ?? '-'}, duration: ${s.duration_ms ? s.duration_ms + 'ms' : '-'})`).join('\n')}

Recent Logs:
${cleanLogs || 'No logs recorded.'}`;
}

// -------------------------------------------------------------
// GET /api/assistant/status
// Check Gemini AI configuration status
// -------------------------------------------------------------
router.get('/status', (req, res) => {
  const hasKey = Boolean(config.geminiApiKey);
  res.json({
    ok: true,
    available: hasKey,
    provider: 'Google Gemini',
    configuredModel: config.geminiModel,
    ready: hasKey,
    setupInstructions: hasKey
      ? `DeployFlow AI Assistant is online using Google Gemini (${config.geminiModel}).`
      : 'GEMINI_API_KEY is not set in backend/.env. Configure it to enable AI co-pilot assistance.'
  });
});

// -------------------------------------------------------------
// POST /api/assistant/chat
// Enterprise Gemini AI inference with secret redaction & telemetry context
// -------------------------------------------------------------
router.post('/chat', async (req, res) => {
  const { message, history = [], deployment_id } = req.body || {};

  // Input validation
  if (typeof message !== 'string' || !message.trim()) {
    return fail(res, 400, 'Message is required and must be text');
  }
  if (message.length > 2000) {
    return fail(res, 400, 'Message exceeds 2000 character limit');
  }
  if (!Array.isArray(history) || history.length > 20) {
    return fail(res, 400, 'History must be an array of up to 20 messages');
  }

  // Check Gemini API key configuration
  if (!config.geminiApiKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gemini AI Assistant is not configured on the server',
      details: 'DeployFlow AI Assistant requires a valid GEMINI_API_KEY in backend/.env.',
      setupInstructions: 'Add GEMINI_API_KEY=your_gemini_api_key in backend/.env and restart the backend server.'
    });
  }

  const user = await identifyUser(req);

  // Fetch deployment context if requested
  let deploymentContext = '';
  if (deployment_id) {
    deploymentContext = await fetchDeploymentContext(deployment_id, user);
  } else {
    // If no specific deployment requested, fetch the latest deployment context for awareness
    try {
      const { data: latest } = await supabase
        .from('deployments')
        .select('id')
        .order('created_at', { ascending: false })
        .limit(1);

      if (latest && latest[0]) {
        deploymentContext = await fetchDeploymentContext(latest[0].id, user);
      }
    } catch {
      // Ignore telemetry fetch errors
    }
  }

  const systemPrompt = getSystemPrompt(deploymentContext);

  // Build Gemini contents array with secret redaction
  const contents = [];
  for (const h of history.slice(-10)) {
    if (h && (h.role === 'user' || h.role === 'assistant' || h.role === 'model') && typeof h.content === 'string') {
      contents.push({
        role: h.role === 'assistant' ? 'model' : h.role,
        parts: [{ text: redactSecrets(h.content.slice(0, 1500)) }]
      });
    }
  }

  contents.push({
    role: 'user',
    parts: [{ text: redactSecrets(message.trim()) }]
  });

  try {
    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    const response = await ai.models.generateContent({
      model: config.geminiModel,
      contents,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.3
      }
    });

    const reply = response.text || 'DeployFlow AI Assistant was unable to generate a response.';

    res.json({
      ok: true,
      message: reply,
      model: config.geminiModel,
      provider: 'Google Gemini'
    });
  } catch (err) {
    console.error('Gemini API call failed:', err.message);
    const statusCode = err.status || 500;
    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      ok: false,
      error: 'Failed to communicate with Google Gemini API',
      details: redactSecrets(err.message || 'Unknown error occurred')
    });
  }
});

export default router;
