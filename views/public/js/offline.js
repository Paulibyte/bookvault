(function () {
  var list = [];
  try { list = JSON.parse(localStorage.getItem('bv-offline') || '[]'); } catch (e) {}
  var shelf = document.getElementById('shelf');
  if (!navigator.onLine) document.getElementById('netState').innerHTML = '<strong>You are offline.</strong> These books are stored on this device.';
  function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function render() {
    shelf.innerHTML = '';
    document.getElementById('shelfEmpty').hidden = list.length > 0;
    list.forEach(function (b) {
      var d = document.createElement('div');
      d.className = 'card lib-item';
      d.innerHTML = '<div class="thumb">' + (b.cover ? '<img src="' + esc(b.cover) + '" alt="">' : '') + '</div>' +
        '<div><div style="font-weight:650">' + esc(b.title) + '</div><div class="muted small">Saved ' + new Date(b.savedAt).toLocaleDateString() + '</div></div>' +
        '<div class="actions row"><a class="btn green" href="' + esc(b.url) + '">📖 Read</a><button class="btn sm ghost" data-rm="' + esc(b.id) + '">Remove</button></div>';
      shelf.appendChild(d);
    });
  }
  shelf.addEventListener('click', function (e) {
    var id = e.target.getAttribute('data-rm');
    if (!id || !confirm('Remove this book from this device?')) return;
    var b = list.filter(function (x) { return x.id === id; })[0];
    list = list.filter(function (x) { return x.id !== id; });
    localStorage.setItem('bv-offline', JSON.stringify(list));
    if (window.caches && b) {
      caches.open('bv-books').then(function (c) { c.delete('/read/' + id + '/file'); });
      caches.open('bv-pages').then(function (c) { c.delete(b.url); });
    }
    render();
  });
  // Drop entries whose file was evicted by the browser
  if (window.caches) {
    caches.open('bv-books').then(function (c) {
      return Promise.all(list.map(function (b) { return c.match('/read/' + b.id + '/file').then(function (r) { return r ? b : null; }); }));
    }).then(function (res) { list = res.filter(Boolean); localStorage.setItem('bv-offline', JSON.stringify(list)); render(); });
  } else render();
})();
