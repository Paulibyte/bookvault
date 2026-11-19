const crypto = require('crypto');
const { db, getSettings } = require('./db');
const { naira, humanSize } = require('./util');

function locals(req, res, next) {
  res.locals.settings = getSettings();
  res.locals.naira = naira;
  res.locals.humanSize = humanSize;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  res.locals.user = null;
  if (req.session.userId) {
    const u = db.prepare('SELECT id, full_name, email, phone, is_admin, is_blocked FROM users WHERE id = ?').get(req.session.userId);
    if (u && !u.is_blocked) { req.user = u; res.locals.user = u; }
    else delete req.session.userId;
  }
  const cart = req.session.cart || [];
  res.locals.cartCount = cart.length;
  next();
}

function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}

function requireLogin(req, res, next) {
  if (!req.user) {
    flash(req, 'info', 'Please log in to continue.');
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (!req.user.is_admin) return res.status(403).render('error', { title: 'Not allowed', message: 'This area is for administrators only.' });
  next();
}

// Simple synchronizer-token CSRF protection
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    if (req.path.startsWith('/payments/opay/webhook')) return next();
    const token = (req.body && req.body._csrf) || req.get('x-csrf-token') || (req.query && req.query._csrf);
    if (token !== req.session.csrf) {
      return res.status(403).render('error', { title: 'Session expired', message: 'Your form expired. Please go back, refresh the page and try again.' });
    }
  }
  next();
}

// Tiny in-memory rate limiter for login/register
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (arr.length > max) {
      return res.status(429).render('error', { title: 'Slow down', message: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

module.exports = { locals, flash, requireLogin, requireAdmin, csrf, rateLimit };
