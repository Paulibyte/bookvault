const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { DIRS } = require('../util');
const { ownedProductIds, refreshRating } = require('../orders');
const { flash, requireLogin } = require('../middleware');

const router = express.Router();

// Only approved, visible products appear in the store
const LIVE = "p.is_active = 1 AND p.status = 'published'";

// Weighted ranking: sales count most, then ratings (Bayesian-smoothed so 1 five-star review doesn't win)
const SCORE = '(p.sales_count * 3 + ((p.rating_avg * p.rating_count + 3.5 * 3) / (p.rating_count + 3)) * p.rating_count)';
const SORTS = {
  popular: `${SCORE} DESC, p.created_at DESC`,
  bestselling: 'p.sales_count DESC, p.created_at DESC',
  rating: '((p.rating_avg * p.rating_count + 3.5 * 3) / (p.rating_count + 3)) DESC, p.rating_count DESC',
  newest: 'p.created_at DESC',
  price_low: 'p.price_kobo ASC',
  price_high: 'p.price_kobo DESC',
};

const PRODUCT_COLS = `p.*, c.name AS category, a.pen_name AS author_name, a.id AS author_ref`;
const PRODUCT_JOIN = `FROM products p LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN authors a ON a.id = p.author_id AND a.status = 'verified'`;

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const cat = Number(req.query.cat) || null;
  const kind = req.query.kind === 'software' ? 'software' : 'book';
  const type = ['pdf', 'docx', 'zip'].includes(req.query.type) ? req.query.type : null;
  const sort = SORTS[req.query.sort] ? req.query.sort : 'popular';
  const where = [LIVE, 'p.kind = ?'];
  const params = [kind];
  if (q) { where.push('(p.title LIKE ? OR p.author LIKE ? OR p.description LIKE ? OR a.pen_name LIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
  if (cat) { where.push('p.category_id = ?'); params.push(cat); }
  if (type) { where.push('p.file_type = ?'); params.push(type); }
  const products = db.prepare(`SELECT ${PRODUCT_COLS} ${PRODUCT_JOIN} WHERE ${where.join(' AND ')} ORDER BY ${SORTS[sort]}`).all(...params);
  const categories = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND ${LIVE} AND p.kind = ?) n
    FROM categories c ORDER BY c.name`).all(kind).filter(c => c.n > 0);
  // Top-3 bestsellers get a rank badge (only on the unfiltered popular view)
  const ranks = new Map();
  if (!q && !cat && !type) {
    db.prepare(`SELECT p.id FROM products p WHERE ${LIVE} AND p.kind = ? AND p.sales_count > 0 ORDER BY ${SCORE} DESC LIMIT 3`)
      .all(kind).forEach((r, i) => ranks.set(r.id, i + 1));
  }
  const owned = req.user ? ownedProductIds(req.user.id) : new Set();
  const cart = new Set(req.session.cart || []);
  res.render('home', { title: kind === 'software' ? 'Apps & Software' : null, products, categories, q, cat, type, sort, kind, kindTab: kind === 'software' ? 'software' : null, owned, cart, ranks });
});

router.get('/book/:slug', (req, res) => {
  const p = db.prepare(`SELECT ${PRODUCT_COLS} ${PRODUCT_JOIN} WHERE p.slug = ? AND ${LIVE}`).get(req.params.slug);
  if (!p) return res.status(404).render('error', { title: 'Not found', message: 'This item is not available.' });
  const owned = req.user ? ownedProductIds(req.user.id).has(p.id) : false;
  const inCart = (req.session.cart || []).includes(p.id);
  const related = db.prepare(`SELECT ${PRODUCT_COLS} ${PRODUCT_JOIN} WHERE ${LIVE} AND p.id != ? AND p.kind = ?
    AND (p.category_id IS ? OR p.author_id IS ?) ORDER BY ${SCORE} DESC LIMIT 4`).all(p.id, p.kind, p.category_id, p.author_id);
  const reviews = db.prepare(`SELECT r.*, u.full_name FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ? AND r.is_hidden = 0 ORDER BY r.updated_at DESC LIMIT 50`).all(p.id);
  const myReview = req.user ? db.prepare('SELECT * FROM reviews WHERE product_id = ? AND user_id = ?').get(p.id, req.user.id) : null;
  const dist = [5, 4, 3, 2, 1].map(n => ({ n, c: reviews.filter(r => r.rating === n).length }));
  res.render('product', { title: p.title, p, owned, inCart, related, reviews, myReview, dist, kindTab: p.kind === 'software' ? 'software' : null });
});

router.post('/book/:slug/review', requireLogin, (req, res) => {
  const p = db.prepare(`SELECT p.* FROM products p WHERE p.slug = ? AND ${LIVE}`).get(req.params.slug);
  if (!p) return res.redirect('/');
  if (!ownedProductIds(req.user.id).has(p.id)) {
    flash(req, 'error', 'Only buyers can rate this item.');
    return res.redirect(`/book/${p.slug}#reviews`);
  }
  const rating = Math.round(Number(req.body.rating));
  if (!(rating >= 1 && rating <= 5)) { flash(req, 'error', 'Choose a star rating.'); return res.redirect(`/book/${p.slug}#reviews`); }
  const body = (req.body.body || '').trim().slice(0, 2000);
  db.prepare(`INSERT INTO reviews (product_id, user_id, rating, body) VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, updated_at = datetime('now')`)
    .run(p.id, req.user.id, rating, body);
  refreshRating(p.id);
  flash(req, 'success', 'Thanks for your review!');
  res.redirect(`/book/${p.slug}#reviews`);
});

router.get('/authors/:id', (req, res) => {
  const a = db.prepare("SELECT * FROM authors WHERE id = ? AND status = 'verified'").get(Number(req.params.id));
  if (!a) return res.status(404).render('error', { title: 'Not found', message: 'Author not found.' });
  const products = db.prepare(`SELECT ${PRODUCT_COLS} ${PRODUCT_JOIN} WHERE ${LIVE} AND p.author_id = ? ORDER BY ${SCORE} DESC`).all(a.id);
  const owned = req.user ? ownedProductIds(req.user.id) : new Set();
  res.render('author-public', { title: a.pen_name, a, products, owned, cart: new Set(req.session.cart || []), ranks: new Map() });
});

router.get('/cover/:file', (req, res) => {
  const f = path.basename(req.params.file);
  const full = path.join(DIRS.covers, f);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(full);
});

router.get('/avatar/:file', (req, res) => {
  const full = path.join(DIRS.authors, path.basename(req.params.file));
  if (!/^photo_/.test(path.basename(full)) || !fs.existsSync(full)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(full);
});

router.get('/brand/:file', (req, res) => {
  const full = path.join(DIRS.branding, path.basename(req.params.file));
  if (!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

router.get('/manifest.webmanifest', (req, res) => {
  const s = res.locals.settings;
  res.type('application/manifest+json').send(JSON.stringify({
    id: '/', name: s.store_name, short_name: s.store_name.slice(0, 12), description: s.store_tagline,
    start_url: '/', scope: '/', display: 'standalone', orientation: 'any',
    background_color: '#ffffff', theme_color: '#0b1b4f',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'My Library', url: '/library', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Saved books', url: '/offline', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  }));
});

router.get('/offline', (req, res) => res.render('offline', { title: 'Saved books' }));
router.get('/how-it-works', (req, res) => res.render('how', { title: 'How it works' }));

module.exports = router;
