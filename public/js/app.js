(function () {
  document.addEventListener('click', function (e) {
    var m = e.target.closest('[data-menu]');
    if (m) { document.getElementById('nav').classList.toggle('open'); return; }

    var c = e.target.closest('[data-copy]');
    if (c) {
      var el = document.querySelector(c.getAttribute('data-copy'));
      if (!el) return;
      var text = el.textContent.trim();
      var done = function () { var o = c.textContent; c.textContent = 'Copied ✓'; setTimeout(function () { c.textContent = o; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
      else { fallback(text); done(); }
      return;
    }

    var d = e.target.closest('[data-download]');
    if (d && !d.classList.contains('busy')) {
      var label = d.innerHTML;
      d.classList.add('busy');
      d.innerHTML = '<span class="spinner"></span> Preparing your copy…';
      setTimeout(function () { d.classList.remove('busy'); d.innerHTML = label; }, 9000);
    }
  });

  function fallback(text) {
    var t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch (x) {}
    document.body.removeChild(t);
  }

  document.addEventListener('submit', function (e) {
    var f = e.target;
    var msg = f.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    if (f.hasAttribute('data-once')) {
      if (f.dataset.sent) { e.preventDefault(); return; }
      f.dataset.sent = '1';
      var b = f.querySelector('button:not([type=button])');
      if (b) {
        var busy = b.getAttribute('data-busy-text') || 'Please wait…';
        setTimeout(function () { b.classList.add('busy'); b.innerHTML = '<span class="spinner"></span> ' + busy; }, 0);
      }
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
})();
