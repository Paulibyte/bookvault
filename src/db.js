const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'store.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  author TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT,
  price_kobo INTEGER NOT NULL DEFAULT 0,
  cover_file TEXT,
  stored_file TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_type TEXT NOT NULL,          -- pdf | docx | zip | other
  file_size INTEGER NOT NULL DEFAULT 0,
  pages INTEGER,
  protect INTEGER NOT NULL DEFAULT 1, -- watermark + password (pdf/docx only)
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_kobo INTEGER NOT NULL,
  method TEXT NOT NULL,             -- bank | opay
  status TEXT NOT NULL DEFAULT 'pending', -- pending | awaiting_confirmation | paid | rejected | cancelled
  bank_sender_name TEXT,
  bank_proof_file TEXT,
  bank_note TEXT,
  opay_order_no TEXT,
  admin_note TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price_kobo INTEGER NOT NULL,
  file_password TEXT,
  delivery_file TEXT,
  download_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

const DEFAULT_SETTINGS = {
  store_name: 'BookVault',
  store_tagline: 'Textbooks, lecture notes and course files — delivered instantly.',
  support_phone: '',
  support_whatsapp: '',
  support_email: '',
  bank_name: '',
  bank_account_name: '',
  bank_account_number: '',
  bank_instructions: 'Transfer the exact total, then upload your receipt below. Your downloads unlock as soon as we confirm the payment.',
  opay_enabled: '0',
  bank_enabled: '1',
  watermark_header: 'Licensed to {name} | {email} | {phone}',
  watermark_footer: '{store} | Order {order} | {date} | Sharing this copy is prohibited',
  watermark_logo: '',
  watermark_opacity: '0.12',
  watermark_logo_size: '45',
  download_limit: '5',
  allow_print: '1',
  about_text: '',
};

const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}

module.exports = { db, getSettings, setSetting, DATA_DIR };
