/**
 * DeployFlow — CI/CD Dashboard Application Logic
 * Integrates directly with DeployFlow Backend API and Supabase Auth/Database.
 */

document.addEventListener("DOMContentLoaded", async () => {
  const API = window.DEPLOYFLOW_API || (location.port === '3001' ? '' : 'http://localhost:3001');
  let sb = null;
  let session = null;
  let activeToken = null;
  let currentUser = null;
  let activeDeploymentId = null;
  let pollInterval = null;
  let allDeployments = [];
  let userRepositories = [];

  // -------------------------------------------------------------
  // Helpers & Formatting
  // -------------------------------------------------------------
  function getOAuthRedirectUrl() {
    if (window.location.protocol === "file:") {
      return "http://localhost:3001/";
    }
    // Return clean base URL with pathname (e.g. https://domain.cloudfront.net/ or /index.html)
    // Strip hash fragments and query params so OAuth callback lands cleanly on the app
    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    return url.toString();
  }
  function formatDuration(ms) {
    if (!ms || ms <= 0) return "—";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }

  function formatRelativeTime(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    const now = new Date();
    const sec = Math.floor((now - d) / 1000);
    if (sec < 60) return "Just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 172800) return "Yesterday";
    return d.toLocaleDateString();
  }

  function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast-item toast-${type}`;
    toast.style.cssText = `
      background: ${type === 'error' ? '#b3122e' : '#101f3a'};
      color: #fff;
      padding: 10px 18px;
      border-radius: 6px;
      margin-top: 8px;
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: fadeIn 0.3s ease;
    `;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.4s';
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }

  // -------------------------------------------------------------
  // Base UI Interactions (Smooth Scroll, Mobile Menu, Footer Year)
  // -------------------------------------------------------------
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetId = link.getAttribute("href");
      if (!targetId || targetId === "#") return;
      const target = document.querySelector(targetId);
      if (target) {
        event.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  const yearElement = document.querySelector("[data-current-year]");
  if (yearElement) yearElement.textContent = new Date().getFullYear();

  const menuButton = document.querySelector(".mobile-menu-button");
  const navigation = document.querySelector(".sidebar");
  if (menuButton && navigation) {
    menuButton.addEventListener("click", () => {
      const isOpen = navigation.classList.toggle("is-open");
      menuButton.setAttribute("aria-expanded", String(isOpen));
    });
    navigation.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        navigation.classList.remove("is-open");
        menuButton.setAttribute("aria-expanded", "false");
      });
    });
  }

  // -------------------------------------------------------------
  // Modal Manager (Auth, Deploy Trigger, Config)
  // -------------------------------------------------------------
  function createModal(id, titleHtml, bodyElem) {
    let overlay = document.getElementById(id);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = id;
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 1000;
        background: rgba(16, 31, 58, 0.6); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
      `;
      const modal = document.createElement("div");
      modal.className = "modal-box";
      modal.style.cssText = `
        background: #fffdf8; border: 1.5px solid #101f3a;
        box-shadow: 8px 8px 0 #101f3a; border-radius: 8px;
        width: min(440px, 100%); max-height: calc(100vh - 40px); overflow-y: auto;
        padding: 24px; position: relative;
        font-family: inherit; color: #101f3a;
      `;
      const closeBtn = document.createElement("button");
      closeBtn.innerHTML = "&times;";
      closeBtn.style.cssText = `
        position: absolute; right: 14px; top: 12px; background: none;
        border: none; font-size: 22px; cursor: pointer; color: #101f3a;
      `;
      closeBtn.onclick = () => overlay.remove();
      modal.appendChild(closeBtn);

      const title = document.createElement("h3");
      title.style.margin = "0 0 16px";
      title.innerHTML = titleHtml;
      modal.appendChild(title);

      modal.appendChild(bodyElem);
      overlay.appendChild(modal);

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
      });
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  // -------------------------------------------------------------
  // Auth Modal
  // -------------------------------------------------------------
  function openAuthModal() {
    const container = document.createElement("div");
    container.innerHTML = `
      <div id="authModalError" style="display:none; color:#b3122e; background:rgba(179,18,46,0.1); padding:8px; border-radius:4px; font-size:12px; margin-bottom:12px;"></div>
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">EMAIL ADDRESS</label>
      <input type="email" id="authEmailInput" placeholder="name@company.com" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:12px; font:inherit; box-sizing:border-box;">
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">PASSWORD</label>
      <input type="password" id="authPasswordInput" placeholder="••••••••" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:16px; font:inherit; box-sizing:border-box;">
      <button id="authSubmitBtn" class="button button-primary" style="width:100%; padding:10px; font-weight:600; cursor:pointer;">Sign in with Email</button>
      <div style="display:flex; align-items:center; margin:16px 0; color:#758196; font-size:11px;">
        <span style="flex:1; border-bottom:1px solid #d9cbb4;"></span>
        <span style="padding:0 8px;">OR CONTINUE WITH</span>
        <span style="flex:1; border-bottom:1px solid #d9cbb4;"></span>
      </div>
      <button id="authGithubBtn" class="button button-secondary" style="width:100%; padding:9px; margin-bottom:8px; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer;">
        <span>⌘</span> Continue with GitHub
      </button>
      <button id="authGoogleBtn" class="button button-secondary" style="width:100%; padding:9px; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer;">
        <span>G</span> Continue with Google
      </button>
    `;

    const overlay = createModal("authModal", "Sign in to DeployFlow", container);
    const errBox = container.querySelector("#authModalError");
    const emailInput = container.querySelector("#authEmailInput");
    const passInput = container.querySelector("#authPasswordInput");
    const submitBtn = container.querySelector("#authSubmitBtn");
    const ghBtn = container.querySelector("#authGithubBtn");
    const ggBtn = container.querySelector("#authGoogleBtn");

    submitBtn.onclick = async () => {
      const email = emailInput.value.trim();
      const password = passInput.value;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errBox.textContent = "Please enter a valid email address.";
        errBox.style.display = "block";
        return;
      }
      if (!password) {
        errBox.textContent = "Please enter your password.";
        errBox.style.display = "block";
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in...";
      errBox.style.display = "none";

      try {
        const res = await fetch(`${API}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!data.ok) {
          errBox.textContent = data.error || "Login failed.";
          errBox.style.display = "block";
          submitBtn.disabled = false;
          submitBtn.textContent = "Sign in with Email";
          return;
        }

        activeToken = data.access_token;
        currentUser = data.user;
        overlay.remove();
        showToast("Signed in successfully!", "success");
        updateUserUI();
        await refreshDashboard();
      } catch (err) {
        errBox.textContent = "Could not connect to backend.";
        errBox.style.display = "block";
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign in with Email";
      }
    };

    ghBtn.onclick = () => {
      if (!sb) return alert("Supabase auth initializing...");
      ghBtn.disabled = true;
      ghBtn.innerHTML = `<span>⏳</span> Connecting to GitHub...`;
      sb.auth.signInWithOAuth({
        provider: "github",
        options: {
          redirectTo: getOAuthRedirectUrl(),
          scopes: "repo read:user"
        }
      }).catch(err => {
        ghBtn.disabled = false;
        ghBtn.innerHTML = `<span>⌘</span> Continue with GitHub`;
        errBox.textContent = err?.message || "GitHub sign-in failed.";
        errBox.style.display = "block";
      });
    };

    ggBtn.onclick = () => {
      if (!sb) return alert("Supabase auth initializing...");
      ggBtn.disabled = true;
      ggBtn.innerHTML = `<span>⏳</span> Connecting to Google...`;
      sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: getOAuthRedirectUrl() }
      }).catch(err => {
        ggBtn.disabled = false;
        ggBtn.innerHTML = `<span>G</span> Continue with Google`;
        errBox.textContent = err?.message || "Google sign-in failed.";
        errBox.style.display = "block";
      });
    };
  }

  // -------------------------------------------------------------
  // Connect Repository Modal
  // -------------------------------------------------------------
  async function openConnectRepoModal() {
    if (!activeToken) {
      openAuthModal();
      return;
    }

    const container = document.createElement("div");
    container.innerHTML = `
      <div id="connectRepoMsg" style="display:none; padding:8px; border-radius:4px; font-size:12px; margin-bottom:12px;"></div>
      <div style="display:flex; gap:8px; margin-bottom:14px;">
        <button id="tabGhBtn" class="button button-primary" style="flex:1; padding:8px 12px; font-size:12px; font-weight:600; cursor:pointer;">From Authorized GitHub</button>
        <button id="tabManualBtn" class="button button-secondary" style="flex:1; padding:8px 12px; font-size:12px; font-weight:600; cursor:pointer;">Manual Entry</button>
      </div>
      <div id="connectTabContent"></div>
    `;

    const overlay = createModal("connectRepoModal", "Connect Repository to DeployFlow", container);
    const msgBox = container.querySelector("#connectRepoMsg");
    const tabGhBtn = container.querySelector("#tabGhBtn");
    const tabManualBtn = container.querySelector("#tabManualBtn");
    const contentBox = container.querySelector("#connectTabContent");

    function showMsg(text, isError) {
      msgBox.textContent = text;
      msgBox.style.display = "block";
      msgBox.style.background = isError ? "rgba(179,18,46,0.12)" : "rgba(40,167,69,0.12)";
      msgBox.style.color = isError ? "#b3122e" : "#1e7e34";
    }

    async function showGhTab() {
      tabGhBtn.className = "button button-primary";
      tabManualBtn.className = "button button-secondary";
      msgBox.style.display = "none";
      contentBox.innerHTML = `<p style="font-size:12px; color:#53647b;">Checking GitHub authorization...</p>`;

      if (!session || !session.provider_token) {
        contentBox.innerHTML = `
          <p style="font-size:12px; line-height:1.6; color:#53647b; margin-top:0;">
            To import repositories directly from your GitHub account, sign in with GitHub. Alternatively, you can use the <strong>Manual Entry</strong> tab to connect any repository by its <code>owner/repo</code> name.
          </p>
          <button id="connectGhAuthBtn" class="button button-primary" style="width:100%; padding:10px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;">
            <span>⌘</span> Authorize & Connect GitHub
          </button>
        `;
        contentBox.querySelector("#connectGhAuthBtn").onclick = () => {
          if (!sb) return alert("Supabase auth initializing...");
          const btn = contentBox.querySelector("#connectGhAuthBtn");
          btn.disabled = true;
          btn.innerHTML = `<span>⏳</span> Connecting to GitHub...`;
          sb.auth.signInWithOAuth({
            provider: "github",
            options: {
              redirectTo: getOAuthRedirectUrl(),
              scopes: "repo read:user"
            }
          }).catch(err => {
            btn.disabled = false;
            btn.innerHTML = `<span>⌘</span> Authorize & Connect GitHub`;
            showMsg(err?.message || "GitHub authorization failed.", true);
          });
        };
        return;
      }

      contentBox.innerHTML = `<p style="font-size:12px; color:#53647b;">Fetching your repositories from GitHub...</p>`;
      try {
        const res = await fetch(`${API}/api/github/repos`, {
          headers: {
            Authorization: `Bearer ${activeToken}`,
            "X-GitHub-Token": session.provider_token
          }
        });
        const data = await res.json();
        if (!data.ok || !data.data || !data.data.length) {
          contentBox.innerHTML = `
            <div style="color:#b3122e; background:rgba(179,18,46,0.08); padding:10px; border-radius:4px; font-size:12px; margin-bottom:12px;">
              ${data.error || "No repositories found for this GitHub account or token expired."}
            </div>
            <button id="reauthGhBtn" class="button button-secondary" style="width:100%; padding:9px; cursor:pointer;">
              Re-authenticate with GitHub
            </button>
          `;
          contentBox.querySelector("#reauthGhBtn").onclick = () => {
            const btn = contentBox.querySelector("#reauthGhBtn");
            btn.disabled = true;
            btn.textContent = "Connecting to GitHub...";
            sb.auth.signInWithOAuth({
              provider: "github",
              options: { redirectTo: getOAuthRedirectUrl(), scopes: "repo read:user" }
            }).catch(err => {
              btn.disabled = false;
              btn.textContent = "Re-authenticate with GitHub";
              showMsg(err?.message || "Re-authentication failed.", true);
            });
          };
          return;
        }

        const repos = data.data;
        contentBox.innerHTML = `
          <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">SELECT REPOSITORY</label>
          <select id="ghRepoSelect" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:12px; font:inherit; background:#fff; box-sizing:border-box;">
            <option value="" disabled selected>-- Select a repository to connect --</option>
            ${repos.map((r, i) => `<option value="${i}">${r.full_name}${r.private ? " (private)" : ""}</option>`).join('')}
          </select>
          <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">DEFAULT BRANCH</label>
          <input type="text" id="ghBranchInput" value="main" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:16px; font:inherit; box-sizing:border-box;">
          <button id="ghConnectSubmitBtn" class="button button-primary" style="width:100%; padding:10px; font-weight:600; cursor:pointer;" disabled>
            Connect Repository
          </button>
        `;

        const sel = contentBox.querySelector("#ghRepoSelect");
        const branchIn = contentBox.querySelector("#ghBranchInput");
        const submitBtn = contentBox.querySelector("#ghConnectSubmitBtn");

        sel.onchange = () => {
          if (!sel.value) {
            submitBtn.disabled = true;
            return;
          }
          const chosen = repos[parseInt(sel.value, 10)];
          if (chosen) {
            branchIn.value = chosen.default_branch || "main";
            submitBtn.disabled = false;
          }
        };

        submitBtn.onclick = async () => {
          if (!sel.value) return;
          const chosen = repos[parseInt(sel.value, 10)];
          if (!chosen) return;
          await submitConnection(chosen.full_name, branchIn.value.trim() || "main", submitBtn);
        };
      } catch (err) {
        contentBox.innerHTML = `<p style="font-size:12px; color:#b3122e;">Could not connect to GitHub API.</p>`;
      }
    }

    function showManualTab() {
      tabGhBtn.className = "button button-secondary";
      tabManualBtn.className = "button button-primary";
      msgBox.style.display = "none";
      contentBox.innerHTML = `
        <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">REPOSITORY (OWNER/REPO)</label>
        <input type="text" id="manualRepoInput" placeholder="e.g. acme/web-app" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:12px; font:inherit; box-sizing:border-box;">
        <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">DEFAULT BRANCH</label>
        <input type="text" id="manualBranchInput" value="main" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:16px; font:inherit; box-sizing:border-box;">
        <button id="manualConnectSubmitBtn" class="button button-primary" style="width:100%; padding:10px; font-weight:600; cursor:pointer;">
          Connect Repository
        </button>
      `;

      const repoIn = contentBox.querySelector("#manualRepoInput");
      const branchIn = contentBox.querySelector("#manualBranchInput");
      const submitBtn = contentBox.querySelector("#manualConnectSubmitBtn");

      submitBtn.onclick = async () => {
        const full_name = repoIn.value.trim();
        const branch = branchIn.value.trim() || "main";
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full_name)) {
          showMsg("Repository must be in 'owner/repo' format (e.g. acme/web-app)", true);
          return;
        }
        await submitConnection(full_name, branch, submitBtn);
      };
    }

    async function submitConnection(full_name, branch, btnElem) {
      btnElem.disabled = true;
      btnElem.textContent = "Connecting...";
      msgBox.style.display = "none";

      try {
        const res = await fetch(`${API}/api/repositories`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${activeToken}`
          },
          body: JSON.stringify({ full_name, branch })
        });
        const d = await res.json();
        if (!d.ok) {
          btnElem.disabled = false;
          btnElem.textContent = "Connect Repository";
          showMsg(d.error || "Failed to connect repository", true);
          return;
        }

        showToast(`Connected ${full_name} successfully!`, "success");
        overlay.remove();
        await refreshDashboard();
      } catch (err) {
        btnElem.disabled = false;
        btnElem.textContent = "Connect Repository";
        showMsg("Network error connecting to backend.", true);
      }
    }

    tabGhBtn.onclick = showGhTab;
    tabManualBtn.onclick = showManualTab;

    if (session && session.provider_token) {
      showGhTab();
    } else {
      showManualTab();
    }
  }

  // -------------------------------------------------------------
  // Trigger Deployment Modal
  // -------------------------------------------------------------
  function openDeployModal() {
    if (!activeToken) {
      openAuthModal();
      return;
    }
    const container = document.createElement("div");
    if (!userRepositories.length) {
      container.innerHTML = `
        <p style="font-size:13px; line-height:1.6; margin-bottom:16px;">
          No repositories are currently connected to DeployFlow. Connect a repository first to trigger automated deployments.
        </p>
        <button id="modalConnectRepoBtn" class="button button-primary" style="width:100%; padding:10px; font-weight:600; cursor:pointer;">
          + Connect a Repository
        </button>
      `;
      const overlay = createModal("deployModal", "No Repositories Connected", container);
      container.querySelector("#modalConnectRepoBtn").onclick = () => {
        overlay.remove();
        openConnectRepoModal();
      };
      return;
    }

    container.innerHTML = `
      <div id="deployModalError" style="display:none; color:#b3122e; background:rgba(179,18,46,0.1); padding:8px; border-radius:4px; font-size:12px; margin-bottom:12px;"></div>
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">REPOSITORY</label>
      <select id="modalRepoSelect" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:12px; font:inherit; background:#fff; box-sizing:border-box;">
        <option value="" disabled selected>-- Select a repository to deploy --</option>
        ${userRepositories.map(r => `<option value="${r.id}" data-branch="${r.branch}">${r.full_name}</option>`).join('')}
      </select>
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">BRANCH</label>
      <input type="text" id="modalBranchInput" value="main" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:12px; font:inherit; box-sizing:border-box;">
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">COMMIT MESSAGE (OPTIONAL)</label>
      <input type="text" id="modalMessageInput" placeholder="Manual release from dashboard" style="width:100%; padding:10px; border:1px solid #101f3a; border-radius:4px; margin-bottom:16px; font:inherit; box-sizing:border-box;">
      <button id="modalTriggerBtn" class="button button-primary" style="width:100%; padding:10px; font-weight:600; cursor:pointer;" disabled>
        ▶ Queue & Execute Deployment
      </button>
    `;

    const overlay = createModal("deployModal", "Trigger Manual Deployment", container);
    const repoSelect = container.querySelector("#modalRepoSelect");
    const branchInput = container.querySelector("#modalBranchInput");
    const msgInput = container.querySelector("#modalMessageInput");
    const triggerBtn = container.querySelector("#modalTriggerBtn");
    const errBox = container.querySelector("#deployModalError");

    repoSelect.onchange = () => {
      const selected = repoSelect.options[repoSelect.selectedIndex];
      if (selected && repoSelect.value) {
        branchInput.value = selected.getAttribute("data-branch") || "main";
        triggerBtn.disabled = false;
      } else {
        triggerBtn.disabled = true;
      }
    };

    triggerBtn.onclick = async () => {
      if (!repoSelect.value) {
        errBox.textContent = "Please select a repository to deploy.";
        errBox.style.display = "block";
        return;
      }
      triggerBtn.disabled = true;
      triggerBtn.textContent = "Queueing deployment...";
      errBox.style.display = "none";

      try {
        const res = await fetch(`${API}/api/deployments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${activeToken}`
          },
          body: JSON.stringify({
            repository_id: repoSelect.value,
            branch: branchInput.value.trim() || "main",
            commit_sha: "0000000",
            commit_message: msgInput.value.trim() || "Manual release from dashboard"
          })
        });
        const data = await res.json();
        if (!data.ok) {
          errBox.textContent = data.error || "Failed to trigger deployment";
          errBox.style.display = "block";
          triggerBtn.disabled = false;
          triggerBtn.textContent = "Queue & Execute Deployment";
          return;
        }

        overlay.remove();
        showToast("Deployment queued! Live runner started.", "success");
        activeDeploymentId = data.data.id;
        await refreshDashboard();
        startLivePolling();
      } catch (err) {
        errBox.textContent = "Network error connecting to backend.";
        errBox.style.display = "block";
        triggerBtn.disabled = false;
        triggerBtn.textContent = "Queue & Execute Deployment";
      }
    };
  }

  // -------------------------------------------------------------
  // Settings / Repository Configuration Modal
  // -------------------------------------------------------------
  async function openSettingsModal() {
    if (!activeToken) {
      openAuthModal();
      return;
    }
    if (!userRepositories.length) {
      showToast("No connected repositories found. Connect a repository first.", "info");
      return;
    }

    let selectedRepoId = userRepositories[0].id;
    let config = { install_command: "npm ci", test_command: "npm test", build_command: "npm run build", output_dir: "dist" };

    const container = document.createElement("div");
    container.innerHTML = `
      <div id="settingsMsg" style="display:none; padding:8px; border-radius:4px; font-size:12px; margin-bottom:12px;"></div>
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">REPOSITORY</label>
      <select id="settingsRepoSelect" style="width:100%; padding:8px; border:1px solid #101f3a; border-radius:4px; margin-bottom:12px; font:inherit; background:#fff; box-sizing:border-box;">
        ${userRepositories.map(r => `<option value="${r.id}">${r.full_name}</option>`).join('')}
      </select>
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">INSTALL COMMAND</label>
      <input type="text" id="cfgInstall" value="${config.install_command}" style="width:100%; padding:8px; border:1px solid #101f3a; border-radius:4px; margin-bottom:10px; font:inherit; box-sizing:border-box;">
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">TEST COMMAND</label>
      <input type="text" id="cfgTest" value="${config.test_command}" style="width:100%; padding:8px; border:1px solid #101f3a; border-radius:4px; margin-bottom:10px; font:inherit; box-sizing:border-box;">
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">BUILD COMMAND</label>
      <input type="text" id="cfgBuild" value="${config.build_command}" style="width:100%; padding:8px; border:1px solid #101f3a; border-radius:4px; margin-bottom:10px; font:inherit; box-sizing:border-box;">
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">OUTPUT DIRECTORY</label>
      <input type="text" id="cfgOutput" value="${config.output_dir}" style="width:100%; padding:8px; border:1px solid #101f3a; border-radius:4px; margin-bottom:10px; font:inherit; box-sizing:border-box;">
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">AWS S3 BUCKET (OPTIONAL FOR CLOUD DEPLOY)</label>
      <input type="text" id="cfgS3Bucket" placeholder="e.g. dilipan-cloud-resume-2026-unique" style="width:100%; padding:8px; border:1px solid #101f3a; border-radius:4px; margin-bottom:10px; font:inherit; box-sizing:border-box;">
      <label style="display:block; font-size:11px; font-weight:700; margin-bottom:4px; color:#53647b;">CLOUDFRONT DISTRIBUTION ID (OPTIONAL)</label>
      <input type="text" id="cfgCloudFront" placeholder="e.g. E1234567890ABC" style="width:100%; padding:8px; border:1px solid #101f3a; border-radius:4px; margin-bottom:16px; font:inherit; box-sizing:border-box;">
      <button id="saveConfigBtn" class="button button-primary" style="width:100%; padding:10px; font-weight:600; cursor:pointer;">
        Save Configuration
      </button>
    `;

    createModal("settingsModal", "Build & Pipeline Settings", container);
    const repoSelect = container.querySelector("#settingsRepoSelect");
    const saveBtn = container.querySelector("#saveConfigBtn");
    const msgBox = container.querySelector("#settingsMsg");
    const cfgInstall = container.querySelector("#cfgInstall");
    const cfgTest = container.querySelector("#cfgTest");
    const cfgBuild = container.querySelector("#cfgBuild");
    const cfgOutput = container.querySelector("#cfgOutput");
    const cfgS3Bucket = container.querySelector("#cfgS3Bucket");
    const cfgCloudFront = container.querySelector("#cfgCloudFront");

    async function loadConfigForRepo(repoId) {
      try {
        const res = await fetch(`${API}/api/repositories/${repoId}/config`, {
          headers: { Authorization: `Bearer ${activeToken}` }
        });
        const d = await res.json();
        if (d.ok && d.data) {
          cfgInstall.value = d.data.install_command || "npm ci";
          cfgTest.value = d.data.test_command || "npm test";
          cfgBuild.value = d.data.build_command || "npm run build";
          cfgOutput.value = d.data.output_dir || "dist";
          cfgS3Bucket.value = d.data.s3_bucket || "";
          cfgCloudFront.value = d.data.cloudfront_distribution_id || "";
        }
      } catch (e) {}
    }

    await loadConfigForRepo(selectedRepoId);

    repoSelect.onchange = async () => {
      selectedRepoId = repoSelect.value;
      await loadConfigForRepo(selectedRepoId);
    };

    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      msgBox.style.display = "none";
      try {
        const res = await fetch(`${API}/api/repositories/${selectedRepoId}/config`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${activeToken}`
          },
          body: JSON.stringify({
            install_command: cfgInstall.value.trim(),
            test_command: cfgTest.value.trim(),
            build_command: cfgBuild.value.trim(),
            output_dir: cfgOutput.value.trim(),
            s3_bucket: cfgS3Bucket.value.trim() || null,
            cloudfront_distribution_id: cfgCloudFront.value.trim() || null
          })
        });
        const d = await res.json();
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Configuration";
        if (d.ok) {
          msgBox.textContent = "Configuration updated successfully!";
          msgBox.style.background = "rgba(40,167,69,0.15)";
          msgBox.style.color = "#1e7e34";
          msgBox.style.display = "block";
        } else {
          msgBox.textContent = d.error || "Save failed";
          msgBox.style.background = "rgba(179,18,46,0.15)";
          msgBox.style.color = "#b3122e";
          msgBox.style.display = "block";
        }
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Configuration";
        msgBox.textContent = "Network error";
        msgBox.style.display = "block";
      }
    };
  }

  // -------------------------------------------------------------
  // Data Fetching & UI Updates
  // -------------------------------------------------------------
  function updateUserUI() {
    const avatar = document.getElementById("sidebarAvatar");
    const nameElem = document.getElementById("sidebarUserName");
    const emailElem = document.getElementById("sidebarUserEmail");
    const authBtn = document.getElementById("authButton");
    const envBadge = document.getElementById("envBadgeText");

    if (currentUser) {
      const email = currentUser.email || "developer@deployflow.dev";
      const initial = email.charAt(0).toUpperCase();
      if (avatar) avatar.textContent = initial;
      if (nameElem) nameElem.textContent = email.split('@')[0];
      if (emailElem) emailElem.textContent = email;
      if (authBtn) {
        authBtn.textContent = "Sign out";
        authBtn.className = "button button-secondary";
      }
      if (envBadge) envBadge.textContent = "CONNECTED (SUPABASE)";
    } else {
      if (avatar) avatar.textContent = "DF";
      if (nameElem) nameElem.textContent = "Developer";
      if (emailElem) emailElem.textContent = "Signed out";
      if (authBtn) {
        authBtn.textContent = "Sign in";
        authBtn.className = "button button-primary";
      }
      if (envBadge) envBadge.textContent = "DEMO / SIGNED OUT";
    }
    updateIntegrationsUI();
  }

  function updateIntegrationsUI() {
    const ghState = document.getElementById("githubIntegrationState");
    const ghAction = document.getElementById("githubIntegrationAction");

    if (userRepositories && userRepositories.length > 0) {
      if (ghState) {
        ghState.textContent = "CONNECTED";
        ghState.className = "integration-state integration-state-active";
      }
      if (ghAction) {
        ghAction.textContent = `${userRepositories[0].full_name} (${userRepositories[0].branch || 'main'})`;
      }
    } else {
      if (ghState) {
        ghState.textContent = "ACTIVE";
        ghState.className = "integration-state integration-state-active";
      }
      if (ghAction) {
        ghAction.textContent = "Connected repositories";
      }
    }
  }

  async function fetchRepositories() {
    if (!activeToken) return [];
    try {
      const res = await fetch(`${API}/api/repositories?limit=50`, {
        headers: { Authorization: `Bearer ${activeToken}` }
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        userRepositories = data.data;
        updateIntegrationsUI();
        renderProjectCards(userRepositories);
        return data.data;
      }
    } catch (e) {
      console.warn("Could not fetch repositories:", e.message);
    }
    return [];
  }

  async function fetchDeployments() {
    if (!activeToken) return [];
    try {
      const res = await fetch(`${API}/api/deployments?limit=50`, {
        headers: { Authorization: `Bearer ${activeToken}` }
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        allDeployments = data.data;
        return data.data;
      }
    } catch (e) {
      console.warn("Could not fetch deployments:", e.message);
    }
    return [];
  }

  function renderMetrics(deployments) {
    const totalElem = document.getElementById("totalDeployments");
    const rateElem = document.getElementById("successRate");
    const avgElem = document.getElementById("averageBuild");
    const envElem = document.getElementById("activeEnvironments");
    const sidebarCount = document.getElementById("sidebarDeploymentCount");
    const tableCount = document.getElementById("deploymentTableCount");

    const total = deployments.length;
    if (sidebarCount) sidebarCount.textContent = String(total).padStart(2, '0');
    if (tableCount) tableCount.textContent = String(total).padStart(2, '0');
    if (totalElem) totalElem.textContent = String(total);

    if (total === 0) {
      if (rateElem) rateElem.innerHTML = `100<span>%</span>`;
      if (avgElem) avgElem.innerHTML = `—`;
      if (envElem) envElem.textContent = `01`;
      return;
    }

    const successful = deployments.filter(d => d.status === 'success').length;
    const rate = Math.round((successful / total) * 100);
    if (rateElem) rateElem.innerHTML = `${rate}<span>%</span>`;

    const timed = deployments.filter(d => d.build_duration_ms > 0);
    if (timed.length > 0) {
      const avgMs = Math.round(timed.reduce((a, b) => a + b.build_duration_ms, 0) / timed.length);
      const totalSec = Math.floor(avgMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      if (avgElem) avgElem.innerHTML = `${String(m).padStart(2, '0')}<span>m</span> ${String(s).padStart(2, '0')}<span>s</span>`;
    }

    const branches = new Set(deployments.map(d => d.branch)).size;
    if (envElem) envElem.textContent = String(branches).padStart(2, '0');
  }

  function renderProjectCards(repos) {
    const grid = document.getElementById("projectsGrid");
    const countElem = document.getElementById("sidebarProjectCount");
    if (countElem) {
      countElem.textContent = String(repos?.length || 0).padStart(2, '0');
    }
    if (!grid) return;

    if (!repos || !repos.length) {
      grid.innerHTML = `
        <div class="projects-empty" id="projectsEmpty">
          <span class="projects-empty-icon">▦</span>
          <p>No repositories connected yet.</p>
          <button class="btn btn-primary" onclick="document.getElementById('deployButton')?.click()">Connect a repository</button>
        </div>
      `;
      return;
    }

    grid.innerHTML = repos.map(repo => {
      const cfg = repo.config || {};
      const latest = repo.latest_deployment || null;
      const status = latest?.status || 'idle';
      const statusClass = ['success', 'failed'].includes(status) ? status : (status === 'idle' ? 'idle' : 'building');
      const branch = latest?.branch || repo.default_branch || 'main';
      const commitSha = latest?.commit_hash ? latest.commit_hash.slice(0, 7) : '—';
      const commitMsg = latest?.commit_message ? escapeHtml(latest.commit_message) : 'No recent commits';
      
      const s3Dest = cfg.s3_bucket ? escapeHtml(cfg.s3_bucket) : 'Local Preview Only';
      const cfDomain = cfg.cloudfront_distribution_id ? escapeHtml(cfg.cloudfront_distribution_id) : 'Direct S3 / None';
      const liveUrl = latest?.deployment_url || (latest?.status === 'success' && cfg.cloudfront_distribution_id ? `https://${cfg.cloudfront_distribution_id}.cloudfront.net` : null);

      return `
        <div class="project-card" data-repo-id="${escapeHtml(repo.id)}">
          <div class="project-card-header">
            <h3 class="project-repo-title">
              <span class="project-repo-icon">⌥</span>
              <span>${escapeHtml(repo.full_name || repo.name)}</span>
            </h3>
            <span class="project-badge-pill ${statusClass}">${escapeHtml(status)}</span>
          </div>

          <div class="project-card-meta">
            <div class="project-meta-row">
              <strong>Branch</strong>
              <span class="project-meta-val">${escapeHtml(branch)}</span>
            </div>
            <div class="project-meta-row">
              <strong>Commit</strong>
              <span class="project-meta-val" title="${commitMsg}">${commitSha} (${commitMsg})</span>
            </div>
            <div class="project-meta-row">
              <strong>S3 Destination</strong>
              <span class="project-meta-val" title="${s3Dest}">s3://${s3Dest}</span>
            </div>
            <div class="project-meta-row">
              <strong>Distribution</strong>
              <span class="project-meta-val">${cfDomain}</span>
            </div>
          </div>

          <div class="project-card-actions">
            ${liveUrl ? `<a href="${escapeHtml(liveUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">Open Live</a>` : ''}
            <button class="btn btn-primary" onclick="openDeployModalForRepo('${escapeHtml(repo.id)}')">Deploy</button>
            ${latest?.id ? `<button class="btn btn-secondary" onclick="viewDeploymentDetails('${escapeHtml(latest.id)}')">Logs</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  window.openDeployModalForRepo = function(repoId) {
    const modal = document.getElementById("deployModal");
    const select = document.getElementById("deployRepoSelect");
    if (select) select.value = repoId;
    if (modal) modal.classList.add("active");
  };

  function renderDeploymentsTable(deployments) {
    const tbody = document.getElementById("deploymentTableBody");
    if (!tbody) return;

    if (!deployments.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center; padding:24px; color:#758196;">
            No deployments recorded yet. Click "Trigger deployment" above to launch your first pipeline.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = deployments.map(d => {
      const isSuccess = d.status === 'success';
      const isFailed = d.status === 'failed';
      const isRunning = ['queued', 'cloning', 'installing', 'testing', 'building', 'deploying'].includes(d.status);
      const pillClass = isSuccess ? 'status-success' : (isFailed ? 'status-failed' : 'status-running');
      const icon = isSuccess ? '↗' : (isFailed ? '!' : '↻');
      const iconClass = isFailed ? 'release-mark-failed' : '';
      const displayMsg = escapeHtml(d.commit_message || d.id.slice(0, 8));
      const displayBranch = escapeHtml(d.branch || 'main');
      const displaySha = escapeHtml((d.commit_sha || '').slice(0, 7));
      const displayTrigger = escapeHtml((d.trigger_source || 'manual').toUpperCase());
      const displayStatus = escapeHtml((d.status || 'unknown').toUpperCase());

      return `
        <tr data-id="${escapeHtml(d.id)}" data-status="${escapeHtml(d.status)}" style="cursor:pointer;" class="${d.id === activeDeploymentId ? 'is-active-row' : ''}">
          <td>
            <div class="release-cell">
              <div>
                <strong>${displayMsg}</strong>
                <span>${displayTrigger}</span>
              </div>
            </div>
          </td>
          <td><span class="branch-label">${displayBranch}</span></td>
          <td><code>${displaySha}</code></td>
          <td><span class="status-pill ${pillClass}">${displayStatus}</span></td>
          <td class="mono-cell">${formatDuration(d.build_duration_ms)}</td>
          <td class="time-cell">${formatRelativeTime(d.created_at)}</td>
        </tr>
      `;
    }).join('');

    // Attach row click listeners to view detail and logs
    tbody.querySelectorAll("tr[data-id]").forEach(row => {
      row.onclick = () => {
        const id = row.getAttribute("data-id");
        activeDeploymentId = id;
        tbody.querySelectorAll("tr").forEach(r => r.classList.remove("is-active-row"));
        row.classList.add("is-active-row");
        updatePipelineView();
        fetchLogs(id);
      };
    });
  }

  // -------------------------------------------------------------
  // Pipeline Stages View
  // -------------------------------------------------------------
  async function updatePipelineView() {
    if (!allDeployments.length) return;
    const current = allDeployments.find(d => d.id === activeDeploymentId) || allDeployments[0];
    if (!current) return;

    activeDeploymentId = current.id;
    const statusBanner = document.getElementById("pipelineStatus");
    if (statusBanner) {
      statusBanner.innerHTML = `<span class="status-indicator"></span> ${escapeHtml(current.status.toUpperCase())}`;
    }

    const footerTitle = document.getElementById("pipelineFooterTitle");
    const footerText = document.getElementById("pipelineFooterText");

    if (current.status === 'success' && current.deployment_url) {
      if (footerTitle) footerTitle.textContent = "Deployment Succeeded";
      if (footerText) {
        footerText.textContent = '';
        const safeUrl = sanitizeUrl(current.deployment_url);
        if (safeUrl) {
          const link = document.createElement('a');
          link.href = safeUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.style.cssText = "color:var(--green-500); font-weight:700; text-decoration:underline;";
          link.textContent = `View Live Application ↗ (${safeUrl})`;
          footerText.appendChild(link);
        } else {
          footerText.textContent = `Artifacts published to ${current.deployment_url}`;
        }
      }
    } else if (current.status === 'failed') {
      if (footerTitle) footerTitle.textContent = "Deployment Failed";
      if (footerText) footerText.textContent = current.error_summary || "Pipeline interrupted during execution.";
    } else if (['cloning', 'installing', 'testing', 'building', 'deploying', 'queued'].includes(current.status)) {
      if (footerTitle) footerTitle.textContent = `Pipeline Active: ${current.status.toUpperCase()}`;
      if (footerText) footerText.textContent = "Processing automated stages in isolated build container...";
    }

    // Fetch individual stage records
    try {
      const res = await fetch(`${API}/api/deployments/${current.id}`, {
        headers: { Authorization: `Bearer ${activeToken}` }
      });
      const data = await res.json();
      if (data.ok && data.data && data.data.stages) {
        const stages = data.data.stages;
        const stageNames = ['checkout', 'install', 'test', 'build', 'deploy', 'verify'];
        stageNames.forEach(name => {
          applyStageState(name, stages.find(s => s.name === name));
        });
        // Backwards compatibility for older stage keys
        applyStageState("source", stages.find(s => s.name === 'checkout'));
        applyStageState("auth", stages.find(s => s.name === 'build'));
      }
    } catch (e) {}
  }

  function applyStageState(stageKey, stageData) {
    const stateElem = document.getElementById(`state-${stageKey}`);
    const stageArticle = document.querySelector(`.pipeline-stage[data-stage="${stageKey}"]`);
    if (!stateElem || !stageArticle) return;

    const st = stageData ? stageData.status : 'pending';
    stageArticle.classList.remove('is-running', 'is-success', 'is-failed');

    if (st === 'running') {
      stageArticle.classList.add('is-running');
      stateElem.textContent = "RUNNING";
    } else if (st === 'success' || st === 'skipped') {
      stageArticle.classList.add('is-success');
      stateElem.textContent = st === 'skipped' ? "SKIPPED" : "SUCCESS";
    } else if (st === 'failed') {
      stageArticle.classList.add('is-failed');
      stateElem.textContent = "FAILED";
    } else {
      stateElem.textContent = "WAITING";
    }
  }

  // -------------------------------------------------------------
  // Terminal Logs Streaming
  // -------------------------------------------------------------
  async function fetchLogs(deploymentId) {
    if (!deploymentId || !activeToken) return;
    const terminal = document.getElementById("terminalOutput");
    const countElem = document.getElementById("terminalLineCount");
    if (!terminal) return;

    try {
      const res = await fetch(`${API}/api/deployments/${deploymentId}/logs`, {
        headers: { Authorization: `Bearer ${activeToken}` }
      });
      const data = await res.json();
      if (!data.ok || !data.data) return;

      const logs = data.data;
      if (countElem) countElem.textContent = `${String(logs.length).padStart(2, '0')} LINES`;

      if (!logs.length) {
        terminal.innerHTML = `
          <p class="terminal-line"><span class="terminal-muted">[00:00:01]</span> <span class="terminal-green">INFO</span> Waiting for runner output...</p>
          <p class="terminal-prompt"><span>deployflow</span> $ <span class="cursor">_</span></p>
        `;
        return;
      }

      terminal.innerHTML = logs.map(l => {
        const time = new Date(l.created_at).toTimeString().split(' ')[0];
        const tagClass = l.level === 'error' ? 'terminal-red' : (l.level === 'warn' ? 'terminal-orange' : 'terminal-green');
        return `
          <p class="terminal-line">
            <span class="terminal-muted">[${time}]</span>
            <span class="${tagClass}">${l.level.toUpperCase()}</span>
            ${escapeHtml(l.message)}
          </p>
        `;
      }).join('') + `<p class="terminal-prompt"><span>deployflow</span> $ <span class="cursor">_</span></p>`;

      terminal.scrollTop = terminal.scrollHeight;
    } catch (e) {}
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (/^https?:\/\/[a-zA-Z0-9_.~:/?#\[\]@!$&'()*+,;=-]+$/i.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  // -------------------------------------------------------------
  // Activity Log Stream
  // -------------------------------------------------------------
  function renderActivityLog(deployments) {
    const list = document.getElementById("activityList");
    if (!list) return;

    if (!deployments.length) {
      list.innerHTML = `
        <article class="activity-item">
          <span class="activity-marker activity-marker-neutral">⌘</span>
          <div class="activity-content">
            <strong>No activity recorded</strong>
            <p>Connect a repository and trigger a build to view live events.</p>
          </div>
        </article>
      `;
      return;
    }

    list.innerHTML = deployments.slice(0, 5).map(d => {
      const isSuccess = d.status === 'success';
      const isFailed = d.status === 'failed';
      const markerClass = isSuccess ? 'activity-marker-green' : (isFailed ? 'activity-marker-orange' : 'activity-marker-neutral');
      const icon = isSuccess ? '✓' : (isFailed ? '!' : '↻');
      const title = isSuccess ? 'Deployment succeeded' : (isFailed ? 'Deployment failed' : `Deployment ${escapeHtml(d.status)}`);
      const msg = escapeHtml(d.commit_message || (d.commit_sha ? d.commit_sha.slice(0, 7) : d.id.slice(0, 8)));
      const branch = escapeHtml(d.branch || 'main');

      return `
        <article class="activity-item" style="cursor:pointer;" onclick="window.DFSelectDeployment && window.DFSelectDeployment('${escapeHtml(d.id)}')">
          <span class="activity-marker ${markerClass}">${icon}</span>
          <div class="activity-content">
            <strong>${title}</strong>
            <p>${msg} on <code>${branch}</code></p>
            <span>${formatRelativeTime(d.created_at).toUpperCase()}</span>
          </div>
        </article>
      `;
    }).join('');
  }

  window.DFSelectDeployment = (id) => {
    activeDeploymentId = id;
    updatePipelineView();
    fetchLogs(id);
  };

  // -------------------------------------------------------------
  // Full Dashboard Refresh
  // -------------------------------------------------------------
  async function refreshDashboard() {
    if (!activeToken) return;
    await fetchRepositories();
    const deps = await fetchDeployments();
    renderMetrics(deps);
    applyFilterAndSearch();
    await updatePipelineView();
    if (activeDeploymentId) {
      fetchLogs(activeDeploymentId);
    } else if (deps.length > 0) {
      activeDeploymentId = deps[0].id;
      fetchLogs(deps[0].id);
    }
    renderActivityLog(deps);
  }

  // -------------------------------------------------------------
  // Search & Filtering
  // -------------------------------------------------------------
  function applyFilterAndSearch() {
    const searchVal = (document.getElementById("deploymentSearch")?.value || "").toLowerCase().trim();
    const filterVal = (document.getElementById("deploymentFilter")?.value || "all").toLowerCase();

    let filtered = allDeployments.slice();
    if (filterVal !== "all") {
      filtered = filtered.filter(d => {
        if (filterVal === "running") {
          return ['queued', 'cloning', 'installing', 'testing', 'building', 'deploying'].includes(d.status);
        }
        return d.status === filterVal;
      });
    }

    if (searchVal) {
      filtered = filtered.filter(d =>
        (d.branch && d.branch.toLowerCase().includes(searchVal)) ||
        (d.commit_sha && d.commit_sha.toLowerCase().includes(searchVal)) ||
        (d.commit_message && d.commit_message.toLowerCase().includes(searchVal)) ||
        (d.id && d.id.toLowerCase().includes(searchVal))
      );
    }

    renderDeploymentsTable(filtered);
  }

  document.getElementById("deploymentSearch")?.addEventListener("input", applyFilterAndSearch);
  document.getElementById("deploymentFilter")?.addEventListener("change", applyFilterAndSearch);

  // -------------------------------------------------------------
  // Live Polling
  // -------------------------------------------------------------
  function startLivePolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      if (!activeToken) return;
      const deps = await fetchDeployments();
      renderMetrics(deps);
      applyFilterAndSearch();
      await updatePipelineView();
      if (activeDeploymentId) {
        fetchLogs(activeDeploymentId);
      }
    }, 3000);
  }

  // -------------------------------------------------------------
  // Action Buttons Wiring
  // -------------------------------------------------------------
  document.getElementById("authButton")?.addEventListener("click", () => {
    if (currentUser) {
      if (confirm("Are you sure you want to sign out?")) {
        if (sb) sb.auth.signOut();
        activeToken = null;
        currentUser = null;
        updateUserUI();
        if (pollInterval) clearInterval(pollInterval);
        showToast("Signed out", "info");
      }
    } else {
      openAuthModal();
    }
  });

  document.getElementById("runPipelineButton")?.addEventListener("click", openDeployModal);
  document.getElementById("connectRepoButton")?.addEventListener("click", openConnectRepoModal);
  document.getElementById("heroConnectRepoButton")?.addEventListener("click", openConnectRepoModal);
  document.getElementById("githubIntegrationCard")?.addEventListener("click", openConnectRepoModal);
  document.getElementById("pipelineIntegrationCard")?.addEventListener("click", () => {
    document.getElementById("pipeline")?.scrollIntoView({ behavior: "smooth" });
  });
  document.getElementById("s3IntegrationCard")?.addEventListener("click", openSettingsModal);
  document.getElementById("cloudfrontIntegrationCard")?.addEventListener("click", openSettingsModal);
  document.getElementById("resetPipelineButton")?.addEventListener("click", async () => {
    if (!confirm("Reset and refresh pipeline data from the server?")) return;
    showToast("Refreshing pipeline data...", "info");
    await refreshDashboard();
  });
  document.getElementById("clearActivityButton")?.addEventListener("click", () => {
    if (!confirm("Are you sure you want to clear local activity logs?")) return;
    const list = document.getElementById("activityList");
    if (list) list.innerHTML = `<article class="activity-item"><div class="activity-content"><strong>Activity cleared</strong><span>Just now</span></div></article>`;
    showToast("Local activity cleared", "info");
  });
  document.getElementById("settingsButton")?.addEventListener("click", openSettingsModal);
  document.getElementById("notificationButton")?.addEventListener("click", () => {
    showToast("All systems operational. Webhooks active.", "info");
  });

  // -------------------------------------------------------------
  // Hero 3D Pipeline Animation (Three.js WebGL)
  // -------------------------------------------------------------
  function initHero3DAnimation() {
    const canvas = document.getElementById("heroGlCanvas");
    if (!canvas || !window.THREE) return;

    let renderer;
    try {
      renderer = new window.THREE.WebGLRenderer({
        canvas: canvas,
        alpha: true,
        antialias: window.innerWidth > 760,
        powerPreference: "high-performance"
      });
    } catch (e) {
      console.warn("WebGL not supported for hero visual:", e);
      return;
    }

    const isMobile = window.innerWidth < 760;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);

    const scene = new window.THREE.Scene();
    const camera = new window.THREE.PerspectiveCamera(45, (canvas.clientWidth || 300) / (canvas.clientHeight || 345), 0.1, 100);
    camera.position.set(0, 0, 16);

    const ambLight = new window.THREE.AmbientLight(0xfff1dc, 0.9);
    scene.add(ambLight);
    const keyLight = new window.THREE.PointLight(0xc46e45, 2.2, 40);
    keyLight.position.set(5, 5, 8);
    scene.add(keyLight);
    const fillLight = new window.THREE.PointLight(0x7ea98a, 1.4, 35);
    fillLight.position.set(-6, -4, 6);
    scene.add(fillLight);

    const pts = [
      new window.THREE.Vector3(-5.5, -1.2, 0),
      new window.THREE.Vector3(-3.2, 1.8, 1.5),
      new window.THREE.Vector3(0, -0.8, 1),
      new window.THREE.Vector3(3.2, 1.6, -1),
      new window.THREE.Vector3(5.5, -1.2, 0)
    ];
    const curve = new window.THREE.CatmullRomCurve3(pts);
    const tubeGeom = new window.THREE.TubeGeometry(curve, 90, 0.11, 8, false);
    const tubeMat = new window.THREE.MeshStandardMaterial({
      color: 0xc46e45,
      roughness: 0.35,
      metalness: 0.5,
      emissive: 0x6b1426,
      emissiveIntensity: 0.2
    });
    const tubeMesh = new window.THREE.Mesh(tubeGeom, tubeMat);
    scene.add(tubeMesh);

    const stages = [
      { geom: new window.THREE.OctahedronGeometry(0.52), color: 0xc46e45, t: 0.08 },
      { geom: new window.THREE.TorusGeometry(0.44, 0.08, 8, 24), color: 0x9bb5ce, t: 0.25 },
      { geom: new window.THREE.BoxGeometry(0.6, 0.6, 0.6), color: 0x7ea98a, t: 0.44 },
      { geom: new window.THREE.IcosahedronGeometry(0.48, 0), color: 0xe8ddc8, t: 0.62 },
      { geom: new window.THREE.DodecahedronGeometry(0.5), color: 0xc46e45, t: 0.80 },
      { geom: new window.THREE.SphereGeometry(0.46, 16, 16), color: 0x7ea98a, t: 0.95 }
    ];

    const stageMeshes = stages.map((s, idx) => {
      const grp = new window.THREE.Group();
      grp.position.copy(curve.getPointAt(s.t));
      const mat = new window.THREE.MeshStandardMaterial({
        color: s.color,
        roughness: 0.3,
        metalness: 0.5,
        emissive: s.color,
        emissiveIntensity: 0.15
      });
      const m = new window.THREE.Mesh(s.geom, mat);
      grp.add(m);
      scene.add(grp);
      return { group: grp, mesh: m, speed: 0.008 + (idx * 0.003), baseT: s.t };
    });

    const packet = new window.THREE.Mesh(
      new window.THREE.SphereGeometry(0.24, 16, 16),
      new window.THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xc46e45,
        emissiveIntensity: 1.2,
        roughness: 0.2
      })
    );
    scene.add(packet);

    const particleCount = 70;
    const pGeom = new window.THREE.BufferGeometry();
    const posArray = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount * 3; i += 3) {
      posArray[i] = (Math.random() - 0.5) * 16;
      posArray[i + 1] = (Math.random() - 0.5) * 8;
      posArray[i + 2] = (Math.random() - 0.5) * 8;
    }
    pGeom.setAttribute("position", new window.THREE.BufferAttribute(posArray, 3));
    const particles = new window.THREE.Points(
      pGeom,
      new window.THREE.PointsMaterial({
        color: 0xe8ddc8,
        size: 0.08,
        transparent: true,
        opacity: 0.5
      })
    );
    scene.add(particles);

    function resizeCanvas() {
      const parentRect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : null;
      const w = parentRect && parentRect.width > 0 ? parentRect.width : (canvas.clientWidth || 300);
      const h = parentRect && parentRect.height > 0 ? parentRect.height : (canvas.clientHeight || 345);
      if (w > 0 && h > 0) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    }
    window.addEventListener("resize", resizeCanvas);
    if (window.ResizeObserver && canvas.parentElement) {
      new ResizeObserver(resizeCanvas).observe(canvas.parentElement);
    }
    resizeCanvas();

    let mouseX = 0, mouseY = 0;
    const parent = canvas.parentElement;
    if (parent) {
      parent.addEventListener("mousemove", (e) => {
        const rect = parent.getBoundingClientRect();
        mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouseY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      });
      parent.addEventListener("mouseleave", () => {
        mouseX = 0;
        mouseY = 0;
      });
    }

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animTime = 0;
    let isVisible = true;
    document.addEventListener("visibilitychange", () => {
      isVisible = !document.hidden;
      if (isVisible) requestAnimationFrame(loop);
    });

    function loop() {
      if (!isVisible) return;
      requestAnimationFrame(loop);
      const motionScale = prefersReducedMotion ? 0.2 : 1;
      animTime += 0.01 * motionScale;

      const progress = (animTime * 0.14) % 1;
      packet.position.copy(curve.getPointAt(progress));

      stageMeshes.forEach((s, idx) => {
        s.mesh.rotation.x += s.speed * motionScale;
        s.mesh.rotation.y += s.speed * 1.3 * motionScale;
        s.group.position.y = curve.getPointAt(s.baseT).y + Math.sin(animTime * 2 + idx) * 0.08 * motionScale;
      });

      particles.rotation.y = animTime * 0.02 * motionScale;

      camera.position.x += (mouseX * 1.2 - camera.position.x) * 0.05 * motionScale;
      camera.position.y += (mouseY * 0.8 - camera.position.y) * 0.05 * motionScale;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    }
    loop();
  }

  // Initialize Hero 3D animation
  initHero3DAnimation();

  // -------------------------------------------------------------
  // Bootstrap & Supabase Session Initialization
  // -------------------------------------------------------------
  try {
    const configRes = await fetch(`${API}/api/config`);
    const cfg = await configRes.json();
    if (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      window.supabaseClient = sb;

      sb.auth.onAuthStateChange(async (event, currentSession) => {
        session = currentSession;
        if (session && session.access_token) {
          activeToken = session.access_token;
          currentUser = session.user;
          updateUserUI();
          await refreshDashboard();
          startLivePolling();
        } else {
          activeToken = null;
          currentUser = null;
          updateUserUI();
        }
      });

      const { data } = await sb.auth.getSession();
      session = data.session;
      if (session && session.access_token) {
        activeToken = session.access_token;
        currentUser = session.user;
        updateUserUI();
        await refreshDashboard();
        startLivePolling();
      }
    }
  } catch (err) {
    console.error("Initialization error:", err.message);
  }
});
