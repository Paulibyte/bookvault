import * as pdfjsLib from '/vendor/pdfjs/legacy/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';

const root = document.getElementById('reader');
const ITEM = root.dataset.item;
const FILE = root.dataset.file;
const PW = root.dataset.pw;
const TITLE = root.dataset.title;
const $ = id => document.getElementById(id);
const pagesEl = $('pages');
const posKey = 'bv-pos-' + ITEM;

let pdf = null;
let zoom = Number(localStorage.getItem('bv-zoom')) || 1;
let current = 1;
const pageEls = [];
const rendered = new Map();   // pageNo -> render task / true
const textCache = new Map();

// ---------- Theme ----------
if (localStorage.getItem('bv-night') === '1') document.body.classList.add('night');
$('theme').onclick = () => {
  document.body.classList.toggle('night');
  localStorage.setItem('bv-night', document.body.classList.contains('night') ? '1' : '0');
};

// ---------- Open ----------
async function open() {
  try {
    pdf = await pdfjsLib.getDocument({
      url: FILE,
      password: PW,
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      iccUrl: '/vendor/pdfjs/iccs/',
      enableXfa: false,
    }).promise;
  } catch (e) {
    const offline = !navigator.onLine;
    $('msg').innerHTML = offline
      ? 'You are offline and this book has not been saved on this device yet.<br><br>Connect to the internet, open it, and tap <b>Save offline</b>.<br><br><a href="/offline">See books saved on this device</a>'
      : 'Sorry, this book could not be opened. Please refresh the page or download it from your library.';
    $('pageInfo').textContent = 'Could not open';
    return;
  }
  $('msg').remove();
  $('pageNum').max = pdf.numPages;
  $('pageTotal').textContent = '/ ' + pdf.numPages;
  await buildPlaceholders();
  const saved = Number(localStorage.getItem(posKey)) || 1;
  if (saved > 1) goTo(saved, false);
  updateInfo();
  checkSaved();
}

async function buildPlaceholders() {
  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  for (let i = 1; i <= pdf.numPages; i++) {
    const d = document.createElement('div');
    d.className = 'pg';
    d.dataset.page = i;
    d.dataset.ratio = vp1.height / vp1.width;
    const n = document.createElement('span'); n.className = 'no'; n.textContent = i;
    d.appendChild(n);
    pagesEl.appendChild(d);
    pageEls.push(d);
  }
  sizePages();
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      const no = Number(en.target.dataset.page);
      if (en.isIntersecting) renderPage(no);
    }
  }, { rootMargin: '600px 0px' });
  pageEls.forEach(el => io.observe(el));

  const vis = new IntersectionObserver(entries => {
    let best = null;
    for (const en of entries) if (en.isIntersecting && (!best || en.intersectionRatio > best.intersectionRatio)) best = en;
    if (best) { current = Number(best.target.dataset.page); updateInfo(); localStorage.setItem(posKey, current); }
  }, { threshold: [0.3, 0.6] });
  pageEls.forEach(el => vis.observe(el));
}

function baseWidth() { return Math.min(window.innerWidth - 20, 900); }

function sizePages() {
  const w = baseWidth() * zoom;
  for (const el of pageEls) {
    el.style.width = w + 'px';
    el.style.height = (w * Number(el.dataset.ratio)) + 'px';
  }
}

async function renderPage(no) {
  if (rendered.has(no)) return;
  rendered.set(no, true);
  const el = pageEls[no - 1];
  try {
    const page = await pdf.getPage(no);
    const vp1 = page.getViewport({ scale: 1 });
    el.dataset.ratio = vp1.height / vp1.width;
    const cssW = baseWidth() * zoom;
    el.style.height = (cssW * vp1.height / vp1.width) + 'px';
    const scale = (cssW / vp1.width) * Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const old = el.querySelector('canvas'); if (old) old.remove();
    el.prepend(canvas);
  } catch (e) { rendered.delete(no); }
  // free memory: drop canvases far from view
  for (const [p] of rendered) {
    if (Math.abs(p - no) > 8) { const c = pageEls[p - 1].querySelector('canvas'); if (c) c.remove(); rendered.delete(p); }
  }
}

function rerenderAll() {
  rendered.clear();
  pageEls.forEach(el => { const c = el.querySelector('canvas'); if (c) c.remove(); });
  sizePages();
  goTo(current, false);
  for (let p = Math.max(1, current - 1); p <= Math.min(pdf.numPages, current + 2); p++) renderPage(p);
}

function goTo(no, smooth = true) {
  no = Math.min(Math.max(1, no), pdf ? pdf.numPages : 1);
  const el = pageEls[no - 1];
  if (el) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  current = no; updateInfo();
}

function updateInfo() {
  if (!pdf) return;
  $('pageInfo').textContent = `Page ${current} of ${pdf.numPages}`;
  if (document.activeElement !== $('pageNum')) $('pageNum').value = current;
}

$('prev').onclick = () => goTo(current - 1);
$('next').onclick = () => goTo(current + 1);
$('pageNum').onchange = e => goTo(Number(e.target.value));
$('zoomIn').onclick = () => { zoom = Math.min(zoom + 0.2, 2.6); localStorage.setItem('bv-zoom', zoom); rerenderAll(); };
$('zoomOut').onclick = () => { zoom = Math.max(zoom - 0.2, 0.6); localStorage.setItem('bv-zoom', zoom); rerenderAll(); };
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => pdf && rerenderAll(), 300); });
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(current + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(current - 1);
});

// ---------- Offline ----------
const BOOKS = 'bv-books';
const PAGES = 'bv-pages';
function shelf() { try { return JSON.parse(localStorage.getItem('bv-offline') || '[]'); } catch { return []; } }
function setShelf(list) { localStorage.setItem('bv-offline', JSON.stringify(list)); }

async function checkSaved() {
  if (!('caches' in window)) { $('saveOffline').hidden = true; return; }
  const c = await caches.open(BOOKS);
  if (await c.match(FILE)) markSaved();
}
function markSaved() {
  const b = $('saveOffline');
  b.classList.add('done');
  b.innerHTML = '✓ <span>Saved offline</span>';
  b.title = 'Saved on this device — tap to remove';
  b.dataset.saved = '1';
}
$('saveOffline').onclick = async () => {
  const b = $('saveOffline');
  if (!('caches' in window)) return;
  if (b.dataset.saved) {
    if (!confirm('Remove this book from this device? You can save it again any time.')) return;
    await (await caches.open(BOOKS)).delete(FILE);
    await (await caches.open(PAGES)).delete(location.pathname);
    setShelf(shelf().filter(x => x.id !== ITEM));
    delete b.dataset.saved; b.classList.remove('done'); b.innerHTML = '⤓ <span>Save offline</span>';
    return;
  }
  b.disabled = true; b.innerHTML = '… <span>Saving</span>';
  try {
    const res = await fetch(FILE, { credentials: 'same-origin' });
    if (!res.ok) throw new Error();
    await (await caches.open(BOOKS)).put(FILE, res);
    const page = await fetch(location.pathname, { credentials: 'same-origin' });
    if (page.ok) await (await caches.open(PAGES)).put(location.pathname, page);
    const list = shelf().filter(x => x.id !== ITEM);
    list.unshift({ id: ITEM, title: TITLE, cover: root.dataset.cover, url: location.pathname, savedAt: Date.now() });
    setShelf(list);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    markSaved();
  } catch {
    b.innerHTML = '⤓ <span>Save offline</span>';
    alert('Could not save this book for offline reading. Check your connection and try again.');
  }
  b.disabled = false;
};

// ---------- Read aloud ----------
const synth = window.speechSynthesis;
const tts = { on: false, playing: false, page: 1, sentences: [], idx: 0, voice: null, fails: 0 };

if (!synth) { $('listen').hidden = true; }

function loadVoices() {
  const voices = synth.getVoices().filter(v => /^en/i.test(v.lang));
  const all = voices.length ? voices : synth.getVoices();
  const order = v => (/en-NG/i.test(v.lang) ? 0 : /en-GB/i.test(v.lang) ? 1 : /en-US/i.test(v.lang) ? 2 : 3) + (v.localService ? 0 : 0.5);
  all.sort((a, b) => order(a) - order(b));
  const sel = $('ttsVoice');
  const saved = localStorage.getItem('bv-voice');
  sel.innerHTML = '';
  all.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = v.name; o.textContent = `${v.name.replace(/Microsoft |Google /, '')} (${v.lang})`;
    if (v.name === saved || (!saved && i === 0)) o.selected = true;
    sel.appendChild(o);
  });
  tts.voice = all.find(v => v.name === sel.value) || null;
}
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
$('ttsVoice').onchange = e => {
  tts.voice = synth.getVoices().find(v => v.name === e.target.value) || null;
  localStorage.setItem('bv-voice', e.target.value);
  if (tts.playing) speakCurrent();
};
$('ttsRate').value = localStorage.getItem('bv-rate') || '1';
$('ttsRate').onchange = e => { localStorage.setItem('bv-rate', e.target.value); if (tts.playing) speakCurrent(); };

async function pageText(no) {
  if (textCache.has(no)) return textCache.get(no);
  const page = await pdf.getPage(no);
  const tc = await page.getTextContent();
  let s = '';
  for (const it of tc.items) { s += it.str; s += it.hasEOL ? ' ' : (it.str.endsWith(' ') ? '' : ' '); }
  s = s.replace(/\s+/g, ' ').replace(/-\s(?=[a-z])/g, '').trim();
  textCache.set(no, s);
  return s;
}

function splitSentences(text) {
  const parts = text.match(/[^.!?;:]+[.!?;:]+["')\]]*\s*|[^.!?;:]+$/g) || [];
  const out = [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    while (p.length > 220) {           // keep utterances short (mobile browsers cut long ones)
      let cut = p.lastIndexOf(' ', 220); if (cut < 80) cut = 220;
      out.push(p.slice(0, cut)); p = p.slice(cut).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

async function loadPage(no) {
  tts.page = no; tts.idx = 0;
  pageEls.forEach(el => el.classList.toggle('reading', Number(el.dataset.page) === no));
  tts.sentences = splitSentences(await pageText(no));
}

function showNow() {
  const s = tts.sentences[tts.idx] || '';
  $('ttsNow').innerHTML = s ? `<b>Page ${tts.page}:</b> ` + s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) : `<b>Page ${tts.page}:</b> (no readable text on this page)`;
}

function speakCurrent() {
  synth.cancel();
  if (!tts.playing) return;
  if (tts.idx >= tts.sentences.length) return nextPage();
  showNow();
  const u = new SpeechSynthesisUtterance(tts.sentences[tts.idx]);
  if (tts.voice) { u.voice = tts.voice; u.lang = tts.voice.lang; }
  u.rate = Number($('ttsRate').value) || 1;
  const myIdx = tts.idx, myPage = tts.page;
  u.onstart = () => { tts.fails = 0; };
  u.onend = () => {
    if (!tts.playing || myIdx !== tts.idx || myPage !== tts.page) return;
    tts.idx++; speakCurrent();
  };
  u.onerror = ev => {
    if (ev.error === 'interrupted' || ev.error === 'canceled') return;
    if (++tts.fails >= 3) { stopTts('Read-aloud is not available in this browser. Try Chrome or Edge, or install a text-to-speech voice in your device settings.'); return; }
    tts.idx++; speakCurrent();
  };
  synth.speak(u);
}

async function nextPage() {
  if (tts.page >= pdf.numPages) { stopTts('Finished reading the book.'); return; }
  if (!$('ttsAuto').checked) { setPlaying(false); $('ttsNow').innerHTML = `<b>End of page ${tts.page}.</b> Press play to continue.`; await loadPage(tts.page + 1); return; }
  await loadPage(tts.page + 1);
  goTo(tts.page);
  speakCurrent();
}

function setPlaying(p) { tts.playing = p; $('ttsPlay').textContent = p ? '❚❚' : '▶'; }

function stopTts(msg) {
  setPlaying(false); synth.cancel();
  pageEls.forEach(el => el.classList.remove('reading'));
  $('ttsNow').textContent = msg || 'Stopped.';
}

$('listen').onclick = () => {
  const panel = $('tts');
  panel.hidden = !panel.hidden;
  document.body.classList.toggle('tts-open', !panel.hidden);
  if (!panel.hidden && !tts.on) { tts.on = true; $('ttsNow').innerHTML = `Press ▶ to start reading from <b>page ${current}</b>.`; }
};
$('ttsClose').onclick = () => { stopTts(); $('tts').hidden = true; document.body.classList.remove('tts-open'); };
$('ttsPlay').onclick = async () => {
  if (!pdf) return;
  if (tts.playing) { setPlaying(false); synth.cancel(); $('ttsNow').innerHTML = `<b>Paused</b> on page ${tts.page}.`; return; }
  if (!synth.getVoices().length) {
    $('ttsNow').textContent = 'No reading voice found on this device. Install a text-to-speech voice in your phone or computer settings, then reopen the book.';
    return;
  }
  if (!tts.sentences.length || tts.page !== current && !tts.idx) await loadPage(current);
  tts.fails = 0;
  setPlaying(true); speakCurrent();
};
$('ttsStop').onclick = () => { stopTts(); tts.sentences = []; };
$('ttsNext').onclick = () => { if (!tts.sentences.length) return; tts.idx++; if (tts.playing) speakCurrent(); else showNow(); };
$('ttsPrev').onclick = () => { if (!tts.sentences.length) return; tts.idx = Math.max(0, tts.idx - 1); if (tts.playing) speakCurrent(); else showNow(); };
// Chrome desktop pauses long speech queues when the tab is hidden; keep it alive
setInterval(() => { if (tts.playing && synth.paused) synth.resume(); }, 5000);
window.addEventListener('pagehide', () => synth && synth.cancel());

open();
