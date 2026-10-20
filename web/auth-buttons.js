(function () {
  var API = 'http://localhost:3001', sb = null;
  fetch(API + '/api/config').then(function (r) { return r.json(); }).then(function (c) {
    sb = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey);
  }).catch(function () {});

  function add() {
    var box = document.getElementById('live');
    if (!box || box.querySelector('.oauth') || !box.querySelector('input[type=password]')) return;
    [['google', 'Continue with Google'], ['github', 'Continue with GitHub']].forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'oauth'; b.type = 'button'; b.textContent = a[1];
      b.onclick = function () {
        if (!sb) { alert('Backend not reachable. Is it running on port 3001?'); return; }
        sb.auth.signInWithOAuth({ provider: a[0], options: { redirectTo: location.origin + '/deployflow.html' } });
      };
      box.appendChild(b);
    });
  }
  new MutationObserver(add).observe(document.body, { childList: true, subtree: true });
  add();
})();