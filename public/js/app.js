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

  // Logging out clears books saved on this device (shared phones/laptops)
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.getAttribute('action') !== '/logout' || f.dataset.cleared) return;
    e.preventDefault();
    try { localStorage.removeItem('bv-offline'); } catch (x) {}
    var done = function () { f.dataset.cleared = '1'; f.submit(); };
    if (window.caches) Promise.all([caches.delete('bv-books'), caches.delete('bv-pages')]).then(done, done);
    else done();
  }, true);

  // ---------- Install prompt (phones & laptops) ----------
  var deferred = null;
  var bar = document.getElementById('installBar');
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  var snoozed = Number(localStorage.getItem('bv-install-snooze') || 0) > Date.now();
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  function showBar(ios) {
    if (!bar || standalone) return;
    if (ios) {
      document.getElementById('installText').innerHTML = 'Install <strong>' + bar.dataset.name + '</strong> on your iPhone: tap <strong>Share ⎋</strong> then <strong>Add to Home Screen</strong>.';
      document.getElementById('installBtn').hidden = true;
    }
    bar.hidden = false;
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    document.querySelectorAll('[data-install]').forEach(function (el) { el.hidden = false; });
    if (!snoozed) showBar(false);
  });
  if (isIOS && !standalone && !snoozed) setTimeout(function () { showBar(true); }, 2500);
  document.addEventListener('click', function (e) {
    if (e.target.closest('#installBtn, [data-install]')) {
      e.preventDefault();
      if (deferred) {
        deferred.prompt();
        deferred.userChoice.then(function () { deferred = null; if (bar) bar.hidden = true; });
      } else if (isIOS) showBar(true);
    }
    if (e.target.closest('#installClose')) {
      localStorage.setItem('bv-install-snooze', String(Date.now() + 7 * 864e5));
      bar.hidden = true;
    }
  });
  window.addEventListener('appinstalled', function () { if (bar) bar.hidden = true; });

  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { el.form.submit(); });
  });

  // ---------- Star rating input ----------
  document.querySelectorAll('.stars-input').forEach(function (box) {
    box.addEventListener('change', function () {
      var v = Number((box.querySelector('input:checked') || {}).value || 0);
      box.querySelectorAll('label').forEach(function (l) { l.classList.toggle('on', Number(l.dataset.v) <= v); });
    });
  });

  // ---------- Product form: show software fields ----------
  var kind = document.querySelector('[name=kind]');
  if (kind) {
    var sync = function () {
      var v = (document.querySelector('[name=kind]:checked') || kind).value;
      var sw = v === 'software', pr = v === 'print';
      document.querySelectorAll('[data-software]').forEach(function (el) { el.hidden = !sw; });
      document.querySelectorAll('[data-book]').forEach(function (el) { el.hidden = sw || pr; });
      document.querySelectorAll('[data-print]').forEach(function (el) { el.hidden = !pr; });
      document.querySelectorAll('[data-digital-file]').forEach(function (el) { el.hidden = pr; });
    };
    document.querySelectorAll('[name=kind]').forEach(function (r) { r.addEventListener('change', sync); });
    sync();
  }

  // ---------- Cart: live delivery prices ----------
  var stateSel = document.querySelector('[data-ship-state]');
  var checkout = document.getElementById('checkout');
  if (checkout) {
    var nf = function (k) { return '₦' + (k / 100).toLocaleString('en-NG'); };
    var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var feeEl = document.querySelector('[data-ship-fee]');
    var totalEl = document.querySelector('[data-grand-total]');
    var box = document.querySelector('[data-ship-options]');
    var updateTotal = function () {
      var sub = Number(checkout.dataset.subtotal) || 0;
      var picked = document.querySelector('input[name=ship_method]:checked');
      var fee = picked ? Number(picked.dataset.fee) : 0;
      if (feeEl) feeEl.textContent = picked ? (fee ? nf(fee) : 'Free') : 'Choose option';
      totalEl.textContent = nf(sub + fee);
    };
    document.addEventListener('change', function (e) { if (e.target.name === 'ship_method') updateTotal(); });
    if (stateSel && box) {
      stateSel.addEventListener('change', function () {
        if (!stateSel.value) { box.innerHTML = '<p class="small muted" style="margin:0">Choose your state to see delivery prices.</p>'; updateTotal(); return; }
        box.innerHTML = '<p class="small muted" style="margin:0">Checking delivery prices…</p>';
        fetch('/cart/quote?state=' + encodeURIComponent(stateSel.value), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (q) {
          var opts = Object.keys(q.options || {}).map(function (k) { return q.options[k]; });
          if (!opts.length) { box.innerHTML = '<p class="small muted" style="margin:0">No delivery option is available to this state yet. Contact the store.</p>'; updateTotal(); return; }
          var prev = box.dataset.selected;
          box.innerHTML = opts.map(function (o, i) {
            var on = prev ? prev === o.method : i === 0;
            return '<label class="pay-opt"><input form="checkout" type="radio" name="ship_method" value="' + o.method + '" data-fee="' + o.total + '"' + (on ? ' checked' : '') + '><span><strong>' + esc(o.label) + ' — ' + (o.total ? nf(o.total) : 'Free') + '</strong><span class="small muted">' + esc(o.eta) + (q.parcels > 1 ? ' · ' + q.parcels + ' parcels from different sellers' : '') + '</span></span></label>';
          }).join('');
          if (!box.querySelector('input:checked') && box.querySelector('input')) box.querySelector('input').checked = true;
          updateTotal();
        });
      });
    }
    updateTotal();
  }

  // ---------- Admin: assign product to a verified author ----------
  var asel = document.querySelector('[data-author-select]');
  if (asel) {
    var note = document.querySelector('[data-author-note]');
    var nameBox = document.querySelector('[data-author-name]');
    var naira = function (k) { return '₦' + (k / 100).toLocaleString('en-NG'); };
    var syncAuthor = function () {
      var opt = asel.options[asel.selectedIndex];
      var chosen = asel.value, current = asel.dataset.current || '';
      var n = Number(asel.dataset.sales), gross = Number(asel.dataset.gross);
      nameBox.hidden = !!chosen;
      if (chosen === current || !n) { note.hidden = true; return; }
      if (chosen) {
        var pct = opt.dataset.pct !== '' ? Number(opt.dataset.pct) : Number(asel.dataset.defaultPct);
        var earn = Math.floor(gross * (100 - pct) / 100);
        note.innerHTML = '↪ All <strong>' + n + '</strong> past sale' + (n === 1 ? '' : 's') + ' (' + naira(gross) + ') will move to <strong>' + opt.text.split(' — ')[0] +
          '</strong>, crediting about <strong>' + naira(earn) + '</strong> in royalties (' + (100 - pct) + '% share).' + (current ? ' They will be removed from the current author.' : '');
      } else {
        note.innerHTML = '↪ All <strong>' + n + '</strong> past sale' + (n === 1 ? '' : 's') + ' will move back to the store, and the current author will lose those royalties.';
      }
      note.hidden = false;
    };
    asel.addEventListener('change', syncAuthor);
    syncAuthor();
    asel.form.addEventListener('submit', function (e) {
      if (!note.hidden && !window.confirm(note.textContent.replace('↪ ', '') + '\n\nContinue?')) { e.preventDefault(); e.stopImmediatePropagation(); delete asel.form.dataset.sent; }
    }, true);
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
})();
