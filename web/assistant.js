/**
 * DeployFlow Enterprise AI Assistant
 * Powered by Google Gemini (@google/genai)
 */
(() => {
  'use strict';

  const API = window.DEPLOYFLOW_API || (location.port === '3001' ? '' : 'http://localhost:3001');
  let history = [];
  let isSending = false;

  // Simple safe markdown formatter for code blocks, bold, and linebreaks
  function formatMarkdown(text) {
    if (!text) return '';
    // Escape HTML entities first
    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Fenced code blocks
    escaped = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold text
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Paragraphs / line breaks
    const paragraphs = escaped.split(/\n\n+/).map(p => {
      if (p.startsWith('<pre>')) return p;
      return `<p>${p.replace(/\n/g, '<br/>')}</p>`;
    });

    return paragraphs.join('');
  }

  // Inject UI elements into document body
  function initAssistantUI() {
    if (document.getElementById('dfAiLauncher')) return;

    // Launcher button
    const launcher = document.createElement('button');
    launcher.id = 'dfAiLauncher';
    launcher.className = 'df-ai-launcher';
    launcher.setAttribute('aria-label', 'Open DeployFlow AI Assistant');
    launcher.innerHTML = `
      <span class="df-ai-launcher-icon">✦</span>
      <span>AI Assistant</span>
      <span class="df-ai-status-dot" id="dfAiStatusDot" title="Standby"></span>
    `;

    // Assistant panel
    const panel = document.createElement('div');
    panel.id = 'dfAiPanel';
    panel.className = 'df-ai-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'DeployFlow AI Assistant');
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <div class="df-ai-header">
        <div class="df-ai-header-left">
          <span style="color:#38bdf8; font-size:16px;">✦</span>
          <h3 class="df-ai-header-title">DeployFlow AI</h3>
          <span class="df-ai-header-badge" id="dfAiModelBadge">Gemini</span>
        </div>
        <div class="df-ai-header-actions">
          <button class="df-ai-btn-icon" id="dfAiClearBtn" title="Clear chat history">⟲</button>
          <button class="df-ai-btn-icon" id="dfAiCloseBtn" title="Close AI Assistant">✕</button>
        </div>
      </div>
      <div class="df-ai-quick-actions" role="toolbar" aria-label="Quick Actions">
        <button class="df-ai-pill-btn" data-prompt="Explain the 6-stage pipeline and how checkout to verify works.">✦ 6 Stages</button>
        <button class="df-ai-pill-btn" data-prompt="Analyze the latest deployment status, stages, and logs.">✦ Last Deploy</button>
        <button class="df-ai-pill-btn" data-prompt="How does DeployFlow isolate S3 prefixes and CloudFront cache invalidation?">✦ S3 & CloudFront</button>
        <button class="df-ai-pill-btn" data-prompt="What are the security boundaries and advisory guardrails in DeployFlow?">✦ Guardrails</button>
      </div>
      <div class="df-ai-messages" id="dfAiMessages">
        <div class="df-ai-msg df-ai-msg-assistant">
          <p>Hello! I am your <strong>DeployFlow AI Assistant</strong>, powered by Google Gemini.</p>
          <p>I can help you review deployment telemetry, analyze build and test logs, explain the 6-stage CI/CD pipeline, and troubleshoot AWS S3 or CloudFront configurations.</p>
        </div>
      </div>
      <div class="df-ai-disclaimer">
        <span>⚠</span> Strictly Advisory • Never executes commands or alters AWS infrastructure.
      </div>
      <form class="df-ai-input-bar" id="dfAiForm">
        <input type="text" class="df-ai-input" id="dfAiInput" placeholder="Ask about pipeline stages, logs, or AWS deployment..." maxlength="2000" autocomplete="off" />
        <button type="submit" class="df-ai-send-btn" id="dfAiSendBtn">Send</button>
      </form>
    `;

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    // Event Listeners
    launcher.addEventListener('click', () => togglePanel(true));
    document.getElementById('dfAiCloseBtn')?.addEventListener('click', () => togglePanel(false));
    document.getElementById('dfAiClearBtn')?.addEventListener('click', clearChat);

    // Keyboard navigation: Escape key closes panel
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('df-ai-open')) {
        togglePanel(false);
      }
    });

    // Quick action pills
    panel.querySelectorAll('.df-ai-pill-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prompt = btn.getAttribute('data-prompt');
        if (prompt) sendMessage(prompt);
      });
    });

    // Form submission
    const form = document.getElementById('dfAiForm');
    const input = document.getElementById('dfAiInput');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val || isSending) return;
      sendMessage(val);
      input.value = '';
    });

    checkStatus();
  }

  function togglePanel(open) {
    const panel = document.getElementById('dfAiPanel');
    const launcher = document.getElementById('dfAiLauncher');
    if (!panel) return;
    if (open) {
      panel.classList.add('df-ai-open');
      panel.setAttribute('aria-hidden', 'false');
      launcher.style.display = 'none';
      document.getElementById('dfAiInput')?.focus();
    } else {
      panel.classList.remove('df-ai-open');
      panel.setAttribute('aria-hidden', 'true');
      launcher.style.display = 'inline-flex';
    }
  }

  function appendMessage(role, content) {
    const messages = document.getElementById('dfAiMessages');
    if (!messages) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = `df-ai-msg df-ai-msg-${role}`;

    if (role === 'assistant') {
      msgDiv.innerHTML = formatMarkdown(content);
    } else {
      msgDiv.textContent = content;
    }

    messages.appendChild(msgDiv);
    messages.scrollTop = messages.scrollHeight;
  }

  function clearChat() {
    history = [];
    const messages = document.getElementById('dfAiMessages');
    if (messages) {
      messages.innerHTML = `
        <div class="df-ai-msg df-ai-msg-assistant">
          <p>Conversation reset. How can I assist with your deployments today?</p>
        </div>
      `;
    }
  }

  async function checkStatus() {
    try {
      const res = await fetch(`${API}/api/assistant/status`);
      const data = await res.json();
      const dot = document.getElementById('dfAiStatusDot');
      const badge = document.getElementById('dfAiModelBadge');

      if (data.ok && data.available) {
        if (dot) {
          dot.className = 'df-ai-status-dot online';
          dot.title = `Online (${data.configuredModel || 'Gemini'})`;
        }
        if (badge) {
          badge.textContent = data.configuredModel || 'Gemini 2.5 Flash';
        }
      } else {
        if (dot) {
          dot.className = 'df-ai-status-dot';
          dot.title = 'Standby (API key pending)';
        }
        if (badge) {
          badge.textContent = 'Gemini (Standby)';
        }
      }
    } catch {
      // Backend offline or unreachable
    }
  }

  async function sendMessage(text) {
    if (isSending || !text) return;
    isSending = true;

    appendMessage('user', text);
    const sendBtn = document.getElementById('dfAiSendBtn');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = '...';
    }

    // Temporary loading indicator
    const messages = document.getElementById('dfAiMessages');
    const loadingElem = document.createElement('div');
    loadingElem.className = 'df-ai-msg df-ai-msg-assistant';
    loadingElem.id = 'dfAiLoadingIndicator';
    loadingElem.innerHTML = '<p><em>Analyzing with Gemini...</em></p>';
    messages.appendChild(loadingElem);
    messages.scrollTop = messages.scrollHeight;

    try {
      // Optional authentication token from Supabase session if available
      const token = window.supabaseClient?.auth?.session?.()?.access_token ||
                    window.localStorage?.getItem('sb-token') || '';

      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${API}/api/assistant/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: text,
          history: history.slice(-10)
        })
      });

      loadingElem.remove();

      const data = await res.json();
      if (res.ok && data.ok) {
        appendMessage('assistant', data.message);
        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: data.message });
      } else {
        const errorMsg = data.details || data.error || 'Unable to connect to Gemini AI Assistant.';
        appendMessage('assistant', `⚠️ **Advisory Notice:** ${errorMsg}`);
      }
    } catch (err) {
      loadingElem.remove();
      appendMessage('assistant', `⚠️ **Network Error:** Could not contact backend API (${err.message}).`);
    } finally {
      isSending = false;
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      }
    }
  }

  // Initialize once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAssistantUI);
  } else {
    initAssistantUI();
  }
})();
