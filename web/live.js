(function () {
  var API = 'http://localhost:3001', token = null, timer = null;
  var ST = { queued: .05, cloning: .17, installing: .25, testing: .33, building: .5, deploying: .68, success: .88 };
  var SG = { checkout: .17, install: .25, test: .33, build: .5, deploy: .68, verify: .88 };
  var L = window.DFLive = { active: false, target: .05, pos: .05 };
  var $ = function (t, x, c) { var e = document.createElement(t); if (x) e.textContent = x; if (c) e.className = c; return e; };

  var css = $('style');
  css.textContent = '#liveBtn{margin-left:22px;padding:7px 18px;border:0;border-radius:999px;background:#15100d;color:#f7eedd;font:500 14px sans-serif;cursor:pointer}'
    + '#live{display:none;position:fixed;right:16px;top:64px;z-index:6;width:min(300px,calc(100vw - 20px));padding:16px;border-radius:6px;background:#f7eedd;border:1.5px solid #6b1426;box-shadow:5px 5px 0 #15100d;font:500 13px/1.5 ui-monospace,Menlo,monospace;color:#6b1426}'
    + '#live.open{display:block}#live h3{margin:0 0 8px;font:700 16px sans-serif}'
    + '#live input{display:block;width:100%;margin:8px 0;padding:9px;border:1px solid #6b1426;border-radius:4px;background:#fff;font:inherit;color:#15100d}'
    + '#live button{margin-top:6px;padding:9px 16px;border:0;border-radius:999px;background:#15100d;color:#f7eedd;font:inherit;cursor:pointer}'
    + '#live .err{color:#b3122e}';
  document.head.appendChild(css);

  var box = $('aside'); box.id = 'live'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box);
  var btn = $('button'); btn.id = 'liveBtn'; btn.type = 'button';
  (document.querySelector('header nav') || document.querySelector('header') || document.body).appendChild(btn);
  function setOpen(o) { box.classList.toggle('open', o); btn.setAttribute('aria-expanded', String(o)); }
  btn.onclick = function (e) { e.stopPropagation(); setOpen(!box.classList.contains('open')); };
  box.onclick = function (e) { e.stopPropagation(); };
  document.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

  L.useToken = function (t) { token = t; poll(); clearInterval(timer); timer = setInterval(poll, 3000); };
  function stop() { clearInterval(timer); timer = null; token = null; L.active = false; }

  function showLogin(msg) {
    stop(); btn.textContent = 'Login'; box.textContent = '';
    box.appendChild($('h3', 'Log in to DeployFlow'));
    if (msg) box.appendChild($('div', msg, 'err'));
    var em = $('input'), pw = $('input'), go = $('button', 'Log in');
    em.type = 'email'; em.placeholder = 'Email'; em.autocomplete = 'username';
    pw.type = 'password'; pw.placeholder = 'Password'; pw.autocomplete = 'current-password';
    go.onclick = function () { login(em.value.trim(), pw.value); };
    pw.onkeydown = function (e) { if (e.key === 'Enter') go.click(); };
    box.append(em, pw, go);
    ['google', 'github'].forEach(function (p) {
      var o = $('button', 'Continue with ' + (p === 'google' ? 'Google' : 'GitHub'));
      o.onclick = function () { if (window.DFAuth) window.DFAuth.oauth(p); };
      box.appendChild(o);
    });
    if (msg) setOpen(true);
  }

  function showStatus(label, lines, bad) {
    btn.textContent = label; box.textContent = '';
    box.appendChild($('h3', 'Live deployment'));
    lines.forEach(function (t, i) { box.appendChild($('div', t, i === 0 && bad ? 'err' : '')); });
    var out = $('button', 'Log out');
    out.onclick = function () { showLogin(); setOpen(false); };
    box.appendChild(out);
  }

  async function login(email, password) {
    try {
      var r = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password }) });
      var j = await r.json();
      if (!j.ok) return showLogin(j.error || 'Login failed');
      token = j.access_token;
      await poll();
      if (token) { setOpen(false); timer = setInterval(poll, 3000); }
    } catch (e) { showLogin('Backend not reachable. Is it running on port 3001?'); }
  }

  function api(p) { return fetch(API + p, { headers: { Authorization: 'Bearer ' + token } }); }

  async function poll() {
    if (!token) return;
    try {
      var r = await api('/api/deployments?limit=1');
      if (r.status === 401) return showLogin('Session expired, log in again');
      var j = await r.json();
      if (!j.ok) return showStatus('Live: error', ['Error: ' + (j.error || r.status)], true);
      var d = j.data[0];
      if (!d) { L.active = false; return showStatus('Live: none', ['Connected. No deployments yet.']); }
      var t = ST[d.status];
      if (t === undefined) {
        t = L.target;
        if (d.status === 'failed') {
          var dj = await (await api('/api/deployments/' + d.id)).json();
          var f = dj.ok && dj.data.stages.find(function (s) { return s.status === 'failed'; });
          if (f) t = SG[f.name];
        }
      }
      L.target = t; L.active = true;
      var lines = ['Deployment ' + d.id.slice(0, 8), 'commit ' + d.commit_sha.slice(0, 7) + ' on ' + d.branch, 'status: ' + d.status];
      if (d.error_summary) lines.push(d.error_summary);
      showStatus('Live: ' + d.status, lines, d.status === 'failed');
    } catch (e) { L.active = false; showStatus('Live: offline', ['Backend not reachable. Retrying...'], true); }
  }

  showLogin();
})();