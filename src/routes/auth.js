const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash, rateLimit, requireLogin } = require('../middleware');

const router = express.Router();

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/library';
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/library');
  res.render('register', { title: 'Create account', form: {}, next: req.query.next || '' });
});

router.post('/register', rateLimit(10, 10 * 60 * 1000), (req, res) => {
  const full_name = (req.body.full_name || '').trim().replace(/\s+/g, ' ');
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim();
  const password = req.body.password || '';
  const errors = [];
  if (full_name.length < 3) errors.push('Enter your full name — it is printed on every page of the books you buy.');
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.push('Enter a valid email address.');
  if (!/^[0-9+\s-]{7,20}$/.test(phone)) errors.push('Enter a valid phone number.');
  if (password.length < 6) errors.push('Password must be at least 6 characters.');
  if (password !== req.body.password2) errors.push('Passwords do not match.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) errors.push('An account with that email already exists. Log in instead.');
  if (errors.length) {
    errors.forEach(e => flash(req, 'error', e));
    res.locals.flash = req.session.flash; delete req.session.flash;
    return res.render('register', { title: 'Create account', form: { full_name, email, phone }, next: req.body.next || '' });
  }
  const isFirst = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const info = db.prepare('INSERT INTO users (full_name, email, phone, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)')
    .run(full_name, email, phone, bcrypt.hashSync(password, 10), isFirst ? 1 : 0);
  req.session.regenerate(() => {
    req.session.userId = info.lastInsertRowid;
    flash(req, 'success', isFirst ? 'Welcome! As the first account, you are the store administrator.' : `Welcome, ${full_name.split(' ')[0]}!`);
    res.redirect(isFirst ? '/admin' : safeNext(req.body.next));
  });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/library');
  res.render('login', { title: 'Log in', next: req.query.next || '', email: '' });
});

router.post('/login', rateLimit(15, 10 * 60 * 1000), (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password_hash)) {
    flash(req, 'error', 'Wrong email or password.');
    res.locals.flash = req.session.flash; delete req.session.flash;
    return res.render('login', { title: 'Log in', next: req.body.next || '', email });
  }
  if (u.is_blocked) {
    flash(req, 'error', 'This account has been suspended. Contact the store.');
    return res.redirect('/login');
  }
  const cart = req.session.cart;
  req.session.regenerate(() => {
    req.session.userId = u.id;
    req.session.cart = cart;
    res.redirect(u.is_admin && !req.body.next ? '/admin' : safeNext(req.body.next));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/account', requireLogin, (req, res) => {
  res.render('account', { title: 'My account' });
});

router.post('/account', requireLogin, (req, res) => {
  const phone = (req.body.phone || '').trim();
  if (phone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.id);
  if (req.body.new_password) {
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(req.body.current_password || '', u.password_hash)) {
      flash(req, 'error', 'Current password is wrong.');
      return res.redirect('/account');
    }
    if (req.body.new_password.length < 6) { flash(req, 'error', 'New password must be at least 6 characters.'); return res.redirect('/account'); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.new_password, 10), req.user.id);
  }
  flash(req, 'success', 'Account updated.');
  res.redirect('/account');
});

module.exports = router;
