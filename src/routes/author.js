const express = require('express');
const { db, getSettings } = require('../db');
const { flash, requireLogin } = require('../middleware');
const { authorBalance, requestPayout, commissionFor } = require('../orders');
const { clearDeliveries } = require('../deliver');
const P = require('../products');

const router = express.Router();

const applyFields = P.upload.fields([{ name: 'id_file', maxCount: 1 }, { name: 'photo', maxCount: 1 }]);
const bookFields = P.upload.fields([{ name: 'file', maxCount: 1 }, { name: 'cover', maxCount: 1 }, { name: 'copyright_doc', maxCount: 1 }]);

router.use((req, res, next) => {
  if (getSettings().authors_enabled !== '1' && !(req.user && req.user.is_admin)) {
    return res.status(404).render('error', { title: 'Not available', message: 'Author sign-ups are currently closed.' });
  }
  req.author = req.user ? db.prepare('SELECT * FROM authors WHERE user_id = ?').get(req.user.id) : null;
  res.locals.author = req.author;
  next();
});

function requireVerified(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (!req.author || req.author.status !== 'verified') return res.redirect('/author');
  next();
}

// ---------- Landing / application ----------
router.get('/', (req, res) => {
  if (req.author && req.author.status === 'verified') return res.redirect('/author/dashboard');
  const s = getSettings();
  res.render('author/landing', { title: 'Publish with us', commission: Number(s.default_commission_pct), minPayout: Number(s.payout_min_kobo) });
});

router.post('/apply', requireLogin, applyFields, async (req, res, next) => {
  try {
    if (req.author && ['verified', 'suspended'].includes(req.author.status)) { P.cleanupFiles(req); return res.redirect('/author'); }
    const b = req.body;
    const pen = (b.pen_name || '').trim(), legal = (b.legal_name || '').trim();
    const errors = [];
    if (pen.length < 2) errors.push('Enter your pen name (the name readers will see).');
    if (legal.length < 3) errors.push('Enter your full legal name.');
    if (!(b.phone || '').trim()) errors.push('Enter a phone number.');
    if ((b.bio || '').trim().length < 30) errors.push('Tell readers a little about yourself (at least 30 characters).');
    const idFile = req.files && req.files.id_file && req.files.id_file[0];
    if (!idFile && !(req.author && req.author.id_file)) errors.push('Upload a valid means of identification.');
    if (!b.agree) errors.push('Please accept the author terms.');
    if (errors.length) { P.cleanupFiles(req); errors.forEach(e => flash(req, 'error', e)); return res.redirect('/author#apply'); }

    const idName = idFile ? await P.savePrivateDoc(idFile, 'id') : req.author.id_file;
    const photo = await P.savePhoto(req.files && req.files.photo && req.files.photo[0]);
    const vals = [pen, legal, (b.bio || '').trim(), (b.phone || '').trim(), (b.address || '').trim(), (b.institution || '').trim(), (b.id_type || '').trim(), idName];
    if (req.author) {
      db.prepare(`UPDATE authors SET pen_name=?, legal_name=?, bio=?, phone=?, address=?, institution=?, id_type=?, id_file=?,
        photo_file=COALESCE(?, photo_file), status='pending', review_note=NULL WHERE id=?`).run(...vals, photo, req.author.id);
    } else {
      db.prepare(`INSERT INTO authors (pen_name, legal_name, bio, phone, address, institution, id_type, id_file, photo_file, user_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...vals, photo, req.user.id);
    }
    flash(req, 'success', 'Application received! We will review your details and verify your account shortly.');
    res.redirect('/author');
  } catch (e) { P.cleanupFiles(req); flash(req, 'error', e.message); res.redirect('/author#apply'); }
});

// ---------- Dashboard ----------
router.get('/dashboard', requireVerified, (req, res) => {
  const a = req.author;
  const bal = authorBalance(a.id);
  const totals = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(oi.price_kobo),0) gross, COALESCE(SUM(oi.author_earning_kobo),0) earned
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.author_id = ? AND o.status = 'paid'`).get(a.id);
  const books = db.prepare(`SELECT p.id, p.title, p.slug, p.status, p.is_active, p.price_kobo, p.rating_avg, p.rating_count, p.cover_file, p.kind,
      (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status='paid' AND oi.author_id = ?) sold,
      (SELECT COALESCE(SUM(oi.author_earning_kobo),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status='paid' AND oi.author_id = ?) earned
    FROM products p WHERE p.author_id = ? ORDER BY sold DESC, p.id DESC`).all(a.id, a.id, a.id);
  const recent = db.prepare(`SELECT o.paid_at, p.title, oi.price_kobo, oi.author_earning_kobo, oi.commission_pct
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
    WHERE oi.author_id = ? AND o.status = 'paid' ORDER BY o.paid_at DESC LIMIT 25`).all(a.id);
  const monthly = db.prepare(`SELECT strftime('%Y-%m', o.paid_at) m, SUM(oi.author_earning_kobo) v, COUNT(*) n
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.author_id = ? AND o.status='paid' AND o.paid_at >= date('now','start of month','-5 months')
    GROUP BY m`).all(a.id);
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const m = d.toISOString().slice(0, 7);
    const r = monthly.find(x => x.m === m) || {};
    months.push({ m, label: d.toLocaleString('en-GB', { month: 'short' }), v: r.v || 0, n: r.n || 0 });
  }
  res.render('author/dashboard', { title: 'Author dashboard', bal, totals, books, recent, months, commission: commissionFor(a.id), minPayout: Number(getSettings().payout_min_kobo) });
});

// ---------- Books ----------
router.get('/books', requireVerified, (req, res) => {
  const books = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status='paid') sold
    FROM products p WHERE p.author_id = ? ORDER BY p.id DESC`).all(req.author.id);
  res.render('author/books', { title: 'My titles', books });
});

function formData(req, p) {
  let cr = p.copyright_json ? JSON.parse(p.copyright_json) : {};
  if (req.session.authorForm) { p = { ...p, ...req.session.authorForm, price_kobo: P.nairaToKobo(req.session.authorForm.price) }; cr = req.session.authorForm; delete req.session.authorForm; }
  return { title: 'Submit a title', p, categories: db.prepare('SELECT * FROM categories ORDER BY name').all(), maxMb: P.MAX_MB, platforms: P.PLATFORMS,
    cr };
}

router.get('/books/new', requireVerified, (req, res) => res.render('author/book-form', formData(req, { kind: 'book' })));

function readCopyright(req, a) {
  const b = req.body;
  const errors = [];
  const basis = ['sole', 'coauthor', 'licensed'].includes(b.rights_basis) ? b.rights_basis : null;
  if (!basis) errors.push('Choose how you hold the rights to this work.');
  if (basis === 'coauthor' && !(b.co_authors || '').trim()) errors.push('List the co-authors who consented.');
  if (basis === 'licensed' && !(b.rights_holder || '').trim()) errors.push('Name the copyright owner who licensed the rights to you.');
  for (const k of ['decl_original', 'decl_third_party', 'decl_license', 'decl_indemnity']) if (!b[k]) errors.push('Tick all four declarations in the copyright form.');
  const sig = (b.signature || '').trim();
  if (sig.toLowerCase().replace(/\s+/g, ' ') !== a.legal_name.toLowerCase().replace(/\s+/g, ' ')) errors.push(`Type your full legal name exactly as "${a.legal_name}" to sign the copyright form.`);
  return {
    errors: [...new Set(errors)],
    data: {
      rights_basis: basis, co_authors: (b.co_authors || '').trim(), rights_holder: (b.rights_holder || '').trim(),
      isbn: (b.isbn || '').trim(), publisher: (b.publisher || '').trim(), year_published: (b.year_published || '').trim(),
      edition: (b.edition || '').trim(), previously_published: b.previously_published === 'yes' ? 'yes' : 'no',
      declarations: { original: true, third_party: true, license: true, indemnity: true },
      signature: sig, signed_at: new Date().toISOString(), ip: req.ip, user_agent: (req.get('user-agent') || '').slice(0, 200),
    },
  };
}

router.post('/books/new', requireVerified, bookFields, async (req, res, next) => {
  const a = req.author, b = req.body;
  try {
    const file = req.files && req.files.file && req.files.file[0];
    const kind = b.kind === 'software' ? 'software' : 'book';
    const errors = [];
    if (!(b.title || '').trim()) errors.push('Enter a title.');
    if (!file) errors.push('Upload the file you want to sell.');
    if ((b.description || '').trim().length < 40) errors.push('Write a description of at least 40 characters.');
    const cr = readCopyright(req, a);
    errors.push(...cr.errors);
    if (errors.length) { P.cleanupFiles(req); errors.forEach(e => flash(req, 'error', e)); req.session.authorForm = b; return res.redirect('/author/books/new'); }
    const meta = await P.saveProductFile(file, kind);
    const cover = await P.saveCover(req.files.cover && req.files.cover[0]);
    const crDoc = await P.savePrivateDoc(req.files.copyright_doc && req.files.copyright_doc[0], 'copyright');
    const title = b.title.trim();
    db.prepare(`INSERT INTO products (title, slug, author, category_id, description, price_kobo, cover_file, stored_file, original_name, file_type, file_size, pages,
      protect, is_active, kind, platform, version, author_id, status, copyright_json, copyright_file, submitted_at, reader_pdf)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,'pending',?,?,datetime('now'),?)`).run(
      title, P.uniqueSlug(title), a.pen_name, P.categoryId(b), b.description.trim(), P.nairaToKobo(b.price), cover,
      meta.stored, meta.original, meta.type, meta.size, meta.pages, kind,
      kind === 'software' ? (b.platform || '').trim() : null, kind === 'software' ? (b.version || '').trim() : null,
      a.id, JSON.stringify(cr.data), crDoc, meta.readerPdf);
    delete req.session.authorForm;
    flash(req, 'success', `"${title}" was submitted for review. You'll see it go live here once it's approved.`);
    res.redirect('/author/books');
  } catch (e) { P.cleanupFiles(req); flash(req, 'error', e.message); res.redirect('/author/books/new'); }
});

function ownBook(req) {
  return db.prepare('SELECT * FROM products WHERE id = ? AND author_id = ?').get(Number(req.params.id), req.author.id);
}

router.get('/books/:id', requireVerified, (req, res) => {
  const p = ownBook(req);
  if (!p) return res.redirect('/author/books');
  res.render('author/book-form', { ...formData(req, p), title: 'Edit title' });
});

router.post('/books/:id', requireVerified, bookFields, async (req, res) => {
  const a = req.author, b = req.body;
  const p = ownBook(req);
  if (!p) { P.cleanupFiles(req); return res.redirect('/author/books'); }
  try {
    const file = req.files && req.files.file && req.files.file[0];
    const needsReview = !!file || p.status === 'rejected' || p.status === 'draft' || (p.status === 'published' && (b.title || '').trim() !== p.title);
    let cr = null;
    if (needsReview) {
      cr = readCopyright(req, a);
      if (cr.errors.length) { P.cleanupFiles(req); cr.errors.forEach(e => flash(req, 'error', e)); return res.redirect(`/author/books/${p.id}`); }
    }
    const meta = file ? await P.saveProductFile(file, p.kind) : null;
    const coverFile = req.files && req.files.cover && req.files.cover[0];
    const cover = coverFile ? (await P.saveCover(coverFile)) || p.cover_file : p.cover_file;
    const crDoc = await P.savePrivateDoc(req.files && req.files.copyright_doc && req.files.copyright_doc[0], 'copyright');
    const title = (b.title || p.title).trim();
    db.prepare(`UPDATE products SET title=?, slug=?, category_id=?, description=?, price_kobo=?, cover_file=?,
      stored_file=?, original_name=?, file_type=?, file_size=?, pages=?, reader_pdf=?, platform=?, version=?,
      status=?, copyright_json=COALESCE(?, copyright_json), copyright_file=COALESCE(?, copyright_file),
      submitted_at=CASE WHEN ? THEN datetime('now') ELSE submitted_at END, updated_at=datetime('now') WHERE id=?`).run(
      title, title === p.title ? p.slug : P.uniqueSlug(title, p.id), P.categoryId(b), (b.description || '').trim(), P.nairaToKobo(b.price), cover,
      meta ? meta.stored : p.stored_file, meta ? meta.original : p.original_name, meta ? meta.type : p.file_type,
      meta ? meta.size : p.file_size, meta ? meta.pages : p.pages, meta ? meta.readerPdf : p.reader_pdf,
      p.kind === 'software' ? (b.platform || '').trim() : null, p.kind === 'software' ? (b.version || '').trim() : null,
      needsReview ? 'pending' : p.status, cr ? JSON.stringify(cr.data) : null, crDoc, needsReview ? 1 : 0, p.id);
    if (meta) { P.removeStored(p.stored_file, p.reader_pdf); clearDeliveries(p.id); }
    flash(req, 'success', needsReview ? 'Changes submitted for review. The title is hidden from the store until it is approved again.' : 'Changes saved.');
    res.redirect('/author/books');
  } catch (e) { P.cleanupFiles(req); flash(req, 'error', e.message); res.redirect(`/author/books/${p.id}`); }
});

// ---------- Royalties ----------
router.get('/payouts', requireVerified, (req, res) => {
  const payouts = db.prepare('SELECT * FROM payouts WHERE author_id = ? ORDER BY id DESC').all(req.author.id);
  res.render('author/payouts', { title: 'Royalties', bal: authorBalance(req.author.id), payouts, minPayout: Number(getSettings().payout_min_kobo), commission: commissionFor(req.author.id) });
});

router.post('/payouts/request', requireVerified, (req, res) => {
  const pending = db.prepare("SELECT COUNT(*) c FROM payouts WHERE author_id = ? AND status = 'requested'").get(req.author.id).c;
  if (pending) { flash(req, 'info', 'You already have a payout request being processed.'); return res.redirect('/author/payouts'); }
  const r = requestPayout(req.author.id, 'request');
  if (r.error) flash(req, 'error', r.error);
  else flash(req, 'success', `Payout of ₦${(r.amount / 100).toLocaleString('en-NG')} requested. You'll be notified when it is paid.`);
  res.redirect('/author/payouts');
});

router.post('/bank', requireVerified, (req, res) => {
  const b = req.body;
  const acct = (b.bank_account_number || '').replace(/\D/g, '');
  if (acct && acct.length !== 10) { flash(req, 'error', 'Account number must be 10 digits (NUBAN).'); return res.redirect('/author/payouts#bank'); }
  db.prepare('UPDATE authors SET bank_name = ?, bank_account_number = ?, bank_account_name = ?, auto_payout = ? WHERE id = ?')
    .run((b.bank_name || '').trim(), acct, (b.bank_account_name || '').trim(), b.auto_payout ? 1 : 0, req.author.id);
  flash(req, 'success', 'Payout settings saved.');
  res.redirect('/author/payouts');
});

// ---------- Profile ----------
router.get('/profile', requireVerified, (req, res) => res.render('author/profile', { title: 'Author profile' }));

router.post('/profile', requireVerified, P.upload.single('photo'), async (req, res) => {
  const b = req.body;
  const photo = await P.savePhoto(req.file);
  const pen = (b.pen_name || '').trim() || req.author.pen_name;
  db.prepare('UPDATE authors SET pen_name = ?, bio = ?, institution = ?, phone = ?, photo_file = COALESCE(?, photo_file) WHERE id = ?')
    .run(pen, (b.bio || '').trim(), (b.institution || '').trim(), (b.phone || '').trim(), photo, req.author.id);
  db.prepare('UPDATE products SET author = ? WHERE author_id = ?').run(pen, req.author.id);
  flash(req, 'success', 'Profile updated.');
  res.redirect('/author/profile');
});

module.exports = router;
