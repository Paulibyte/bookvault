const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, getSettings } = require('../db');
const { DIRS, makeReference, safeName } = require('../util');
const { flash, requireLogin } = require('../middleware');
const { ownedProductIds } = require('../orders');
const { buildDelivery, buildReaderFile, isReadable } = require('../deliver');
const opay = require('../opay');

const router = express.Router();

const proofUpload = multer({
  storage: multer.diskStorage({
    destination: DIRS.proofs,
    filename: (req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(jpe?g|png|webp|pdf)$/i.test(file.originalname)),
});

function cartProducts(req) {
  const ids = (req.session.cart || []).filter(Number.isInteger);
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM products WHERE is_active = 1 AND status = 'published' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

// ---------- Cart ----------
router.get('/cart', (req, res) => {
  let items = cartProducts(req);
  if (req.user) {
    const owned = ownedProductIds(req.user.id);
    const before = items.length;
    items = items.filter(p => !owned.has(p.id));
    if (items.length < before) flash(req, 'info', 'Items you already own were removed from your cart.');
  }
  req.session.cart = items.map(p => p.id);
  const total = items.reduce((s, p) => s + p.price_kobo, 0);
  res.render('cart', { title: 'Your cart', items, total, opayReady: opay.configured() });
});

router.post('/cart/add/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare("SELECT id, title, slug FROM products WHERE id = ? AND is_active = 1 AND status = 'published'").get(id);
  if (!p) return res.redirect('/');
  req.session.cart = req.session.cart || [];
  if (!req.session.cart.includes(id)) req.session.cart.push(id);
  if (req.body.buy_now) return res.redirect('/cart');
  flash(req, 'success', `"${p.title}" added to cart.`);
  res.redirect(req.get('referer') && req.get('referer').includes(req.get('host')) ? req.get('referer') : '/cart');
});

router.post('/cart/remove/:id', (req, res) => {
  req.session.cart = (req.session.cart || []).filter(x => x !== Number(req.params.id));
  res.redirect('/cart');
});

// ---------- Checkout ----------
router.post('/checkout', requireLogin, (req, res, next) => {
  const settings = getSettings();
  const method = req.body.method === 'opay' ? 'opay' : 'bank';
  if (method === 'opay' && !(settings.opay_enabled === '1' && opay.configured())) {
    flash(req, 'error', 'Card/OPay payment is not available right now. Please use bank transfer.');
    return res.redirect('/cart');
  }
  if (method === 'bank' && settings.bank_enabled !== '1') {
    flash(req, 'error', 'Bank transfer is not available right now.');
    return res.redirect('/cart');
  }
  const owned = ownedProductIds(req.user.id);
  const items = cartProducts(req).filter(p => !owned.has(p.id));
  if (!items.length) { flash(req, 'error', 'Your cart is empty.'); return res.redirect('/cart'); }
  const total = items.reduce((s, p) => s + p.price_kobo, 0);

  const reference = makeReference();
  const orderId = db.transaction(() => {
    const info = db.prepare('INSERT INTO orders (reference, user_id, total_kobo, method) VALUES (?, ?, ?, ?)')
      .run(reference, req.user.id, total, method);
    const ins = db.prepare('INSERT INTO order_items (order_id, product_id, price_kobo) VALUES (?, ?, ?)');
    for (const p of items) ins.run(info.lastInsertRowid, p.id, p.price_kobo);
    return info.lastInsertRowid;
  })();
  req.session.cart = [];

  // Free items: unlock immediately
  if (total === 0) {
    require('../orders').markPaid(orderId, { note: 'Free item' });
    flash(req, 'success', 'Done! Your free items are in your library.');
    return res.redirect('/library');
  }
  if (method === 'opay') return res.redirect(`/payments/opay/start/${reference}`);
  res.redirect(`/order/${reference}`);
});

// ---------- Orders ----------
function loadOrder(req, res) {
  const o = db.prepare('SELECT * FROM orders WHERE reference = ?').get(req.params.ref);
  if (!o || (o.user_id !== req.user.id && !req.user.is_admin)) {
    res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
    return null;
  }
  o.items = db.prepare(`SELECT oi.*, p.title, p.slug, p.cover_file, p.file_type FROM order_items oi
    JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(o.id);
  return o;
}

router.get('/order/:ref', requireLogin, (req, res) => {
  const o = loadOrder(req, res);
  if (!o) return;
  res.render('order', { title: `Order ${o.reference}`, o, opayReady: opay.configured() });
});

router.post('/order/:ref/proof', requireLogin, proofUpload.single('proof'), (req, res) => {
  const o = loadOrder(req, res);
  if (!o) return;
  if (!['pending', 'awaiting_confirmation', 'rejected'].includes(o.status) || o.method !== 'bank') {
    flash(req, 'error', 'This order can no longer be updated.');
    return res.redirect(`/order/${o.reference}`);
  }
  const sender = (req.body.sender_name || '').trim();
  if (!sender) { flash(req, 'error', 'Enter the name on the account you paid from.'); return res.redirect(`/order/${o.reference}`); }
  if (!req.file && !o.bank_proof_file) { flash(req, 'error', 'Upload a screenshot or PDF of your transfer receipt.'); return res.redirect(`/order/${o.reference}`); }
  db.prepare(`UPDATE orders SET status = 'awaiting_confirmation', bank_sender_name = ?, bank_note = ?,
    bank_proof_file = COALESCE(?, bank_proof_file) WHERE id = ?`)
    .run(sender, (req.body.note || '').trim().slice(0, 500), req.file ? req.file.filename : null, o.id);
  flash(req, 'success', 'Receipt received. We will confirm your payment shortly — your downloads will appear in My Library.');
  res.redirect(`/order/${o.reference}`);
});

router.post('/order/:ref/cancel', requireLogin, (req, res) => {
  const o = loadOrder(req, res);
  if (!o) return;
  if (o.status === 'pending') db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
  res.redirect('/orders');
});

router.get('/orders', requireLogin, (req, res) => {
  const orders = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) n,
    (SELECT GROUP_CONCAT(p.title, ' • ') FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id) titles
    FROM orders o WHERE user_id = ? ORDER BY o.id DESC`).all(req.user.id);
  res.render('orders', { title: 'My orders', orders });
});

// ---------- Library & downloads ----------
router.get('/library', requireLogin, (req, res) => {
  const items = db.prepare(`SELECT oi.*, o.reference, o.paid_at, p.title, p.slug, p.cover_file, p.file_type, p.protect, p.author,
      p.kind, p.platform, p.version, p.reader_pdf
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
    WHERE o.user_id = ? AND o.status = 'paid' ORDER BY o.paid_at DESC`).all(req.user.id);
  const pending = db.prepare(`SELECT COUNT(*) c FROM orders WHERE user_id = ? AND status IN ('pending','awaiting_confirmation')`).get(req.user.id).c;
  items.forEach(it => { it.readable = isReadable(it); });
  const tab = req.query.tab === 'software' ? 'software' : 'book';
  res.render('library', { title: 'My library', items, tab, pending, limit: Number(getSettings().download_limit) || 0 });
});

router.get('/download/:itemId', requireLogin, async (req, res, next) => {
  try {
    const it = db.prepare(`SELECT oi.*, o.user_id, o.status, o.reference, p.title FROM order_items oi
      JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id WHERE oi.id = ?`).get(Number(req.params.itemId));
    if (!it || it.user_id !== req.user.id || it.status !== 'paid') {
      return res.status(404).render('error', { title: 'Not available', message: 'This download is not available on your account.' });
    }
    const limit = Number(getSettings().download_limit) || 0;
    if (limit && it.download_count >= limit) {
      return res.status(403).render('error', { title: 'Download limit reached', message: `You have downloaded this item ${it.download_count} times. Contact the store if you need it re-enabled.` });
    }
    const { file } = await buildDelivery(it.id);
    db.prepare('UPDATE order_items SET download_count = download_count + 1 WHERE id = ?').run(it.id);
    db.prepare('INSERT INTO downloads (order_item_id, user_id, ip, user_agent) VALUES (?, ?, ?, ?)')
      .run(it.id, req.user.id, req.ip, (req.get('user-agent') || '').slice(0, 250));
    res.download(file, `${safeName(it.title)}.zip`);
  } catch (e) { next(e); }
});

// ---------- In-app reader ----------
function readableItem(req) {
  const it = db.prepare(`SELECT oi.*, o.user_id, o.status, o.reference, p.title, p.cover_file, p.file_type, p.kind, p.reader_pdf
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id WHERE oi.id = ?`).get(Number(req.params.itemId));
  if (!it || it.user_id !== req.user.id || it.status !== 'paid' || !isReadable(it)) return null;
  return it;
}

router.get('/read/:itemId', requireLogin, (req, res) => {
  const it = readableItem(req);
  if (!it) return res.status(404).render('error', { title: 'Not available', message: 'This book cannot be opened in the reader.' });
  res.set('Cache-Control', 'private, no-store');
  res.render('reader', { it });
});

router.get('/read/:itemId/file', requireLogin, async (req, res, next) => {
  try {
    const it = readableItem(req);
    if (!it) return res.status(404).end();
    const { file } = await buildReaderFile(it.id);
    res.set('Cache-Control', 'private, no-transform');
    res.type('application/pdf');
    res.sendFile(file);
  } catch (e) { next(e); }
});

module.exports = router;
