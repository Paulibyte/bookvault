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
  authors_enabled: '1',
  default_commission_pct: '30',
  payout_min_kobo: '500000',
  reviews_enabled: '1',
  shipping_enabled: '1',
  store_ship_state: 'Imo',
  store_ship_city: 'Owerri',
  store_pickup_address: '',
  royalty_hold_days: '14',
  shipping_rates: JSON.stringify({
    doorstep: { on: true, label: 'Doorstep delivery', same_state: 250000, same_region: 400000, nationwide: 600000, per_kg: 50000, eta: { same_state: '1–2 days', same_region: '2–4 days', nationwide: '3–7 days' } },
    park: { on: true, label: 'Bus-park pickup (waybill)', same_state: 150000, same_region: 250000, nationwide: 350000, per_kg: 30000, eta: { same_state: '1–2 days', same_region: '1–3 days', nationwide: '2–5 days' } },
    pickup: { on: true, label: 'Collect from seller', same_state: 0, same_region: null, nationwide: null, per_kg: 0, eta: { same_state: 'Arrange with seller' } },
  }),
};

// ---------- Migrations (safe to run on an existing database) ----------
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
function addColumn(table, col, def) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  pen_name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  bio TEXT,
  phone TEXT,
  address TEXT,
  institution TEXT,
  id_type TEXT,
  id_file TEXT,
  photo_file TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | verified | rejected | suspended
  review_note TEXT,
  commission_pct REAL,                          -- NULL = use store default
  bank_name TEXT,
  bank_account_number TEXT,
  bank_account_name TEXT,
  auto_payout INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  amount_kobo INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',    -- requested | paid | rejected
  trigger TEXT NOT NULL DEFAULT 'request',     -- request | auto
  bank_name TEXT, bank_account_number TEXT, bank_account_name TEXT,
  transfer_reference TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, user_id)
);
`);

addColumn('products', 'kind', "TEXT NOT NULL DEFAULT 'book'");          // book | software
addColumn('products', 'platform', 'TEXT');
addColumn('products', 'version', 'TEXT');
addColumn('products', 'author_id', 'INTEGER REFERENCES authors(id) ON DELETE SET NULL');
addColumn('products', 'status', "TEXT NOT NULL DEFAULT 'published'");   // draft | pending | published | rejected
addColumn('products', 'review_note', 'TEXT');
addColumn('products', 'copyright_json', 'TEXT');
addColumn('products', 'copyright_file', 'TEXT');
addColumn('products', 'submitted_at', 'TEXT');
addColumn('products', 'approved_at', 'TEXT');
addColumn('products', 'reader_pdf', 'TEXT');        // PDF copy of a .docx used by the in-app reader
addColumn('products', 'sales_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('products', 'rating_avg', 'REAL NOT NULL DEFAULT 0');
addColumn('products', 'rating_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('order_items', 'author_id', 'INTEGER');
addColumn('order_items', 'commission_pct', 'REAL');
addColumn('order_items', 'author_earning_kobo', 'INTEGER NOT NULL DEFAULT 0');
addColumn('order_items', 'reader_file', 'TEXT');
// ---- v3: printed books & shipping ----
addColumn('products', 'format', "TEXT NOT NULL DEFAULT 'digital'");      // digital | print
addColumn('products', 'stock', 'INTEGER');
addColumn('products', 'weight_kg', 'REAL');
addColumn('products', 'book_condition', 'TEXT');
addColumn('products', 'ship_from_state', 'TEXT');
addColumn('products', 'ship_from_city', 'TEXT');
addColumn('orders', 'ship_name', 'TEXT');
addColumn('orders', 'ship_phone', 'TEXT');
addColumn('orders', 'ship_address', 'TEXT');
addColumn('orders', 'ship_city', 'TEXT');
addColumn('orders', 'ship_state', 'TEXT');
addColumn('orders', 'ship_landmark', 'TEXT');
addColumn('orders', 'ship_method', 'TEXT');
addColumn('orders', 'shipping_kobo', 'INTEGER NOT NULL DEFAULT 0');
addColumn('order_items', 'shipment_id', 'INTEGER');
addColumn('authors', 'ship_state', 'TEXT');
addColumn('authors', 'ship_city', 'TEXT');
addColumn('authors', 'pickup_address', 'TEXT');
addColumn('users', 'ship_json', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author_id INTEGER,                         -- NULL = shipped by the store
  origin_state TEXT, origin_city TEXT,
  method TEXT NOT NULL,                      -- doorstep | park | pickup
  zone TEXT,
  weight_kg REAL,
  fee_kobo INTEGER NOT NULL DEFAULT 0,
  author_shipping_kobo INTEGER NOT NULL DEFAULT 0,   -- shipping fee passed to the author who ships
  status TEXT NOT NULL DEFAULT 'awaiting_payment',   -- awaiting_payment | processing | shipped | delivered | cancelled
  courier TEXT, tracking TEXT, note TEXT,
  shipped_at TEXT, delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ship_order ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_ship_author ON shipments(author_id, status);
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_items_author ON order_items(author_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, is_active);`);

// Backfill sales counts once for stores that existed before this column
if (db.prepare("SELECT COUNT(*) c FROM products WHERE sales_count > 0").get().c === 0) {
  db.exec(`UPDATE products SET sales_count = (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = products.id AND o.status = 'paid' AND o.admin_note IS NOT 'Admin test copy')`);
}

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
