const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { DIRS } = require('../util');
const { ownedProductIds } = require('../orders');

const router = express.Router();

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const cat = Number(req.query.cat) || null;
  const type = ['pdf', 'docx', 'zip', 'other'].includes(req.query.type) ? req.query.type : null;
  const where = ['p.is_active = 1'];
  const params = [];
  if (q) { where.push('(p.title LIKE ? OR p.author LIKE ? OR p.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (cat) { where.push('p.category_id = ?'); params.push(cat); }
  if (type) { where.push('p.file_type = ?'); params.push(type); }
  const products = db.prepare(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC`).all(...params);
  const categories = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) n
    FROM categories c ORDER BY c.name`).all().filter(c => c.n > 0);
  const owned = req.user ? ownedProductIds(req.user.id) : new Set();
  const cart = new Set(req.session.cart || []);
  res.render('home', { title: null, products, categories, q, cat, type, owned, cart });
});

router.get('/book/:slug', (req, res) => {
  const p = db.prepare(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.slug = ? AND p.is_active = 1`).get(req.params.slug);
  if (!p) return res.status(404).render('error', { title: 'Not found', message: 'This item is no longer available.' });
  const owned = req.user ? ownedProductIds(req.user.id).has(p.id) : false;
  const inCart = (req.session.cart || []).includes(p.id);
  const related = db.prepare(`SELECT * FROM products WHERE is_active = 1 AND id != ? AND (category_id IS ? OR ? IS NULL)
    ORDER BY RANDOM() LIMIT 4`).all(p.id, p.category_id, p.category_id);
  res.render('product', { title: p.title, p, owned, inCart, related });
});

router.get('/cover/:file', (req, res) => {
  const f = path.basename(req.params.file);
  const full = path.join(DIRS.covers, f);
  if (!fs.existsSync(full)) return res.status(404).end();
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
    name: s.store_name, short_name: s.store_name.slice(0, 12), start_url: '/', display: 'standalone',
    background_color: '#f7f3ea', theme_color: '#16213a', description: s.store_tagline,
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
  }));
});

router.get('/how-it-works', (req, res) => res.render('how', { title: 'How it works' }));

module.exports = router;
