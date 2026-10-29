(function () {
  var API = window.DEPLOYFLOW_API || (location.port === '3001' ? '' : 'http://localhost:3001');
  var token = null, timer = null, currentUser = null;
  var ST = { queued: .05, cloning: .17, installing: .25, testing: .33, building: .5, deploying: .68, success: .88 };
  var SG = { checkout: .17, install: .25, test: .33, build: .5, deploy: .68, verify: .88 };
  var L = window.DFLive = { active: false, target: .05, pos: .05 };
  var $ = function (t, x, c) { var e = document.createElement(t); if (x) e.textContent = x; if (c) e.className = c; return e; };

  var css = $('style');
  css.textContent = '#liveBtn{margin-left:22px;padding:7px 18px;border:0;border-radius:999px;background:#15100d;color:#f7eedd;font:500 14px sans-serif;cursor:pointer;transition:transform .2s}'
    + '#liveBtn:hover{transform:translateY(-1px)}'
    + '#live{display:none;position:fixed;right:16px;top:64px;z-index:10;width:min(340px,calc(100vw - 20px));padding:18px;border-radius:8px;background:#f7eedd;border:1.5px solid #6b1426;box-shadow:6px 6px 0 #15100d;font:500 13px/1.5 ui-monospace,Menlo,monospace;color:#6b1426}'
    + '#live.open{display:block}#live h3{margin:0 0 10px;font:700 16px sans-serif}'
    + '#live .user-badge{padding:6px 10px;background:#eee2cc;border-radius:4px;margin-bottom:12px;font-size:12px;word-break:break-all}'
    + '#live input{display:block;width:100%;margin:8px 0;padding:9px;border:1px solid #6b1426;border-radius:4px;background:#fff;font:inherit;color:#15100d}'
    + '#live input:focus{outline:2px solid #15100d}'
    + '#live button{display:block;width:100%;margin-top:8px;padding:9px 16px;border:0;border-radius:999px;background:#15100d;color:#f7eedd;font:inherit;cursor:pointer;text-align:center}'
    + '#live button.sec{background:transparent;border:1.5px solid #6b1426;color:#6b1426}'
    + '#live button:disabled{opacity:.6;cursor:not-allowed}'
    + '#live .divider{display:flex;align-items:center;margin:12px 0;color:#7a4a52;font-size:11px}'
    + '#live .divider::before,#live .divider::after{content:"";flex:1;border-bottom:1px solid rgba(107,20,38,.25)}'
    + '#live .divider::before{margin-right:8px}#live .divider::after{margin-left:8px}'
    + '#live .oauth-btn{display:flex;align-items:center;justify-content:center;gap:8px;background:#fff;border:1.5px solid #6b1426;color:#15100d;font-weight:600}'
    + '#live .err{color:#b3122e;background:rgba(179,18,46,.08);padding:6px 8px;border-radius:4px;margin-bottom:8px;font-size:12px}'
    + '#live .status-row{margin:4px 0}'
    + '#live a.dash-link{display:block;margin-top:10px;padding:9px 16px;border-radius:999px;background:#6b1426;color:#fff;text-decoration:none;text-align:center;font-weight:600}';
  document.head.appendChild(css);

  var box = $('aside'); box.id = 'live'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box);
  var btn = $('button'); btn.id = 'liveBtn'; btn.type = 'button';
  (document.querySelector('header nav') || document.querySelector('header') || document.body).appendChild(btn);
  function setOpen(o) { box.classList.toggle('open', o); btn.setAttribute('aria-expanded', String(o)); }
  btn.onclick = function (e) { e.stopPropagation(); setOpen(!box.classList.contains('open')); };
  box.onclick = function (e) { e.stopPropagation(); };
  document.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

  window.DFLive.openLogin = function (msg) { showLogin(msg); setOpen(true); };
  window.DFLive.useToken = function (t, user) {
    token = t;
    if (user) currentUser = user;
    poll();
    clearInterval(timer);
    timer = setInterval(poll, 3000);
  };

  function stop() { clearInterval(timer); timer = null; token = null; currentUser = null; L.active = false; }

  function showLogin(msg) {
    stop();
    btn.textContent = 'Login';
    box.textContent = '';
    box.appendChild($('h3', 'Log in to DeployFlow'));
    if (msg) box.appendChild($('div', msg, 'err'));

    var em = $('input'), pw = $('input'), go = $('button', 'Log in');
    em.type = 'email'; em.placeholder = 'Email address'; em.autocomplete = 'username';
    pw.type = 'password'; pw.placeholder = 'Password'; pw.autocomplete = 'current-password';

    go.onclick = function () {
      var emailVal = em.value.trim();
      var passVal = pw.value;
      if (!emailVal || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
        showLogin('Please enter a valid email address');
        return;
      }
      if (!passVal) {
        showLogin('Please enter your password');
        return;
      }
      go.disabled = true;
      go.textContent = 'Logging in...';
      login(emailVal, passVal);
    };
    pw.onkeydown = function (e) { if (e.key === 'Enter') go.click(); };
    em.onkeydown = function (e) { if (e.key === 'Enter') pw.focus(); };

    box.append(em, pw, go);

    var div = $('div', 'or continue with', 'divider');
    box.appendChild(div);

    // Single GitHub and Google OAuth buttons
    var ghBtn = $('button', 'Continue with GitHub', 'oauth-btn');
    ghBtn.type = 'button';
    ghBtn.onclick = function () {
      if (window.DFAuth && window.DFAuth.oauth) {
        window.DFAuth.oauth('github');
      } else {
        alert('Authentication service initializing. Please retry in a moment.');
      }
    };
    box.appendChild(ghBtn);

    var ggBtn = $('button', 'Continue with Google', 'oauth-btn');
    ggBtn.type = 'button';
    ggBtn.onclick = function () {
      if (window.DFAuth && window.DFAuth.oauth) {
        window.DFAuth.oauth('google');
      } else {
        alert('Authentication service initializing. Please retry in a moment.');
      }
    };
    box.appendChild(ggBtn);

    if (msg) setOpen(true);
  }

  function showStatus(label, lines, bad) {
    btn.textContent = label;
    box.textContent = '';
    box.appendChild($('h3', 'DeployFlow Live'));

    if (currentUser && currentUser.email) {
      box.appendChild($('div', 'Signed in as ' + currentUser.email, 'user-badge'));
    }

    lines.forEach(function (t, i) {
      box.appendChild($('div', t, 'status-row' + (i === 0 && bad ? ' err' : '')));
    });

    var dash = $('a', 'Open CI/CD Dashboard', 'dash-link');
    dash.href = (location.pathname.indexOf('/web/') !== -1) ? '../index.html' : 'index.html';
    box.appendChild(dash);

    var connectBtn = $('button', 'Connect Repository', 'sec');
    connectBtn.type = 'button';
    connectBtn.onclick = function () {
      setOpen(false);
      if (window.DFRepo && window.DFRepo.open) window.DFRepo.open();
    };
    box.appendChild(connectBtn);

    var out = $('button', 'Log out', 'sec');
    out.type = 'button';
    out.onclick = async function () {
      if (window.DFAuth && window.DFAuth.signOut) {
        await window.DFAuth.signOut();
      }
      showLogin('You have been logged out.');
    };
    box.appendChild(out);
  }

  async function login(email, password) {
    try {
      var r = await fetch(API + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      var j = await r.json();
      if (!j.ok) return showLogin(j.error || 'Login failed');
      token = j.access_token;
      currentUser = j.user;
      if (window.DFAuth && window.DFAuth.onDirectLogin) {
        window.DFAuth.onDirectLogin(token, currentUser);
      }
      await poll();
      if (token) {
        setOpen(false);
        clearInterval(timer);
        timer = setInterval(poll, 3000);
      }
    } catch (e) {
      showLogin('Backend not reachable at ' + API + '. Is the server running?');
    }
  }

  function api(p) { return fetch(API + p, { headers: { Authorization: 'Bearer ' + token } }); }

  async function poll() {
    if (!token) return;
    try {
      var r = await api('/api/deployments?limit=1');
      if (r.status === 401) {
        return showLogin('Session expired. Please log in again.');
      }
      var j = await r.json();
      if (!j.ok) return showStatus('Live: error', ['Error: ' + (j.error || r.status)], true);
      var d = j.data && j.data[0];
      if (!d) {
        L.active = false;
        return showStatus('Live: idle', ['Connected. No deployments yet.']);
      }
      var t = ST[d.status];
      if (t === undefined) {
        t = L.target;
        if (d.status === 'failed') {
          var dj = await (await api('/api/deployments/' + d.id)).json();
          var f = dj.ok && dj.data.stages.find(function (s) { return s.status === 'failed'; });
          if (f) t = SG[f.name];
        }
      }
      L.target = t;
      L.active = true;
      var lines = [
        'Deployment: ' + d.id.slice(0, 8),
        'Branch: ' + d.branch + ' (' + d.commit_sha.slice(0, 7) + ')',
        'Status: ' + d.status.toUpperCase()
      ];
      if (d.deployment_url) lines.push('URL: ' + d.deployment_url);
      if (d.error_summary) lines.push('Error: ' + d.error_summary);
      showStatus('Live: ' + d.status, lines, d.status === 'failed');
    } catch (e) {
      L.active = false;
      showStatus('Live: offline', ['Backend disconnected. Retrying...'], true);
    }
  }

  showLogin();
})();
