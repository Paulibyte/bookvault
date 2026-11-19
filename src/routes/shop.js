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
const shipping = require('../shipping');

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
  return db.prepare(`SELECT p.*, COALESCE(p.ship_from_state, a.ship_state) AS ship_from_state, COALESCE(p.ship_from_city, a.ship_city) AS ship_from_city
    FROM products p LEFT JOIN authors a ON a.id = p.author_id
    WHERE p.is_active = 1 AND p.status = 'published' AND p.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

function savedAddress(user) {
  const u = db.prepare('SELECT ship_json FROM users WHERE id = ?').get(user.id);
  try { return { ship_name: user.full_name, ship_phone: user.phone, ...JSON.parse(u.ship_json || '{}') }; }
  catch { return { ship_name: user.full_name, ship_phone: user.phone }; }
}

// ---------- Cart ----------
router.get('/cart', (req, res) => {
  let items = cartProducts(req);
  if (req.user) {
    const owned = ownedProductIds(req.user.id, { includePrint: false });
    const before = items.length;
    items = items.filter(p => !owned.has(p.id));
    if (items.length < before) flash(req, 'info', 'Digital items you already own were removed from your cart.');
  }
  const sold = items.filter(p => p.format === 'print' && !(p.stock > 0));
  if (sold.length) {
    flash(req, 'error', `Sorry, ${sold.map(p => '"' + p.title + '"').join(', ')} sold out and was removed from your cart.`);
    items = items.filter(p => !sold.includes(p));
  }
  req.session.cart = items.map(p => p.id);
  const subtotal = items.reduce((s, p) => s + p.price_kobo, 0);
  const printItems = items.filter(p => p.format === 'print');
  const settings = getSettings();
  const shipOn = settings.shipping_enabled === '1';
  const addr = req.user ? { ...savedAddress(req.user), ...(req.session.shipForm || {}) } : {};
  const q = printItems.length && addr.ship_state ? shipping.quote(printItems, addr.ship_state) : null;
  // show messages raised on this request right away
  if (req.session.flash) { res.locals.flash = res.locals.flash.concat(req.session.flash); delete req.session.flash; }
  res.render('cart', { title: 'Your cart', items, total: subtotal, subtotal, printItems, shipOn, addr, quote: q,
    states: shipping.STATES, stateLabel: shipping.stateLabel, rates: shipping.rates(), opayReady: opay.configured() });
});

// Live delivery prices for the printed books in the cart
router.get('/cart/quote', (req, res) => {
  const state = shipping.STATES.includes(req.query.state) ? req.query.state : null;
  const printItems = cartProducts(req).filter(p => p.format === 'print');
  if (!state || !printItems.length) return res.json({ options: {} });
  const q = shipping.quote(printItems, state);
  res.json({ parcels: q.parcels.length, options: q.options });
});

router.post('/cart/add/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare("SELECT id, title, slug, format, stock FROM products WHERE id = ? AND is_active = 1 AND status = 'published'").get(id);
  if (!p) return res.redirect('/');
  if (p.format === 'print' && !(p.stock > 0)) { flash(req, 'error', `"${p.title}" is out of stock.`); return res.redirect(`/book/${p.slug}`); }
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
  const b = req.body;
  const method = b.method === 'opay' ? 'opay' : 'bank';
  if (method === 'opay' && !(settings.opay_enabled === '1' && opay.configured())) {
    flash(req, 'error', 'Card/OPay payment is not available right now. Please use bank transfer.');
    return res.redirect('/cart');
  }
  if (method === 'bank' && settings.bank_enabled !== '1') {
    flash(req, 'error', 'Bank transfer is not available right now.');
    return res.redirect('/cart');
  }
  const owned = ownedProductIds(req.user.id, { includePrint: false });
  const items = cartProducts(req).filter(p => !owned.has(p.id));
  if (!items.length) { flash(req, 'error', 'Your cart is empty.'); return res.redirect('/cart'); }
  const subtotal = items.reduce((s, p) => s + p.price_kobo, 0);

  // ----- Printed books: address, delivery method, stock -----
  const printItems = items.filter(p => p.format === 'print');
  let ship = null, q = null;
  if (printItems.length) {
    if (settings.shipping_enabled !== '1') { flash(req, 'error', 'Delivery of printed books is paused right now.'); return res.redirect('/cart'); }
    const out = printItems.filter(p => !(p.stock > 0));
    if (out.length) { flash(req, 'error', `Sorry, ${out.map(p => '"' + p.title + '"').join(', ')} just went out of stock.`); return res.redirect('/cart'); }
    ship = {
      ship_name: (b.ship_name || '').trim(), ship_phone: (b.ship_phone || '').trim(), ship_address: (b.ship_address || '').trim(),
      ship_city: (b.ship_city || '').trim(), ship_state: shipping.STATES.includes(b.ship_state) ? b.ship_state : '', ship_landmark: (b.ship_landmark || '').trim(),
    };
    const errs = [];
    if (!ship.ship_name) errs.push('Enter the receiver\'s name.');
    if (!/^[0-9+\s-]{7,20}$/.test(ship.ship_phone)) errs.push('Enter the receiver\'s phone number.');
    if (!ship.ship_state) errs.push('Choose the delivery state.');
    if (!ship.ship_city) errs.push('Enter the town or city.');
    q = ship.ship_state ? shipping.quote(printItems, ship.ship_state) : null;
    const opt = q && q.options[b.ship_method];
    if (!opt) errs.push('Choose a delivery option.');
    if (b.ship_method === 'doorstep' && ship.ship_address.length < 8) errs.push('Enter the full delivery address for doorstep delivery.');
    if (errs.length) { errs.forEach(e => flash(req, 'error', e)); req.session.shipForm = { ...ship, ship_method: b.ship_method }; return res.redirect('/cart#delivery'); }
    ship.ship_method = b.ship_method;
    ship.fee = opt.total;
    db.prepare('UPDATE users SET ship_json = ? WHERE id = ?').run(JSON.stringify({ ...ship, fee: undefined }), req.user.id);
  }
  const shippingKobo = ship ? ship.fee : 0;
  const total = subtotal + shippingKobo;

  const reference = makeReference();
  const orderId = db.transaction(() => {
    const info = db.prepare(`INSERT INTO orders (reference, user_id, total_kobo, method, shipping_kobo, ship_name, ship_phone, ship_address, ship_city, ship_state, ship_landmark, ship_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reference, req.user.id, total, method, shippingKobo, ship && ship.ship_name, ship && ship.ship_phone, ship && ship.ship_address,
        ship && ship.ship_city, ship && ship.ship_state, ship && ship.ship_landmark, ship && ship.ship_method);
    const oid = info.lastInsertRowid;
    const shipmentOf = new Map();
    if (ship) {
      const insSh = db.prepare(`INSERT INTO shipments (order_id, author_id, origin_state, origin_city, method, zone, weight_kg, fee_kobo, author_shipping_kobo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const g of q.parcels) {
        const line = q.options[ship.ship_method].parcels.find(l => l.key === g.key);
        const r = insSh.run(oid, g.author_id, g.origin_state, g.origin_city, ship.ship_method, line.zone, g.weight, line.fee, g.author_id ? line.fee : 0);
        for (const it of g.items) shipmentOf.set(it.id, r.lastInsertRowid);
      }
    }
    const ins = db.prepare('INSERT INTO order_items (order_id, product_id, price_kobo, shipment_id) VALUES (?, ?, ?, ?)');
    for (const p of items) ins.run(oid, p.id, p.price_kobo, shipmentOf.get(p.id) || null);
    return oid;
  })();
  req.session.cart = [];
  delete req.session.shipForm;

  // Free digital items: unlock immediately
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
  o.items = db.prepare(`SELECT oi.*, p.title, p.slug, p.cover_file, p.file_type, p.format, p.kind FROM order_items oi
    JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(o.id);
  o.shipments = db.prepare(`SELECT sh.*, a.pen_name, a.phone AS seller_phone, a.pickup_address AS seller_pickup FROM shipments sh
    LEFT JOIN authors a ON a.id = sh.author_id WHERE sh.order_id = ? ORDER BY sh.id`).all(o.id);
  o.shipments.forEach(sh => { sh.items = o.items.filter(i => i.shipment_id === sh.id); });
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

router.post('/order/:ref/shipments/:id/received', requireLogin, (req, res) => {
  const o = loadOrder(req, res);
  if (!o) return;
  const sh = o.shipments.find(x => x.id === Number(req.params.id));
  try {
    if (!sh || o.user_id !== req.user.id) throw new Error('Shipment not found.');
    require('../orders').updateShipment(sh.id, { status: 'delivered' });
    flash(req, 'success', 'Thanks for confirming! Enjoy your book — you can rate it on its page.');
  } catch (e) { flash(req, 'error', e.message); }
  res.redirect(`/order/${o.reference}`);
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
    WHERE o.user_id = ? AND o.status = 'paid' AND p.format != 'print' ORDER BY o.paid_at DESC`).all(req.user.id);
  const printOrders = db.prepare(`SELECT COUNT(*) c FROM shipments sh JOIN orders o ON o.id = sh.order_id
    WHERE o.user_id = ? AND o.status = 'paid' AND sh.status IN ('processing','shipped')`).get(req.user.id).c;
  const pending = db.prepare(`SELECT COUNT(*) c FROM orders WHERE user_id = ? AND status IN ('pending','awaiting_confirmation')`).get(req.user.id).c;
  items.forEach(it => { it.readable = isReadable(it); });
  const tab = req.query.tab === 'software' ? 'software' : 'book';
  res.render('library', { title: 'My library', items, tab, printOrders, pending, limit: Number(getSettings().download_limit) || 0 });
});

router.get('/download/:itemId', requireLogin, async (req, res, next) => {
  try {
    const it = db.prepare(`SELECT oi.*, o.user_id, o.status, o.reference, p.title, p.format FROM order_items oi
      JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id WHERE oi.id = ?`).get(Number(req.params.itemId));
    if (!it || it.user_id !== req.user.id || it.status !== 'paid' || it.format === 'print') {
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
