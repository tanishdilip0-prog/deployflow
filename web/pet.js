/**
 * DeployFlow AI Pet — Pip the DeployBot
 * Interactive pixel-art companion and local Ollama CI/CD co-pilot.
 */
(() => {
  'use strict';

  // -------------------------------------------------------------
  // 01. CONFIGURATION & PREFERENCES
  // -------------------------------------------------------------
  const STORAGE_KEY = 'deployflow_pet_prefs_v1';
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

  const defaultPrefs = {
    followCursor: !isTouchDevice,
    idleRoam: true,
    paused: false,
    sleeping: false
  };

  let prefs = { ...defaultPrefs };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) prefs = { ...defaultPrefs, ...JSON.parse(saved) };
  } catch (e) {}

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (e) {}
  }

  // -------------------------------------------------------------
  // 02. STATE & POSITION VARIABLES
  // -------------------------------------------------------------
  let currentState = 'idle';
  let stateTimeout = null;
  let bubbleTimeout = null;
  let idleTimer = null;
  let roamTimer = null;

  // Viewport position (in pixels relative to top-left)
  let currentX = window.innerWidth - 90;
  let currentY = window.innerHeight - 90;
  let targetX = currentX;
  let targetY = currentY;
  let homeCorner = 'bottom-right';

  let ollamaStatus = {
    online: false,
    configuredModel: 'llama3.2',
    availableModels: [],
    ready: false
  };

  let conversationHistory = [];

  // -------------------------------------------------------------
  // 03. PIXEL-ART SVG SPRITE TEMPLATE
  // -------------------------------------------------------------
  function getRobotSvg(state) {
    // Face expressions based on state
    let faceSvg = '';
    let antennaLed = '#c46e45'; // DeployFlow warm orange

    if (state === 'sleeping') {
      // Closed line eyes
      faceSvg = `
        <rect x="15" y="21" width="5" height="2" fill="#53647b" />
        <rect x="28" y="21" width="5" height="2" fill="#53647b" />
      `;
      antennaLed = '#758196';
    } else if (state === 'blink') {
      // Blinking dashes
      faceSvg = `
        <rect x="15" y="21" width="5" height="2" fill="#c46e45" />
        <rect x="28" y="21" width="5" height="2" fill="#c46e45" />
      `;
    } else if (state === 'laughing' || state === 'happy' || state === 'dancing') {
      // Cheerful squinting arcs (^ ^)
      faceSvg = `
        <polygon points="15,22 17,19 19,22" fill="#c46e45" />
        <polygon points="29,22 31,19 33,22" fill="#c46e45" />
        <rect x="22" y="24" width="4" height="2" fill="#c46e45" />
      `;
      antennaLed = '#ff8547';
    } else if (state === 'thinking') {
      // Eyes looking up & to the right
      faceSvg = `
        <rect x="16" y="18" width="4" height="4" fill="#ff8547" />
        <rect x="18" y="18" width="2" height="2" fill="#fffdf8" />
        <rect x="29" y="18" width="4" height="4" fill="#ff8547" />
        <rect x="31" y="18" width="2" height="2" fill="#fffdf8" />
      `;
      antennaLed = '#ff8547';
    } else if (state === 'confused') {
      // Uneven questioning eyes
      faceSvg = `
        <rect x="15" y="19" width="4" height="4" fill="#c46e45" />
        <rect x="29" y="21" width="3" height="3" fill="#c46e45" />
      `;
      antennaLed = '#a95734';
    } else if (state === 'error') {
      // Exclamation alert eyes
      faceSvg = `
        <rect x="17" y="19" width="3" height="4" fill="#b85c50" />
        <rect x="17" y="24" width="3" height="2" fill="#b85c50" />
        <rect x="28" y="19" width="3" height="4" fill="#b85c50" />
        <rect x="28" y="24" width="3" height="2" fill="#b85c50" />
      `;
      antennaLed = '#b85c50';
    } else {
      // Default open glowing pixel eyes
      faceSvg = `
        <rect x="15" y="19" width="5" height="5" fill="#c46e45" />
        <rect x="15" y="19" width="2" height="2" fill="#fffdf8" />
        <rect x="28" y="19" width="5" height="5" fill="#c46e45" />
        <rect x="28" y="19" width="2" height="2" fill="#fffdf8" />
      `;
    }

    return `
      <svg viewBox="0 0 48 48" width="56" height="56" shape-rendering="crispEdges">
        <!-- Drop Shadow -->
        <ellipse cx="24" cy="45" rx="14" ry="3" fill="#101f3a" opacity="0.18" />

        <!-- Antenna -->
        <rect x="23" y="4" width="2" height="6" fill="#142542" />
        <circle cx="24" cy="3" r="3" fill="${antennaLed}" />
        <rect x="23" y="2" width="2" height="2" fill="#fffdf8" />

        <!-- Ears / Side Bolts -->
        <rect x="8" y="17" width="3" height="7" fill="#344966" />
        <rect x="37" y="17" width="3" height="7" fill="#344966" />

        <!-- Head Chassis (Navy with Cream Bevel) -->
        <rect x="10" y="10" width="28" height="20" rx="3" fill="#101f3a" />
        <rect x="12" y="12" width="24" height="16" fill="#142542" />
        <rect x="11" y="11" width="26" height="1" fill="#f7f2e9" opacity="0.4" />

        <!-- Visor Face Plate -->
        <rect x="13" y="14" width="22" height="12" rx="1" fill="#0b1526" />
        ${faceSvg}

        <!-- Neck -->
        <rect x="22" y="30" width="4" height="2" fill="#344966" />

        <!-- Body Chassis -->
        <rect x="14" y="32" width="20" height="10" rx="2" fill="#142542" />
        <rect x="16" y="34" width="16" height="6" fill="#101f3a" />
        <!-- Body Heart/Status Meter -->
        <rect x="21" y="36" width="6" height="2" fill="#c46e45" />

        <!-- Arms -->
        <rect x="11" y="33" width="3" height="6" fill="#344966" />
        <rect x="34" y="33" width="3" height="6" fill="#344966" />

        <!-- Legs / Treads -->
        <rect x="16" y="42" width="6" height="3" rx="1" fill="#101f3a" />
        <rect x="26" y="42" width="6" height="3" rx="1" fill="#101f3a" />
      </svg>
    `;
  }

  // -------------------------------------------------------------
  // 04. DOM INJECTION
  // -------------------------------------------------------------
  function buildPetDOM() {
    // Floating Container
    const petContainer = document.createElement('div');
    petContainer.className = 'df-pet-container df-pet-state-idle';
    petContainer.id = 'dfPetContainer';
    petContainer.setAttribute('role', 'button');
    petContainer.setAttribute('tabindex', '0');
    petContainer.setAttribute('aria-label', 'Pip the DeployFlow AI Companion. Click to chat or open controls.');

    petContainer.innerHTML = `
      <div class="df-pet-speech-bubble" id="dfPetBubble" aria-live="polite">Hey, developer!</div>
      <div class="df-pet-z-particles" id="dfPetZParticles">Z z z</div>
      <div class="df-pet-inner">
        <div class="df-pet-sprite" id="dfPetSprite">
          ${getRobotSvg('idle')}
        </div>
      </div>
      <div class="df-pet-quick-menu" id="dfPetMenu" role="menu">
        <button class="df-pet-menu-btn" data-action="chat" role="menuitem">
          <span class="df-pet-menu-icon">💬</span> Chat with Pip
        </button>
        <button class="df-pet-menu-btn" data-action="dance" role="menuitem">
          <span class="df-pet-menu-icon">💃</span> Dance
        </button>
        <button class="df-pet-menu-btn" data-action="laugh" role="menuitem">
          <span class="df-pet-menu-icon">😂</span> Laugh
        </button>
        <button class="df-pet-menu-btn ${prefs.followCursor ? 'df-menu-active' : ''}" data-action="toggle-follow" role="menuitem">
          <span class="df-pet-menu-icon">🐾</span> ${prefs.followCursor ? 'Stop Following' : 'Follow Cursor'}
        </button>
        <button class="df-pet-menu-btn ${prefs.idleRoam ? 'df-menu-active' : ''}" data-action="toggle-roam" role="menuitem">
          <span class="df-pet-menu-icon">🚶</span> ${prefs.idleRoam ? 'Disable Roam' : 'Enable Roam'}
        </button>
        <button class="df-pet-menu-btn" data-action="toggle-sleep" role="menuitem">
          <span class="df-pet-menu-icon">${prefs.sleeping ? '☀️' : '💤'}</span> ${prefs.sleeping ? 'Wake Up' : 'Sleep'}
        </button>
        <button class="df-pet-menu-btn" data-action="corner" role="menuitem">
          <span class="df-pet-menu-icon">📌</span> Go to Corner
        </button>
        <button class="df-pet-menu-btn ${prefs.paused ? 'df-menu-active' : ''}" data-action="toggle-pause" role="menuitem">
          <span class="df-pet-menu-icon">${prefs.paused ? '▶️' : '⏸️'}</span> ${prefs.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
    `;

    // Chat Panel
    const chatPanel = document.createElement('div');
    chatPanel.className = 'df-chat-panel';
    chatPanel.id = 'dfChatPanel';
    chatPanel.setAttribute('role', 'dialog');
    chatPanel.setAttribute('aria-label', 'DeployFlow AI Assistant Chat');

    chatPanel.innerHTML = `
      <div class="df-chat-header">
        <div class="df-chat-title-group">
          <div class="df-chat-avatar">
            ${getRobotSvg('idle')}
          </div>
          <div class="df-chat-title-info">
            <span class="df-chat-name">Pip • DeployFlow Co-Pilot</span>
            <span class="df-chat-status-badge df-status-offline" id="dfOllamaStatusBadge">
              <span class="df-status-dot"></span> Checking Ollama...
            </span>
          </div>
        </div>
        <div class="df-chat-actions">
          <button class="df-chat-header-btn" id="dfChatClearBtn" title="Clear conversation" aria-label="Clear chat">🗑️</button>
          <button class="df-chat-header-btn" id="dfChatCloseBtn" title="Close chat" aria-label="Close chat">✕</button>
        </div>
      </div>

      <div class="df-chat-quick-actions" id="dfQuickActions">
        <button class="df-chip-btn" data-prompt="Explain my pipeline">Explain my pipeline</button>
        <button class="df-chip-btn" data-prompt="What does each stage do?">What does each stage do?</button>
        <button class="df-chip-btn" data-prompt="Explain the latest deployment">Explain latest deployment</button>
        <button class="df-chip-btn" data-prompt="Why did my deployment fail?">Why did deployment fail?</button>
        <button class="df-chip-btn" data-prompt="What does HTTP 403 mean here?">What does HTTP 403 mean?</button>
        <button class="df-chip-btn" data-prompt="Explain DeployFlow in simple English">Simple English</button>
        <button class="df-chip-btn" data-prompt="Explain this in Tanglish">Explain in Tanglish</button>
        <button class="df-chip-btn" data-prompt="What should I check next?">What should I check next?</button>
      </div>

      <div class="df-chat-messages" id="dfChatMessages">
        <div class="df-msg-row df-msg-assistant">
          <div class="df-msg-bubble">
            <p>Hey! I'm <strong>Pip</strong>, your local DeployFlow CI/CD co-pilot.</p>
            <p>I can explain your six-stage pipeline (checkout, install, test, build, deploy, verify), diagnose AWS S3/CloudFront errors, or break down recent deployment logs.</p>
          </div>
          <span class="df-msg-meta">Pip • Local AI</span>
        </div>
      </div>

      <div class="df-chat-input-bar">
        <textarea
          class="df-chat-input"
          id="dfChatInput"
          placeholder="Ask Pip about pipeline stages, AWS deployment, logs, or in Tanglish..."
          rows="1"
          aria-label="Chat message input"
        ></textarea>
        <button class="df-chat-send-btn" id="dfChatSendBtn" aria-label="Send message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    `;

    document.body.appendChild(petContainer);
    document.body.appendChild(chatPanel);

    // Initial position placement
    updatePositionStyles();
  }

  // -------------------------------------------------------------
  // 05. ANIMATION & STATE MACHINE
  // -------------------------------------------------------------
  function setPetState(state, durationMs = null) {
    if (prefs.paused && state !== 'idle') return;

    const container = document.getElementById('dfPetContainer');
    const sprite = document.getElementById('dfPetSprite');
    if (!container || !sprite) return;

    if (stateTimeout) {
      clearTimeout(stateTimeout);
      stateTimeout = null;
    }

    // Clean old state classes
    container.classList.remove(
      'df-pet-state-idle',
      'df-pet-state-walking',
      'df-pet-state-running',
      'df-pet-state-dancing',
      'df-pet-state-laughing',
      'df-pet-state-happy',
      'df-pet-state-thinking',
      'df-pet-state-working',
      'df-pet-state-sleeping',
      'df-pet-state-confused',
      'df-pet-state-error',
      'df-pet-state-greeting'
    );

    currentState = state;
    container.classList.add(`df-pet-state-${state}`);
    sprite.innerHTML = getRobotSvg(state);

    if (durationMs && durationMs > 0) {
      stateTimeout = setTimeout(() => {
        setPetState(prefs.sleeping ? 'sleeping' : 'idle');
      }, durationMs);
    }
  }

  function showBubble(text, durationMs = 3200) {
    const bubble = document.getElementById('dfPetBubble');
    if (!bubble) return;

    if (bubbleTimeout) clearTimeout(bubbleTimeout);

    bubble.textContent = text;
    bubble.classList.add('df-bubble-visible');

    bubbleTimeout = setTimeout(() => {
      bubble.classList.remove('df-bubble-visible');
    }, durationMs);
  }

  // Natural periodic blinking when idle
  function scheduleBlink() {
    setTimeout(() => {
      if (currentState === 'idle' && !prefs.sleeping && !prefs.paused) {
        const sprite = document.getElementById('dfPetSprite');
        if (sprite) sprite.innerHTML = getRobotSvg('blink');
        setTimeout(() => {
          if (currentState === 'idle' && !prefs.sleeping) {
            if (sprite) sprite.innerHTML = getRobotSvg('idle');
          }
        }, 160);
      }
      scheduleBlink();
    }, 3000 + Math.random() * 4000);
  }

  // -------------------------------------------------------------
  // 06. MOVEMENT & CURSOR FOLLOWING LOOP
  // -------------------------------------------------------------
  function clampCoordinates(x, y) {
    const minX = 16;
    const maxX = Math.max(minX, window.innerWidth - 76);
    const minY = 16;
    const maxY = Math.max(minY, window.innerHeight - 76);
    return {
      x: Math.min(Math.max(x, minX), maxX),
      y: Math.min(Math.max(y, minY), maxY)
    };
  }

  function updatePositionStyles() {
    const container = document.getElementById('dfPetContainer');
    if (!container) return;
    container.style.transform = `translate3d(${Math.round(currentX)}px, ${Math.round(currentY)}px, 0)`;
  }

  function resetToCorner(corner = 'bottom-right') {
    homeCorner = corner;
    const padding = 28;
    const clamped = clampCoordinates(window.innerWidth - 64 - padding, window.innerHeight - 64 - padding);
    targetX = clamped.x;
    targetY = clamped.y;
    currentX = clamped.x;
    currentY = clamped.y;
    updatePositionStyles();
    setPetState('idle');
    showBubble('Back at my dock!', 2000);
  }

  function animationLoop() {
    if (!prefs.paused && !prefs.sleeping) {
      const dx = targetX - currentX;
      const dy = targetY - currentY;
      const dist = Math.hypot(dx, dy);

      if (dist > 8) {
        // Determine whether walking or running
        const isRunning = dist > 260;
        const easing = isRunning ? 0.12 : 0.07;
        const moveState = isRunning ? 'running' : 'walking';

        if (currentState !== moveState && currentState !== 'dancing' && currentState !== 'laughing') {
          setPetState(moveState);
        }

        // Horizontal flip orientation
        const container = document.getElementById('dfPetContainer');
        if (container) {
          if (dx < -3) container.classList.add('df-pet-facing-left');
          else if (dx > 3) container.classList.remove('df-pet-facing-left');
        }

        currentX += dx * easing;
        currentY += dy * easing;
        updatePositionStyles();
      } else {
        if (currentState === 'walking' || currentState === 'running') {
          setPetState('idle');
        }
      }
    }

    requestAnimationFrame(animationLoop);
  }

  function onPointerMove(e) {
    resetIdleTimer();

    if (prefs.paused || prefs.sleeping || !prefs.followCursor) return;

    // Offset from cursor so the pet floats nearby without covering the pointer
    const offsetX = e.clientX > window.innerWidth - 120 ? -70 : 60;
    const offsetY = 20;

    const clamped = clampCoordinates(e.clientX + offsetX, e.clientY + offsetY);
    targetX = clamped.x;
    targetY = clamped.y;
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (roamTimer) clearTimeout(roamTimer);

    idleTimer = setTimeout(() => {
      triggerIdleRoam();
    }, 7000);
  }

  function triggerIdleRoam() {
    if (prefs.paused || prefs.sleeping || !prefs.idleRoam) return;

    // Take a small gentle walk around current spot
    const roamAngle = Math.random() * Math.PI * 2;
    const roamDist = 50 + Math.random() * 80;
    const rx = currentX + Math.cos(roamAngle) * roamDist;
    const ry = currentY + Math.sin(roamAngle) * roamDist;

    const clamped = clampCoordinates(rx, ry);
    targetX = clamped.x;
    targetY = clamped.y;

    roamTimer = setTimeout(() => {
      triggerIdleRoam();
    }, 8000 + Math.random() * 6000);
  }

  // -------------------------------------------------------------
  // 07. LOCAL OLLAMA INTEGRATION & CHAT ASSISTANT
  // -------------------------------------------------------------
  async function checkOllamaBackend() {
    const badge = document.getElementById('dfOllamaStatusBadge');
    try {
      const res = await fetch('/api/assistant/status');
      if (res.ok) {
        ollamaStatus = await res.json();
      } else {
        ollamaStatus = { online: false, configuredModel: 'llama3.2', availableModels: [], ready: false };
      }
    } catch (e) {
      ollamaStatus = { online: false, configuredModel: 'llama3.2', availableModels: [], ready: false };
    }

    if (badge) {
      if (ollamaStatus.online && ollamaStatus.ready) {
        badge.className = 'df-chat-status-badge df-status-online';
        badge.innerHTML = `<span class="df-status-dot"></span> LOCAL: ${escapeHtml(ollamaStatus.configuredModel)}`;
      } else if (ollamaStatus.online) {
        badge.className = 'df-chat-status-badge df-status-offline';
        badge.innerHTML = `<span class="df-status-dot"></span> MODEL MISSING`;
      } else {
        badge.className = 'df-chat-status-badge df-status-offline';
        badge.innerHTML = `<span class="df-status-dot"></span> OLLAMA OFFLINE`;
      }
    }
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Simple safe markdown formatting (paragraphs, code blocks, bold, lists)
  function formatMarkdown(text) {
    if (!text) return '';
    const safe = escapeHtml(text);

    // Code blocks ```...```
    const withCodeBlocks = safe.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (match, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code `...`
    const withInlineCode = withCodeBlocks.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold **...**
    const withBold = withInlineCode.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Bullet lists
    const lines = withBold.split('\n');
    let inList = false;
    let html = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${trimmed.slice(2)}</li>`;
      } else {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        if (trimmed) {
          html += `<p>${trimmed}</p>`;
        }
      }
    }
    if (inList) html += '</ul>';

    return html;
  }

  function appendChatMessage(role, content) {
    const container = document.getElementById('dfChatMessages');
    if (!container) return;

    const row = document.createElement('div');
    row.className = `df-msg-row df-msg-${role}`;

    const formatted = role === 'user' ? `<p>${escapeHtml(content)}</p>` : formatMarkdown(content);
    const author = role === 'user' ? 'You' : `Pip • ${ollamaStatus.configuredModel || 'Local AI'}`;

    row.innerHTML = `
      <div class="df-msg-bubble">${formatted}</div>
      <span class="df-msg-meta">${author}</span>
    `;

    container.appendChild(row);
    container.scrollTop = container.scrollHeight;

    // Track recent history
    conversationHistory.push({ role, content });
    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-20);
    }
  }

  function appendOfflineNotice(setupInstructions) {
    const container = document.getElementById('dfChatMessages');
    if (!container) return;

    const notice = document.createElement('div');
    notice.className = 'df-offline-card';
    notice.innerHTML = `
      <strong>Local Ollama Required</strong>
      <p>DeployFlow uses <em>strictly local Ollama</em> for secure, offline CI/CD reasoning. No cloud AI providers or external APIs are used.</p>
      <span class="df-code-snippet">brew install ollama &amp;&amp; ollama run ${escapeHtml(ollamaStatus.configuredModel || 'llama3.2')}</span>
      <p style="margin: 4px 0; font-size: 11px; color: var(--navy-600);">Once running on <code>http://127.0.0.1:11434</code>, Pip will connect automatically.</p>
      <button class="df-retry-btn" id="dfRetryOllamaBtn">🔄 Re-check Ollama Status</button>
    `;

    container.appendChild(notice);
    container.scrollTop = container.scrollHeight;

    document.getElementById('dfRetryOllamaBtn')?.addEventListener('click', async () => {
      showBubble('Checking Ollama...');
      await checkOllamaBackend();
      if (ollamaStatus.online && ollamaStatus.ready) {
        setPetState('happy', 1800);
        showBubble('Connected to local Ollama!');
        appendChatMessage('assistant', `Local model **${ollamaStatus.configuredModel}** is online and connected! How can I help you with your DeployFlow pipeline?`);
      } else {
        setPetState('confused', 1800);
        showBubble('Still offline.');
      }
    });
  }

  async function sendChatMessage(userText) {
    const text = userText.trim();
    if (!text) return;

    appendChatMessage('user', text);

    const input = document.getElementById('dfChatInput');
    const sendBtn = document.getElementById('dfChatSendBtn');
    if (input) input.value = '';
    if (sendBtn) sendBtn.disabled = true;

    // Set Pet to thinking
    setPetState('thinking');
    showBubble('Thinking...', 4000);

    // Get active auth token from parent script or window if present
    const authToken = window.DeployFlowAuthToken || localStorage.getItem('deployflow_auth_token') || '';

    // Pass active deployment ID if one is being viewed or monitored
    const activeDepId = window.activeDeploymentId || null;

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify({
          message: text,
          history: conversationHistory.slice(-10),
          deployment_id: activeDepId
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setPetState('error', 2500);
        showBubble('Ollama unavailable');
        if (res.status === 503) {
          appendOfflineNotice(data.setupInstructions || data.error);
        } else {
          appendChatMessage('assistant', `⚠️ **Error (${res.status}):** ${data.error || 'Request failed'}\n\n${data.details || ''}`);
        }
      } else {
        setPetState('happy', 2000);
        showBubble('Done!', 2000);
        appendChatMessage('assistant', data.message);
      }
    } catch (err) {
      setPetState('error', 2500);
      showBubble('Connection error');
      appendChatMessage('assistant', `⚠️ Could not reach DeployFlow backend: ${err.message}`);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.focus();
    }
  }

  // -------------------------------------------------------------
  // 08. EVENT LISTENERS & INTERACTION BINDINGS
  // -------------------------------------------------------------
  function bindPetEvents() {
    const container = document.getElementById('dfPetContainer');
    const menu = document.getElementById('dfPetMenu');
    const chatPanel = document.getElementById('dfChatPanel');
    const chatCloseBtn = document.getElementById('dfChatCloseBtn');
    const chatClearBtn = document.getElementById('dfChatClearBtn');
    const chatInput = document.getElementById('dfChatInput');
    const chatSendBtn = document.getElementById('dfChatSendBtn');
    const quickActions = document.getElementById('dfQuickActions');

    // Click Pet -> Toggle Chat Panel
    container.addEventListener('click', (e) => {
      // If clicking inside menu, let menu handler handle it
      if (e.target.closest('.df-pet-quick-menu')) return;

      if (prefs.sleeping) {
        // Wake up on click
        prefs.sleeping = false;
        savePrefs();
        setPetState('greeting', 1600);
        showBubble('I am awake!', 2200);
        return;
      }

      toggleChat();
    });

    // Right click Pet -> Toggle Quick Menu
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menu.classList.toggle('df-menu-open');
    });

    // Keyboard support: Enter / Space on container
    container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleChat();
      } else if (e.key === 'Escape') {
        closeChat();
        menu.classList.remove('df-menu-open');
      }
    });

    function toggleChat() {
      const isOpen = chatPanel.classList.contains('df-chat-open');
      if (isOpen) {
        closeChat();
      } else {
        openChat();
      }
    }

    function openChat() {
      chatPanel.classList.add('df-chat-open');
      menu.classList.remove('df-menu-open');
      checkOllamaBackend();
      setTimeout(() => chatInput?.focus(), 150);
      setPetState('greeting', 1200);
    }

    function closeChat() {
      chatPanel.classList.remove('df-chat-open');
      setPetState(prefs.sleeping ? 'sleeping' : 'idle');
    }

    chatCloseBtn?.addEventListener('click', closeChat);

    chatClearBtn?.addEventListener('click', () => {
      const msgBox = document.getElementById('dfChatMessages');
      if (msgBox) {
        msgBox.innerHTML = `
          <div class="df-msg-row df-msg-assistant">
            <div class="df-msg-bubble">
              <p>Conversation cleared. What can Pip help you with next?</p>
            </div>
            <span class="df-msg-meta">Pip • Local AI</span>
          </div>
        `;
      }
      conversationHistory = [];
      showBubble('Chat cleared', 1800);
    });

    // Quick Action Chips
    quickActions?.addEventListener('click', (e) => {
      const btn = e.target.closest('.df-chip-btn');
      if (!btn) return;
      const prompt = btn.getAttribute('data-prompt');
      if (prompt) sendChatMessage(prompt);
    });

    // Chat Send
    chatSendBtn?.addEventListener('click', () => {
      if (chatInput) sendChatMessage(chatInput.value);
    });

    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(chatInput.value);
      } else if (e.key === 'Escape') {
        closeChat();
      }
    });

    // Auto-grow textarea
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
    });

    // Quick Menu Actions
    menu?.addEventListener('click', (e) => {
      const btn = e.target.closest('.df-pet-menu-btn');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      menu.classList.remove('df-menu-open');

      switch (action) {
        case 'chat':
          openChat();
          break;
        case 'dance':
          setPetState('dancing', 3500);
          showBubble('Dancing time! 💃', 3000);
          break;
        case 'laugh':
          setPetState('laughing', 2500);
          showBubble('Haha! Good one! 😄', 2500);
          break;
        case 'toggle-follow':
          prefs.followCursor = !prefs.followCursor;
          savePrefs();
          btn.classList.toggle('df-menu-active', prefs.followCursor);
          btn.innerHTML = `<span class="df-pet-menu-icon">🐾</span> ${prefs.followCursor ? 'Stop Following' : 'Follow Cursor'}`;
          showBubble(prefs.followCursor ? 'Following you!' : 'Standing by.', 2000);
          break;
        case 'toggle-roam':
          prefs.idleRoam = !prefs.idleRoam;
          savePrefs();
          btn.classList.toggle('df-menu-active', prefs.idleRoam);
          btn.innerHTML = `<span class="df-pet-menu-icon">🚶</span> ${prefs.idleRoam ? 'Disable Roam' : 'Enable Roam'}`;
          showBubble(prefs.idleRoam ? 'Roaming enabled!' : 'Roaming off.', 2000);
          break;
        case 'toggle-sleep':
          prefs.sleeping = !prefs.sleeping;
          savePrefs();
          btn.innerHTML = `<span class="df-pet-menu-icon">${prefs.sleeping ? '☀️' : '💤'}</span> ${prefs.sleeping ? 'Wake Up' : 'Sleep'}`;
          if (prefs.sleeping) {
            setPetState('sleeping');
            showBubble('Going to sleep... Zzz', 2500);
          } else {
            setPetState('greeting', 1500);
            showBubble('Good morning!', 2200);
          }
          break;
        case 'corner':
          resetToCorner('bottom-right');
          break;
        case 'toggle-pause':
          prefs.paused = !prefs.paused;
          savePrefs();
          btn.classList.toggle('df-menu-active', prefs.paused);
          btn.innerHTML = `<span class="df-pet-menu-icon">${prefs.paused ? '▶️' : '⏸️'}</span> ${prefs.paused ? 'Resume' : 'Pause'}`;
          showBubble(prefs.paused ? 'Paused.' : 'Resumed!', 1800);
          break;
      }
    });

    // Window Events
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('resize', () => {
      const clamped = clampCoordinates(currentX, currentY);
      currentX = clamped.x;
      currentY = clamped.y;
      targetX = currentX;
      targetY = currentY;
      updatePositionStyles();
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#dfPetContainer')) {
        menu?.classList.remove('df-menu-open');
      }
    });
  }

  // -------------------------------------------------------------
  // 09. INITIALIZATION
  // -------------------------------------------------------------
  function initPet() {
    buildPetDOM();
    bindPetEvents();

    // Start in greeting state with speech bubble
    setPetState('greeting', 2400);
    showBubble('Hey developer! Ready to ship?', 3500);

    // Initial check of local Ollama status
    checkOllamaBackend();

    // Start movement loop & natural blinks
    requestAnimationFrame(animationLoop);
    scheduleBlink();
    resetIdleTimer();

    // Expose Pet API for external dashboard hooks
    window.DeployFlowPet = {
      setState: setPetState,
      showBubble,
      openChat: () => document.getElementById('dfChatPanel')?.classList.add('df-chat-open'),
      closeChat: () => document.getElementById('dfChatPanel')?.classList.remove('df-chat-open'),
      dance: () => setPetState('dancing', 3500),
      laugh: () => setPetState('laughing', 2500),
      sleep: () => { prefs.sleeping = true; savePrefs(); setPetState('sleeping'); },
      wake: () => { prefs.sleeping = false; savePrefs(); setPetState('idle'); },
      dock: resetToCorner
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPet);
  } else {
    initPet();
  }
})();
