require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const helmet = require('helmet');
const crypto = require('crypto');

const { db } = require('./src/db');
const { DIRS } = require('./src/util');
const { locals, csrf } = require('./src/middleware');

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const app = express();
const PORT = Number(process.env.PORT) || 3050;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:'],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'form-action': ["'self'", 'https://*.opaycheckout.com'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// OPay webhook needs the raw JSON body
app.use('/payments/opay/webhook', express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET not set — sessions will reset on every restart.');

app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
  secret,
  resave: false,
  saveUninitialized: false,
  name: 'bv.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

app.use(locals);
app.use(csrf);

app.use('/', require('./src/routes/public'));
app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/shop'));
app.use('/payments', require('./src/routes/payments'));
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).render('error', { title: 'File too large', message: 'The file you uploaded is larger than the allowed size.' });
  }
  res.status(500).render('error', { title: 'Something went wrong', message: process.env.NODE_ENV === 'production' ? 'Please try again shortly.' : err.message });
});

app.listen(PORT, () => console.log(`BookVault running on http://localhost:${PORT}`));
