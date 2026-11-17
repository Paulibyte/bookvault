const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const sharp = require('sharp');
const { db, getSettings } = require('./db');
const { DIRS, safeName } = require('./util');
const { protectPdf } = require('./watermark/pdf');
const { protectDocx } = require('./watermark/docx');

function fillTemplate(tpl, data) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (data[k] != null ? data[k] : ''))
    .replace(/\s*\|\s*(\|\s*)+/g, ' | ').replace(/^\s*\|\s*|\s*\|\s*$/g, '').trim();
}

// Logo is cached per (file, opacity) so we only fade it once
const logoCache = new Map();
async function getLogo(settings) {
  if (!settings.watermark_logo) return null;
  const file = path.join(DIRS.branding, settings.watermark_logo);
  if (!fs.existsSync(file)) return null;
  const key = settings.watermark_logo + '|' + settings.watermark_opacity;
  if (logoCache.has(key)) return logoCache.get(key);
  const opacity = Math.min(Math.max(Number(settings.watermark_opacity) || 0.12, 0.03), 0.6);
  const base = sharp(file).resize({ width: 1200, withoutEnlargement: true }).ensureAlpha();
  const raw = await base.clone().png().toBuffer();
  const { data, info } = await sharp(raw).raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * opacity);
  const faded = await sharp(data, { raw: info }).png().toBuffer();
  const out = { raw, faded, width: info.width, height: info.height };
  logoCache.clear();
  logoCache.set(key, out);
  return out;
}

const inflight = new Map();

/** Returns absolute path of a ready-to-download zip for an order item, building it if needed. */
function buildDelivery(itemId) {
  if (inflight.has(itemId)) return inflight.get(itemId);
  const p = _build(itemId).finally(() => inflight.delete(itemId));
  inflight.set(itemId, p);
  return p;
}

async function stampFor(item, settings) {
  const data = {
    name: item.full_name, email: item.email, phone: item.phone || '',
    order: item.reference, store: settings.store_name,
    date: new Date((item.paid_at || item.order_date) + 'Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  };
  return {
    header: fillTemplate(settings.watermark_header, data),
    footer: fillTemplate(settings.watermark_footer, data),
    logo: await getLogo(settings),
  };
}

const ITEM_SQL = `
    SELECT oi.*, o.reference, o.paid_at, o.created_at AS order_date, u.full_name, u.email, u.phone,
           p.title, p.stored_file, p.original_name, p.file_type, p.protect, p.kind, p.reader_pdf
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN users u ON u.id = o.user_id
    JOIN products p ON p.id = oi.product_id WHERE oi.id = ?`;

/** Can this item be opened in the in-app reader? */
function isReadable(p) {
  return p.kind !== 'software' && (p.file_type === 'pdf' || (p.file_type === 'docx' && !!p.reader_pdf));
}

/** Personalised, password-protected PDF used by the in-app reader. */
function buildReaderFile(itemId) {
  const key = 'r' + itemId;
  if (inflight.has(key)) return inflight.get(key);
  const p = _buildReader(itemId).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function _buildReader(itemId) {
  const item = db.prepare(ITEM_SQL).get(itemId);
  if (!item || !isReadable(item)) throw new Error('This item cannot be read in the app.');
  if (item.reader_file) {
    const existing = path.join(DIRS.deliveries, item.reader_file);
    if (fs.existsSync(existing)) return { file: existing, item };
  }
  const settings = getSettings();
  const src = path.join(DIRS.products, item.file_type === 'pdf' ? item.stored_file : item.reader_pdf);
  if (!fs.existsSync(src)) throw new Error('The source file for this book is missing. Please contact the store.');
  if (!item.file_password) throw new Error('No password for this item');
  const name = `r_${item.id}_${crypto.randomBytes(5).toString('hex')}.pdf`;
  const out = path.join(DIRS.deliveries, name);
  const { header, footer, logo } = await stampFor(item, settings);
  await protectPdf(src, out, {
    header, footer, logoBytes: logo ? logo.raw : null, logoMime: 'image/png',
    opacity: settings.watermark_opacity, logoSizePct: settings.watermark_logo_size,
    userPassword: item.file_password, ownerPassword: crypto.randomBytes(18).toString('base64url'),
    allowPrint: settings.allow_print !== '0',
  });
  db.prepare('UPDATE order_items SET reader_file = ? WHERE id = ?').run(name, item.id);
  return { file: out, item };
}

async function _build(itemId) {
  const item = db.prepare(ITEM_SQL).get(itemId);
  if (!item) throw new Error('Item not found');

  if (item.delivery_file) {
    const existing = path.join(DIRS.deliveries, item.delivery_file);
    if (fs.existsSync(existing)) return { file: existing, item };
  }

  const settings = getSettings();
  const src = path.join(DIRS.products, item.stored_file);
  if (!fs.existsSync(src)) throw new Error('The source file for this product is missing. Please contact the store.');

  const ext = path.extname(item.original_name).toLowerCase();
  const baseName = safeName(path.basename(item.original_name, ext));
  const zipName = `${item.reference}_${item.id}_${crypto.randomBytes(4).toString('hex')}.zip`;
  const zipPath = path.join(DIRS.deliveries, zipName);
  const protect = item.kind !== 'software' && item.protect && (item.file_type === 'pdf' || item.file_type === 'docx');

  // A plain .zip product is delivered as-is
  if (item.file_type === 'zip') {
    await fs.promises.copyFile(src, zipPath);
  } else {
    let innerFile = src;
    let innerName = `${baseName}${ext}`;
    let tmpOut = null;

    if (protect) {
      let password = item.file_password;
      if (!password) throw new Error('No password for this item');
      const { header, footer, logo } = await stampFor(item, settings);
      tmpOut = path.join(DIRS.tmp, `${crypto.randomBytes(8).toString('hex')}${ext}`);
      innerName = `${baseName}_${safeName(item.full_name)}${ext}`;

      if (item.file_type === 'pdf') {
        await protectPdf(src, tmpOut, {
          header, footer,
          logoBytes: logo ? logo.raw : null, logoMime: 'image/png',
          opacity: settings.watermark_opacity, logoSizePct: settings.watermark_logo_size,
          userPassword: password,
          ownerPassword: crypto.randomBytes(18).toString('base64url'),
          allowPrint: settings.allow_print !== '0',
        });
      } else {
        await protectDocx(src, tmpOut, {
          header, footer,
          logoPng: logo ? logo.faded : null, logoW: logo && logo.width, logoH: logo && logo.height,
          logoSizePct: settings.watermark_logo_size,
          userPassword: password,
        });
      }
      innerFile = tmpOut;
    }

    const howTo = protect
      ? `Thank you for your purchase from ${settings.store_name}.\r\n\r\n` +
        `"${item.title}" is protected with a password that is unique to you.\r\n` +
        `Find the password on your "My Library" page on the store website.\r\n\r\n` +
        `This copy is licensed to ${item.full_name} (order ${item.reference}).\r\n` +
        `Your name is printed on every page. Please do not share it.\r\n`
      : `Thank you for your purchase from ${settings.store_name}.\r\nOrder ${item.reference}\r\n`;

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const z = archiver('zip', { zlib: { level: 6 } });
      out.on('close', resolve);
      z.on('error', reject);
      z.pipe(out);
      z.file(innerFile, { name: innerName });
      z.append(howTo, { name: 'READ ME FIRST.txt' });
      z.finalize();
    });
    if (tmpOut) fs.promises.unlink(tmpOut).catch(() => {});
  }

  db.prepare('UPDATE order_items SET delivery_file = ? WHERE id = ?').run(zipName, item.id);
  return { file: zipPath, item };
}

/** Delete cached deliveries (e.g. after a product file or watermark setting changes). */
function clearDeliveries(productId = null, userId = null) {
  let where = '(delivery_file IS NOT NULL OR reader_file IS NOT NULL)';
  const params = [];
  if (productId) { where += ' AND product_id = ?'; params.push(productId); }
  if (userId) { where += ' AND order_id IN (SELECT id FROM orders WHERE user_id = ?)'; params.push(userId); }
  const rows = db.prepare(`SELECT id, delivery_file, reader_file FROM order_items WHERE ${where}`).all(...params);
  for (const r of rows) for (const f of [r.delivery_file, r.reader_file]) if (f) fs.promises.unlink(path.join(DIRS.deliveries, f)).catch(() => {});
  db.prepare(`UPDATE order_items SET delivery_file = NULL, reader_file = NULL WHERE ${where}`).run(...params);
  return rows.length;
}

module.exports = { buildDelivery, buildReaderFile, clearDeliveries, fillTemplate, isReadable };
