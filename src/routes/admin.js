const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const { db, getSettings, setSetting } = require('../db');
const { DIRS, slugify, fileTypeOf, makePassword } = require('../util');
const { flash, requireAdmin } = require('../middleware');
const { markPaid } = require('../orders');
const { clearDeliveries, buildDelivery } = require('../deliver');
const { normalisePdf } = require('../watermark/pdf');
const { validateDocx } = require('../watermark/docx');
const opay = require('../opay');

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  res.locals.awaitingCount = db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'awaiting_confirmation'").get().c;
  next();
});

const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 500;
const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.tmp,
    filename: (req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});
const productFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

function nairaToKobo(v) {
  const n = parseFloat(String(v || '0').replace(/[^0-9.]/g, ''));
  return Math.round((isNaN(n) ? 0 : n) * 100);
}

function uniqueSlug(title, exceptId = 0) {
  const base = slugify(title);
  let s = base, i = 2;
  while (db.prepare('SELECT 1 FROM products WHERE slug = ? AND id != ?').get(s, exceptId)) s = `${base}-${i++}`;
  return s;
}

function categoryId(body) {
  const newCat = (body.new_category || '').trim();
  if (newCat) {
    db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(newCat);
    return db.prepare('SELECT id FROM categories WHERE name = ?').get(newCat).id;
  }
  return Number(body.category_id) || null;
}

async function saveCover(file) {
  if (!file) return null;
  const name = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}.webp`;
  try {
    await sharp(file.path).rotate().resize({ width: 700, height: 980, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toFile(path.join(DIRS.covers, name));
    return name;
  } finally { fs.promises.unlink(file.path).catch(() => {}); }
}

/** Validate + move an uploaded product file into storage. Returns meta. */
async function saveProductFile(file) {
  const type = fileTypeOf(file.originalname);
  const stored = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`;
  const dest = path.join(DIRS.products, stored);
  let pages = null;
  try {
    if (type === 'pdf') {
      ({ pages } = await normalisePdf(file.path, dest));
    } else {
      if (type === 'docx') await validateDocx(file.path);
      await fs.promises.copyFile(file.path, dest);
    }
  } finally { fs.promises.unlink(file.path).catch(() => {}); }
  const size = (await fs.promises.stat(dest)).size;
  return { stored, type, pages, size, original: file.originalname };
}

function cleanupFiles(req) {
  for (const arr of Object.values(req.files || {})) for (const f of arr) fs.promises.unlink(f.path).catch(() => {});
}

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const stats = {
    revenue: db.prepare("SELECT COALESCE(SUM(total_kobo),0) v FROM orders WHERE status = 'paid'").get().v,
    revenueMonth: db.prepare("SELECT COALESCE(SUM(total_kobo),0) v FROM orders WHERE status = 'paid' AND paid_at >= date('now','start of month')").get().v,
    paidOrders: db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'paid'").get().c,
    awaiting: db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'awaiting_confirmation'").get().c,
    products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
    customers: db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 0').get().c,
    downloads: db.prepare('SELECT COUNT(*) c FROM downloads').get().c,
  };
  const top = db.prepare(`SELECT p.title, COUNT(*) n, SUM(oi.price_kobo) v FROM order_items oi JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id WHERE o.status = 'paid' GROUP BY p.id ORDER BY n DESC LIMIT 6`).all();
  const awaiting = db.prepare(`SELECT o.*, u.full_name FROM orders o JOIN users u ON u.id = o.user_id
    WHERE o.status = 'awaiting_confirmation' ORDER BY o.id LIMIT 10`).all();
  const recent = db.prepare(`SELECT o.*, u.full_name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 8`).all();
  const daily = db.prepare(`SELECT date(paid_at) d, SUM(total_kobo) v FROM orders WHERE status='paid' AND paid_at >= date('now','-13 days')
    GROUP BY date(paid_at)`).all();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ d, v: (daily.find(x => x.d === d) || {}).v || 0 });
  }
  const warnings = [];
  const s = getSettings();
  if (s.bank_enabled === '1' && !s.bank_account_number) warnings.push('Add your bank account details in Settings so buyers know where to pay.');
  if (s.opay_enabled === '1' && !opay.configured()) warnings.push('OPay is switched on but keys are missing from the .env file.');
  if (!s.watermark_logo) warnings.push('Upload a watermark logo in Settings (header/footer text is already active).');
  res.render('admin/dashboard', { title: 'Dashboard', stats, top, awaiting, recent, days, warnings });
});

// ---------- Products ----------
router.get('/products', (req, res) => {
  const products = db.prepare(`SELECT p.*, c.name category,
    (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status='paid') sold
    FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC`).all();
  res.render('admin/products', { title: 'Products', products });
});

router.get('/products/new', (req, res) => {
  res.render('admin/product-form', { title: 'Add product', p: { protect: 1, is_active: 1 }, categories: db.prepare('SELECT * FROM categories ORDER BY name').all(), maxMb: MAX_MB });
});

router.post('/products/new', productFields, async (req, res, next) => {
  try {
    const file = req.files && req.files.file && req.files.file[0];
    const title = (req.body.title || '').trim();
    if (!title || !file) { cleanupFiles(req); flash(req, 'error', 'Title and file are required.'); return res.redirect('/admin/products/new'); }
    let meta;
    try { meta = await saveProductFile(file); }
    catch (e) { cleanupFiles(req); flash(req, 'error', e.message); return res.redirect('/admin/products/new'); }
    const cover = await saveCover(req.files.cover && req.files.cover[0]);
    db.prepare(`INSERT INTO products (title, slug, author, category_id, description, price_kobo, cover_file, stored_file, original_name, file_type, file_size, pages, protect, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      title, uniqueSlug(title), (req.body.author || '').trim(), categoryId(req.body), (req.body.description || '').trim(),
      nairaToKobo(req.body.price), cover, meta.stored, meta.original, meta.type, meta.size, meta.pages,
      req.body.protect ? 1 : 0, req.body.is_active ? 1 : 0);
    const note = (meta.type === 'pdf' || meta.type === 'docx') ? '' : ' (this file type is delivered as-is, without watermark/password)';
    flash(req, 'success', `"${title}" added${note}.`);
    res.redirect('/admin/products');
  } catch (e) { cleanupFiles(req); next(e); }
});

router.get('/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.redirect('/admin/products');
  res.render('admin/product-form', { title: 'Edit product', p, categories: db.prepare('SELECT * FROM categories ORDER BY name').all(), maxMb: MAX_MB });
});

router.post('/products/:id', productFields, async (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) { cleanupFiles(req); return res.redirect('/admin/products'); }
    const file = req.files && req.files.file && req.files.file[0];
    let meta = null;
    if (file) {
      try { meta = await saveProductFile(file); }
      catch (e) { cleanupFiles(req); flash(req, 'error', e.message); return res.redirect(`/admin/products/${p.id}`); }
    }
    const coverFile = req.files && req.files.cover && req.files.cover[0];
    const cover = coverFile ? await saveCover(coverFile) : p.cover_file;
    if (coverFile && p.cover_file) fs.promises.unlink(path.join(DIRS.covers, p.cover_file)).catch(() => {});
    const title = (req.body.title || p.title).trim();
    const protect = req.body.protect ? 1 : 0;
    db.prepare(`UPDATE products SET title=?, slug=?, author=?, category_id=?, description=?, price_kobo=?, cover_file=?,
      stored_file=?, original_name=?, file_type=?, file_size=?, pages=?, protect=?, is_active=?, updated_at=datetime('now') WHERE id=?`).run(
      title, title === p.title ? p.slug : uniqueSlug(title, p.id), (req.body.author || '').trim(), categoryId(req.body),
      (req.body.description || '').trim(), nairaToKobo(req.body.price), cover,
      meta ? meta.stored : p.stored_file, meta ? meta.original : p.original_name, meta ? meta.type : p.file_type,
      meta ? meta.size : p.file_size, meta ? meta.pages : p.pages, protect, req.body.is_active ? 1 : 0, p.id);
    if (meta || protect !== p.protect) {
      const n = clearDeliveries(p.id);
      if (meta) fs.promises.unlink(path.join(DIRS.products, p.stored_file)).catch(() => {});
      if (n) flash(req, 'info', `${n} previous buyer download(s) will be regenerated with the new file on their next download.`);
    }
    flash(req, 'success', 'Product saved.');
    res.redirect('/admin/products');
  } catch (e) { cleanupFiles(req); next(e); }
});

router.post('/products/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.redirect('/admin/products');
  const sold = db.prepare('SELECT COUNT(*) c FROM order_items WHERE product_id = ?').get(p.id).c;
  if (sold) {
    db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(p.id);
    flash(req, 'info', 'This product has orders, so it was hidden from the store instead of deleted. Buyers keep access.');
  } else {
    db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    fs.promises.unlink(path.join(DIRS.products, p.stored_file)).catch(() => {});
    if (p.cover_file) fs.promises.unlink(path.join(DIRS.covers, p.cover_file)).catch(() => {});
    flash(req, 'success', 'Product deleted.');
  }
  res.redirect('/admin/products');
});

// Preview the watermark exactly as a buyer would receive it
router.post('/products/:id/test', async (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) return res.redirect('/admin/products');
    const reference = 'TEST' + Date.now().toString().slice(-8);
    const info = db.prepare("INSERT INTO orders (reference, user_id, total_kobo, method, status, paid_at, admin_note) VALUES (?, ?, 0, 'bank', 'paid', datetime('now'), 'Admin test copy')")
      .run(reference, req.user.id);
    const pw = makePassword(8);
    const it = db.prepare('INSERT INTO order_items (order_id, product_id, price_kobo, file_password) VALUES (?, ?, 0, ?)').run(info.lastInsertRowid, p.id, pw);
    flash(req, 'info', `Test copy created for your own account. Password: ${pw} — click Download below.`);
    res.redirect(`/admin/orders/${info.lastInsertRowid}`);
  } catch (e) { next(e); }
});

// ---------- Orders ----------
router.get('/orders', (req, res) => {
  const status = req.query.status || '';
  const q = (req.query.q || '').trim();
  const where = ["o.admin_note IS NOT 'Admin test copy'"], params = [];
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (q) { where.push('(o.reference LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR o.bank_sender_name LIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
  const orders = db.prepare(`SELECT o.*, u.full_name, u.email, u.phone,
    (SELECT GROUP_CONCAT(p.title, ' • ') FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id) titles
    FROM orders o JOIN users u ON u.id = o.user_id WHERE ${where.join(' AND ')} ORDER BY
    CASE o.status WHEN 'awaiting_confirmation' THEN 0 ELSE 1 END, o.id DESC LIMIT 300`).all(...params);
  res.render('admin/orders', { title: 'Orders', orders, status, q });
});

router.get('/orders/:id', (req, res) => {
  const o = db.prepare(`SELECT o.*, u.full_name, u.email, u.phone FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`).get(Number(req.params.id));
  if (!o) return res.redirect('/admin/orders');
  o.items = db.prepare(`SELECT oi.*, p.title, p.file_type, p.protect FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(o.id);
  const downloads = db.prepare(`SELECT d.*, p.title FROM downloads d JOIN order_items oi ON oi.id = d.order_item_id
    JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY d.id DESC`).all(o.id);
  res.render('admin/order', { title: `Order ${o.reference}`, o, downloads });
});

router.post('/orders/:id/confirm', (req, res) => {
  markPaid(Number(req.params.id), { note: (req.body.note || '').trim() || 'Bank transfer confirmed' });
  flash(req, 'success', 'Payment confirmed. The buyer can now download.');
  res.redirect(req.body.back || '/admin/orders');
});

router.post('/orders/:id/reject', (req, res) => {
  db.prepare("UPDATE orders SET status = 'rejected', admin_note = ? WHERE id = ? AND status != 'paid'")
    .run((req.body.note || '').trim() || 'Payment could not be verified', Number(req.params.id));
  flash(req, 'info', 'Order marked as rejected. The buyer will see your note and can re-upload a receipt.');
  res.redirect(req.body.back || '/admin/orders');
});

router.post('/orders/:id/verify-opay', async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  try {
    const r = await opay.queryStatus(o.reference);
    if (r.status === 'SUCCESS') { markPaid(o.id, { opayOrderNo: r.orderNo, note: 'Verified with OPay by admin' }); flash(req, 'success', 'OPay says SUCCESS — order unlocked.'); }
    else flash(req, 'info', `OPay status: ${r.status}`);
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(`/admin/orders/${o.id}`);
});

router.get('/items/:id/download', async (req, res, next) => {
  try {
    const it = db.prepare('SELECT oi.*, p.slug, o.status FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?').get(Number(req.params.id));
    if (!it || it.status !== 'paid') return res.redirect('/admin/orders');
    const { file } = await buildDelivery(it.id);
    res.download(file, `${it.slug}.zip`);
  } catch (e) { next(e); }
});

router.post('/items/:id/reset', (req, res) => {
  const it = db.prepare('SELECT order_id FROM order_items WHERE id = ?').get(Number(req.params.id));
  db.prepare('UPDATE order_items SET download_count = 0 WHERE id = ?').run(Number(req.params.id));
  flash(req, 'success', 'Download count reset.');
  res.redirect(`/admin/orders/${it.order_id}`);
});

router.get('/proof/:file', (req, res) => {
  const full = path.join(DIRS.proofs, path.basename(req.params.file));
  if (!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

// Grant a product to a user manually (e.g. paid in cash)
router.post('/grant', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.body.user_id));
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.body.product_id));
  if (!u || !p) { flash(req, 'error', 'Choose a customer and a product.'); return res.redirect('/admin/users'); }
  const { makeReference } = require('../util');
  const info = db.prepare("INSERT INTO orders (reference, user_id, total_kobo, method) VALUES (?, ?, ?, 'bank')").run(makeReference(), u.id, p.price_kobo);
  db.prepare('INSERT INTO order_items (order_id, product_id, price_kobo) VALUES (?, ?, ?)').run(info.lastInsertRowid, p.id, p.price_kobo);
  markPaid(info.lastInsertRowid, { note: (req.body.note || '').trim() || 'Granted by admin' });
  flash(req, 'success', `"${p.title}" added to ${u.full_name}'s library.`);
  res.redirect(`/admin/users/${u.id}`);
});

// ---------- Customers ----------
router.get('/users', (req, res) => {
  const q = (req.query.q || '').trim();
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status='paid') orders,
    (SELECT COALESCE(SUM(total_kobo),0) FROM orders o WHERE o.user_id = u.id AND o.status='paid') spent
    FROM users u WHERE (? = '' OR u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?) ORDER BY u.id DESC LIMIT 500`)
    .all(q, `%${q}%`, `%${q}%`, `%${q}%`);
  res.render('admin/users', { title: 'Customers', users, q });
});

router.get('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return res.redirect('/admin/users');
  const orders = db.prepare(`SELECT o.*, (SELECT GROUP_CONCAT(p.title, ' • ') FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id) titles
    FROM orders o WHERE o.user_id = ? ORDER BY o.id DESC`).all(u.id);
  const products = db.prepare('SELECT id, title FROM products ORDER BY title').all();
  res.render('admin/user', { title: u.full_name, u, orders, products });
});

router.post('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return res.redirect('/admin/users');
  const name = (req.body.full_name || u.full_name).trim();
  db.prepare('UPDATE users SET full_name = ?, phone = ?, is_blocked = ?, is_admin = ? WHERE id = ?').run(
    name, (req.body.phone || '').trim(), req.body.is_blocked ? 1 : 0, u.id === req.user.id ? 1 : (req.body.is_admin ? 1 : 0), u.id);
  if (req.body.new_password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.new_password, 10), u.id);
  if (name !== u.full_name) {
    const rows = db.prepare(`SELECT oi.id, oi.delivery_file FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? AND oi.delivery_file IS NOT NULL`).all(u.id);
    for (const r of rows) fs.promises.unlink(path.join(DIRS.deliveries, r.delivery_file)).catch(() => {});
    db.prepare(`UPDATE order_items SET delivery_file = NULL WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)`).run(u.id);
  }
  flash(req, 'success', 'Customer updated.');
  res.redirect(`/admin/users/${u.id}`);
});

// ---------- Settings ----------
const brandUpload = upload.single('watermark_logo');
router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'Settings', opayReady: opay.configured(), opayMode: process.env.OPAY_MODE === 'live' ? 'live' : 'sandbox',
    categories: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) n FROM categories c ORDER BY name').all() });
});

router.post('/settings', brandUpload, async (req, res, next) => {
  try {
    const before = getSettings();
    const keys = ['store_name', 'store_tagline', 'support_phone', 'support_whatsapp', 'support_email', 'bank_name', 'bank_account_name',
      'bank_account_number', 'bank_instructions', 'watermark_header', 'watermark_footer', 'watermark_opacity', 'watermark_logo_size',
      'download_limit', 'about_text'];
    for (const k of keys) if (k in req.body) setSetting(k, (req.body[k] || '').trim());
    for (const k of ['opay_enabled', 'bank_enabled', 'allow_print']) setSetting(k, req.body[k] ? '1' : '0');
    if (req.file) {
      if (!/\.(png|jpe?g|webp)$/i.test(req.file.originalname)) {
        fs.promises.unlink(req.file.path).catch(() => {});
        flash(req, 'error', 'Logo must be a PNG, JPG or WEBP image (transparent PNG works best).');
      } else {
        const name = `logo_${Date.now()}.png`;
        await sharp(req.file.path).resize({ width: 1200, withoutEnlargement: true }).png().toFile(path.join(DIRS.branding, name));
        fs.promises.unlink(req.file.path).catch(() => {});
        if (before.watermark_logo) fs.promises.unlink(path.join(DIRS.branding, before.watermark_logo)).catch(() => {});
        setSetting('watermark_logo', name);
      }
    }
    if (req.body.remove_logo) setSetting('watermark_logo', '');
    const after = getSettings();
    const wmKeys = ['watermark_header', 'watermark_footer', 'watermark_opacity', 'watermark_logo_size', 'watermark_logo', 'allow_print', 'store_name'];
    if (wmKeys.some(k => before[k] !== after[k])) clearDeliveries();
    flash(req, 'success', 'Settings saved.');
    res.redirect('/admin/settings');
  } catch (e) { next(e); }
});

router.post('/categories/:id/delete', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  res.redirect('/admin/settings#categories');
});

module.exports = router;
