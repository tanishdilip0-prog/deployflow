(function () {
  var API = 'http://localhost:3001', sb = null, session = null;
  var $ = function (t, x, c) { var e = document.createElement(t); if (x) e.textContent = x; if (c) e.className = c; return e; };
  var css = $('style');
  css.textContent = '#gh{display:none;position:fixed;right:16px;top:64px;z-index:7;width:min(320px,calc(100vw - 20px));padding:16px;border-radius:6px;background:#f7eedd;border:1.5px solid #6b1426;box-shadow:5px 5px 0 #15100d;font:500 13px/1.5 ui-monospace,Menlo,monospace;color:#6b1426}'
    + '#gh.open{display:block}#gh h3{margin:0 0 8px;font:700 16px sans-serif}'
    + '#gh select{width:100%;margin:8px 0;padding:9px;border:1px solid #6b1426;border-radius:4px;background:#fff;font:inherit;color:#15100d}'
    + '#gh button{margin:6px 6px 0 0;padding:9px 16px;border:0;border-radius:999px;background:#15100d;color:#f7eedd;font:inherit;cursor:pointer}'
    + '#gh .err{color:#b3122e}';
  document.head.appendChild(css);

  var box = $('aside'); box.id = 'gh'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box);
  function setOpen(o) { box.classList.toggle('open', o); }
  box.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

  function show(title, msg, bad) {
    box.textContent = '';
    box.appendChild($('h3', title));
    if (msg) box.appendChild($('div', msg, bad ? 'err' : ''));
  }
  function githubButton(label) {
    var b = $('button', label);
    b.onclick = function () {
      sb.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.origin + '/deployflow.html' } });
    };
    box.appendChild(b);
  }

  async function repos() {
    show('Your GitHub repositories', 'Loading...');
    try {
      var r = await fetch(API + '/api/github/repos', {
        headers: { Authorization: 'Bearer ' + session.access_token, 'X-GitHub-Token': session.provider_token }
      });
      var j = await r.json();
      if (!j.ok) { show('Your GitHub repositories', j.error || 'Failed', true); return githubButton('Sign in with GitHub again'); }
      if (!j.data.length) return show('Your GitHub repositories', 'No public repositories found.');
      show('Your GitHub repositories');
      var sel = $('select');
      j.data.forEach(function (x, i) { var o = $('option', x.full_name); o.value = i; sel.appendChild(o); });
      var out = $('div'), go = $('button', 'Connect');
      go.onclick = async function () {
        var x = j.data[sel.value];
        try {
          var r2 = await fetch(API + '/api/repositories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
            body: JSON.stringify({ full_name: x.full_name, branch: x.default_branch })
          });
          var j2 = await r2.json();
          out.textContent = j2.ok ? 'Connected ' + x.full_name : (j2.error || 'Failed');
          out.className = j2.ok ? '' : 'err';
        } catch (e) { out.textContent = 'Backend not reachable'; out.className = 'err'; }
      };
      box.append(sel, go, out);
    } catch (e) { show('Your GitHub repositories', 'Backend not reachable', true); }
  }

  function start() {
    setOpen(true);
    if (!sb) return show('Connect GitHub', 'Backend not reachable. Is it running on port 3001?', true);
    if (!session || !session.provider_token) {
      show('Connect GitHub', 'Sign in with GitHub to choose one of your repositories.');
      return githubButton('Continue with GitHub');
    }
    repos();
  }

  window.DFAuth = { oauth: function (p) { if (sb) sb.auth.signInWithOAuth({ provider: p, options: { redirectTo: location.origin + '/deployflow.html' } }); } };
  var cta = document.querySelector('#aws a.btn');
  if (cta) cta.addEventListener('click', function (e) {
    e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); start();
  }, true);

  (async function () {
    try {
      var c = await (await fetch(API + '/api/config')).json();
      sb = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey);
      sb.auth.onAuthStateChange(function (ev, s) {
        session = s;
        if (s && window.DFLive && window.DFLive.useToken) window.DFLive.useToken(s.access_token);
      });
      var g = await sb.auth.getSession();
      session = g.data.session;
    } catch (e) { sb = null; }
  })();
})();