const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORAGE = path.join(ROOT, 'storage');
const DIRS = {
  products: path.join(STORAGE, 'products'),
  covers: path.join(STORAGE, 'covers'),
  proofs: path.join(STORAGE, 'proofs'),
  deliveries: path.join(STORAGE, 'deliveries'),
  branding: path.join(STORAGE, 'branding'),
  authors: path.join(STORAGE, 'authors'),
  tmp: path.join(STORAGE, 'tmp'),
};

function naira(kobo) {
  const n = (Number(kobo) || 0) / 100;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_-]+/g, '-').slice(0, 80) || 'item';
}

// Easy-to-read passwords: no 0/O/1/l/I confusion
function makePassword(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function makeReference(prefix = 'BV') {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  return `${prefix}${ymd}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function fileTypeOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.zip') return 'zip';
  return 'other';
}

function humanSize(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

function safeName(s) {
  return String(s).replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').slice(0, 90) || 'file';
}

module.exports = { ROOT, STORAGE, DIRS, naira, slugify, makePassword, makeReference, fileTypeOf, humanSize, safeName };
