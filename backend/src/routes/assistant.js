import { Router } from 'express';
import { config } from '../config.js';
import { supabase } from '../db.js';
import { isUuid, fail, serverError } from '../util.js';

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
    // AWS Secret Access Keys / generic key assignments (ensure we don't re-match our bracketed redactions)
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
  } catch (err) {
    // Ignore invalid token, treated as unauthenticated
  }
  return null;
}

// Query local Ollama health and model catalog
export async function checkOllama(targetModel = config.ollamaModel) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${config.ollamaHost}/api/tags`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'DeployFlow-Assistant/1.0' }
    });
    clearTimeout(timer);

    if (!res.ok) {
      return {
        online: false,
        error: `Ollama returned HTTP ${res.status}`,
        configuredModel: targetModel,
        availableModels: [],
        ready: false
      };
    }

    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name || m.model) : [];
    const modelBase = targetModel.split(':')[0];
    const ready = models.some((m) => m === targetModel || m.startsWith(`${modelBase}:`) || m.startsWith(targetModel));

    return {
      online: true,
      configuredModel: targetModel,
      availableModels: models,
      ready
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      online: false,
      error: err.name === 'AbortError' ? 'Ollama connection timed out (2.5s)' : err.message,
      configuredModel: targetModel,
      availableModels: [],
      ready: false
    };
  }
}

// System prompt explaining the actual DeployFlow application and 6-stage pipeline
function getSystemPrompt(deploymentContext) {
  return `You are Pip (also known as Byte), the friendly, brilliant, pixel-art AI engineering pet and CI/CD co-pilot for DeployFlow.

DEPLOYFLOW PLATFORM OVERVIEW:
DeployFlow is an automated continuous deployment platform that connects GitHub repositories to AWS cloud infrastructure via a custom six-stage runner and Supabase persistence.

THE SIX PIPELINE STAGES (EXACT BEHAVIOR):
1. 'checkout': Runner uses 'git clone --depth 1 --branch <branch> <url> .' into an isolated temporary workspace (/tmp/deployflow-builds/<depId>).
2. 'install': Detects package.json. If present, runs 'npm install --force --include=dev' (or custom install_command). If absent, logs 'No package.json found' and safely marks stage skipped.
3. 'test': Checks package.json scripts for 'test'. If present and not empty, executes test command (default 'npm test'). If absent, safely marks stage skipped. If tests fail, deployment stops immediately.
4. 'build': Checks package.json scripts for 'build'. If present, executes build command (default 'npm run build'). If absent, marks stage skipped and uses repository root as static website output.
5. 'deploy': Resolves output directory (dist, build, public, or root). If AWS S3 bucket configured (e.g. 'deployflow-automation'), recursively discovers assets and uploads them using AWS SDK v3 PutObjectCommand with accurate MIME types and Cache-Control headers (HTML: no-cache, assets: immutable 1yr). If CloudFront distribution configured (e.g. 'E4YPXGKH22DTH'), triggers a '/*' cache invalidation batch via CreateInvalidationCommand. If no AWS target, publishes to local preview target.
6. 'verify': Probes public CloudFront HTTPS URL (or direct S3/entrypoint) with HTTP GET. Expects HTTP 200 OK. If root returns 403 (e.g. CloudFront DefaultRootObject unset), automatically verifies entrypoint /index.html. Fails deployment if unreachable.

AWS & ARCHITECTURE DETAILS:
- AWS Region: us-east-1
- Primary S3 Bucket: deployflow-automation
- Primary CloudFront: E4YPXGKH22DTH (public domain: https://d1chawsz7an8u9.cloudfront.net/index.html)
- Origin Access Control (OAC): S3 bucket is private; CloudFront accesses S3 using AWS OAC ID E3PM0LVYHVG51I. Direct S3 website access is forbidden.
- Ingress: Webhook endpoint /api/webhooks/github validates GitHub push events with HMAC-SHA256 (x-hub-signature-256) and stores deliveries in 'webhook_deliveries' to prevent duplicate delivery processing.
- Database: Supabase PostgreSQL stores tables: repositories, deployment_configurations, deployments, deployment_stages, deployment_logs, webhook_deliveries.

RULES & CONSTRAINTS:
1. You are strictly a READ-ONLY assistant. You explain, diagnose, guide, and troubleshoot. You can NEVER trigger deployments, execute shell commands, alter code, or modify AWS/Supabase resources.
2. When explaining errors or failures, clearly distinguish confirmed evidence (from actual logs or stage exit codes) from hypotheses or suggestions. Never invent fake log messages or pretend a test failed if it was skipped.
3. If the user asks in Tanglish (Tamil + English mixture) or asks to explain in Tanglish, reply in friendly, conversational Tanglish (e.g. "DeployFlow-la 6 stages irukku...", "Build stage fail aagala, skip aairukku yen na build script illa...").
4. Keep explanations concise, practical, technical yet beginner-friendly, and maintain a cheerful pixel-pet personality.

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

  // Fetch logs (capped to recent 40 entries, with secret redaction)
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
// Check local Ollama health and model availability
// -------------------------------------------------------------
router.get('/status', async (req, res) => {
  const status = await checkOllama();
  const setupInstructions = !status.online
    ? 'Ollama is not running locally. Install via `brew install ollama`, then start it with `ollama serve` and pull a model: `ollama run llama3.2`.'
    : !status.ready
    ? `Ollama is running, but configured model "${config.ollamaModel}" is missing. Pull it with \`ollama pull ${config.ollamaModel}\`.`
    : 'Local Ollama model is ready for chat.';

  res.json({
    ok: true,
    online: status.online,
    configuredModel: status.configuredModel,
    availableModels: status.availableModels,
    ready: status.ready,
    setupInstructions
  });
});

// -------------------------------------------------------------
// POST /api/assistant/chat
// Local AI inference with Ollama
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

  const user = await identifyUser(req);

  // Check Ollama service availability
  const ollamaCheck = await checkOllama();
  if (!ollamaCheck.online) {
    return res.status(503).json({
      ok: false,
      error: 'Ollama service is not running locally',
      details: 'DeployFlow AI Companion requires a local Ollama instance running on http://127.0.0.1:11434. No cloud AI providers are used.',
      setupInstructions: '1. Install Ollama: brew install ollama\n2. Start Ollama: ollama serve\n3. Pull model: ollama run ' + config.ollamaModel
    });
  }

  if (!ollamaCheck.ready) {
    return res.status(503).json({
      ok: false,
      error: `Model "${config.ollamaModel}" is not installed in local Ollama`,
      details: `Installed models: [${ollamaCheck.availableModels.join(', ') || 'none'}].`,
      setupInstructions: `Run in terminal: ollama pull ${config.ollamaModel}`
    });
  }

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
    } catch (e) {}
  }

  const systemPrompt = getSystemPrompt(deploymentContext);

  // Format message history safely
  const formattedMessages = [
    { role: 'system', content: systemPrompt }
  ];

  for (const h of history.slice(-10)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
      formattedMessages.push({
        role: h.role,
        content: redactSecrets(h.content.slice(0, 1500))
      });
    }
  }

  formattedMessages.push({
    role: 'user',
    content: redactSecrets(message.trim())
  });

  // Call local Ollama API
  const controller = new AbortController();
  const timeoutMs = 60000; // 60s timeout for local LLM inference
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const ollamaRes = await fetch(`${config.ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: formattedMessages,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => '');
      console.error(`Ollama error (${ollamaRes.status}):`, errText);
      return res.status(502).json({
        ok: false,
        error: `Ollama returned error status ${ollamaRes.status}`,
        details: errText.slice(0, 300)
      });
    }

    const data = await ollamaRes.json();
    const reply = data.message?.content || data.response || 'Pip could not formulate a response.';

    res.json({
      ok: true,
      message: reply,
      model: config.ollamaModel,
      petReaction: 'happy'
    });
  } catch (err) {
    clearTimeout(timer);
    console.error('Ollama request failed:', err.message);
    if (err.name === 'AbortError') {
      return res.status(504).json({
        ok: false,
        error: 'Ollama request timed out after 60 seconds. The local model took too long to generate a response.'
      });
    }
    return res.status(500).json({
      ok: false,
      error: 'Failed to communicate with local Ollama service',
      details: err.message
    });
  }
});

export default router;
