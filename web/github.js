(function () {
  var API = window.DEPLOYFLOW_API || (location.port === '3001' ? '' : 'http://localhost:3001');
  var sb = null, session = null, directToken = null;
  var $ = function (t, x, c) { var e = document.createElement(t); if (x) e.textContent = x; if (c) e.className = c; return e; };

  var css = $('style');
  css.textContent = '#gh{display:none;position:fixed;right:16px;top:64px;z-index:9;width:min(340px,calc(100vw - 20px));padding:18px;border-radius:8px;background:#f7eedd;border:1.5px solid #6b1426;box-shadow:6px 6px 0 #15100d;font:500 13px/1.5 ui-monospace,Menlo,monospace;color:#6b1426}'
    + '#gh.open{display:block}#gh h3{margin:0 0 10px;font:700 16px sans-serif}'
    + '#gh label{display:block;margin-top:8px;font-size:11px;font-weight:600;color:#7a4a52}'
    + '#gh select,#gh input{width:100%;margin:4px 0 8px;padding:9px;border:1px solid #6b1426;border-radius:4px;background:#fff;font:inherit;color:#15100d}'
    + '#gh button{width:100%;margin-top:8px;padding:9px 16px;border:0;border-radius:999px;background:#15100d;color:#f7eedd;font:inherit;cursor:pointer}'
    + '#gh button.sec{background:transparent;border:1.5px solid #6b1426;color:#6b1426}'
    + '#gh button:disabled{opacity:.6;cursor:not-allowed}'
    + '#gh .err{color:#b3122e;background:rgba(179,18,46,.08);padding:6px 8px;border-radius:4px;margin-top:8px;font-size:12px}'
    + '#gh .ok{color:#1e7e34;background:rgba(40,167,69,.1);padding:6px 8px;border-radius:4px;margin-top:8px;font-size:12px}'
    + '#gh .tabs{display:flex;gap:6px;margin-bottom:10px}'
    + '#gh .tab-btn{flex:1;padding:6px;border-radius:4px;border:1px solid #6b1426;background:none;color:#6b1426;font-size:11px;cursor:pointer;margin:0}'
    + '#gh .tab-btn.active{background:#6b1426;color:#fff}';
  document.head.appendChild(css);

  var box = $('aside'); box.id = 'gh'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box);
  function setOpen(o) { box.classList.toggle('open', o); }
  box.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

  function getActiveToken() {
    return (session && session.access_token) || directToken;
  }

  function show(title, msg, bad) {
    box.textContent = '';
    box.appendChild($('h3', title));
    if (msg) box.appendChild($('div', msg, bad ? 'err' : 'ok'));
  }

  function renderConnectForm(ghRepos) {
    box.textContent = '';
    box.appendChild($('h3', 'Connect Repository'));

    var tabContainer = $('div', '', 'tabs');
    var autoTab = $('button', 'From GitHub', 'tab-btn active');
    var manualTab = $('button', 'Manual Input', 'tab-btn');
    tabContainer.append(autoTab, manualTab);
    box.appendChild(tabContainer);

    var content = $('div');
    box.appendChild(content);

    function showAuto() {
      autoTab.className = 'tab-btn active';
      manualTab.className = 'tab-btn';
      content.textContent = '';

      if (!ghRepos || !ghRepos.length) {
        content.appendChild($('div', 'No GitHub repositories fetched or token expired.', 'err'));
        var reauth = $('button', 'Sign in with GitHub');
        reauth.onclick = function () {
          window.DFAuth.oauth('github');
        };
        content.appendChild(reauth);
        return;
      }

      content.appendChild($('label', 'SELECT REPOSITORY:'));
      var sel = $('select');
      var defaultOpt = $('option', '-- Select a repository to connect --');
      defaultOpt.value = '';
      defaultOpt.disabled = true;
      defaultOpt.selected = true;
      sel.appendChild(defaultOpt);

      ghRepos.forEach(function (x, i) {
        var o = $('option', x.full_name + (x.private ? ' (private)' : ''));
        o.value = i;
        sel.appendChild(o);
      });
      content.appendChild(sel);

      content.appendChild($('label', 'DEPLOY BRANCH:'));
      var branchInput = $('input');
      branchInput.value = 'main';

      var connectBtn = $('button', 'Connect & Save');
      connectBtn.disabled = true;

      sel.onchange = function () {
        if (sel.value === '') {
          connectBtn.disabled = true;
          return;
        }
        var chosen = ghRepos[sel.value];
        if (chosen) {
          branchInput.value = chosen.default_branch || 'main';
          connectBtn.disabled = false;
        }
      };
      content.appendChild(branchInput);

      var statusDiv = $('div');
      connectBtn.onclick = function () {
        if (sel.value === '') {
          statusDiv.textContent = 'Please choose a repository from the dropdown';
          statusDiv.className = 'err';
          return;
        }
        var chosen = ghRepos[sel.value];
        if (!chosen) return;
        submitRepo(chosen.full_name, branchInput.value.trim() || 'main', connectBtn, statusDiv);
      };
      content.append(connectBtn, statusDiv);
    }

    function showManual() {
      autoTab.className = 'tab-btn';
      manualTab.className = 'tab-btn active';
      content.textContent = '';

      content.appendChild($('label', 'REPOSITORY (OWNER/REPO):'));
      var nameInput = $('input');
      nameInput.placeholder = 'e.g. facebook/react';

      content.appendChild($('label', 'BRANCH:'));
      var branchInput = $('input');
      branchInput.value = 'main';

      var connectBtn = $('button', 'Connect Repository');
      var statusDiv = $('div');
      connectBtn.onclick = function () {
        var name = nameInput.value.trim();
        var branch = branchInput.value.trim() || 'main';
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
          statusDiv.textContent = 'Enter repository as owner/repo (e.g. acme/web)';
          statusDiv.className = 'err';
          return;
        }
        submitRepo(name, branch, connectBtn, statusDiv);
      };
      content.append(nameInput, branchInput, connectBtn, statusDiv);
    }

    autoTab.onclick = showAuto;
    manualTab.onclick = showManual;

    if (ghRepos && ghRepos.length) showAuto();
    else showManual();
  }

  async function submitRepo(fullName, branch, btnElem, statusDiv) {
    var tok = getActiveToken();
    if (!tok) {
      statusDiv.textContent = 'Please log in first.';
      statusDiv.className = 'err';
      return;
    }
    btnElem.disabled = true;
    btnElem.textContent = 'Connecting...';
    statusDiv.textContent = '';
    try {
      var r = await fetch(API + '/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ full_name: fullName, branch: branch })
      });
      var j = await r.json();
      btnElem.disabled = false;
      btnElem.textContent = 'Connect';
      if (!j.ok) {
        statusDiv.textContent = j.error || 'Failed to connect repository';
        statusDiv.className = 'err';
        return;
      }
      statusDiv.textContent = 'Connected ' + fullName + '!';
      statusDiv.className = 'ok';

      // Offer immediate manual deployment trigger
      var runBtn = $('button', 'Deploy Now (' + branch + ')');
      runBtn.onclick = async function () {
        runBtn.disabled = true;
        runBtn.textContent = 'Queueing deployment...';
        try {
          var depRes = await fetch(API + '/api/deployments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
            body: JSON.stringify({
              repository_id: j.data.id,
              branch: branch,
              commit_sha: '0000000', // placeholder or latest
              commit_message: 'Manual deployment triggered from website'
            })
          });
          var depJson = await depRes.json();
          if (depJson.ok) {
            statusDiv.textContent = 'Deployment queued! Check live status in header.';
            statusDiv.className = 'ok';
            runBtn.remove();
          } else {
            statusDiv.textContent = depJson.error || 'Failed to queue deployment';
            statusDiv.className = 'err';
            runBtn.disabled = false;
            runBtn.textContent = 'Retry Deployment';
          }
        } catch (e) {
          statusDiv.textContent = 'Could not reach backend';
          statusDiv.className = 'err';
          runBtn.disabled = false;
        }
      };
      box.appendChild(runBtn);
    } catch (e) {
      btnElem.disabled = false;
      btnElem.textContent = 'Connect';
      statusDiv.textContent = 'Backend not reachable.';
      statusDiv.className = 'err';
    }
  }

  async function openRepoPicker() {
    setOpen(true);
    var tok = getActiveToken();
    if (!tok) {
      setOpen(false);
      if (window.DFLive && window.DFLive.openLogin) {
        window.DFLive.openLogin('Please log in before connecting a repository.');
      }
      return;
    }

    show('Connect Repository', 'Loading repositories...');
    var ghRepos = null;

    if (session && session.provider_token) {
      try {
        var r = await fetch(API + '/api/github/repos', {
          headers: { Authorization: 'Bearer ' + tok, 'X-GitHub-Token': session.provider_token }
        });
        var j = await r.json();
        if (j.ok && j.data) ghRepos = j.data;
      } catch (e) {}
    }

    renderConnectForm(ghRepos);
  }

  window.DFRepo = { open: openRepoPicker };

  window.DFAuth = {
    oauth: function (provider) {
      if (!sb) {
        alert('Authentication service initializing. Please retry in a few seconds.');
        return;
      }
      var targetUrl = window.location.protocol === 'file:'
        ? 'http://localhost:3001/web/deployflow.html'
        : window.location.origin + window.location.pathname;
      sb.auth.signInWithOAuth({
        provider: provider,
        options: {
          redirectTo: targetUrl,
          scopes: provider === 'github' ? 'repo read:user' : undefined
        }
      });
    },
    signOut: async function () {
      directToken = null;
      session = null;
      if (sb) {
        try { await sb.auth.signOut(); } catch (e) {}
      }
    },
    onDirectLogin: function (t, u) {
      directToken = t;
    }
  };

  var cta = document.querySelector('#aws a.btn');
  if (cta) {
    cta.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      openRepoPicker();
    }, true);
  }

  // Initialize Supabase client
  (async function init() {
    try {
      var r = await fetch(API + '/api/config');
      var c = await r.json();
      if (!c.supabaseUrl || !c.supabaseAnonKey) return;
      sb = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey);
      window.supabaseClient = sb;

      sb.auth.onAuthStateChange(function (ev, s) {
        session = s;
        if (s && s.access_token) {
          if (window.DFLive && window.DFLive.useToken) {
            window.DFLive.useToken(s.access_token, s.user);
          }
        }
      });

      var g = await sb.auth.getSession();
      session = g.data.session;
      if (session && session.access_token && window.DFLive && window.DFLive.useToken) {
        window.DFLive.useToken(session.access_token, session.user);
      }
    } catch (e) {
      sb = null;
    }
  })();
})();
