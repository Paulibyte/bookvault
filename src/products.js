// Shared helpers for creating/updating products (used by admin and author portals)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { db } = require('./db');
const { DIRS, slugify, fileTypeOf } = require('./util');
const { normalisePdf } = require('./watermark/pdf');
const { validateDocx } = require('./watermark/docx');
const convert = require('./watermark/convert');

const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 500;
const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.tmp,
    filename: (req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

function nairaToKobo(v) {
  const n = parseFloat(String(v || '0').replace(/[^0-9.]/g, ''));
  return Math.round((isNaN(n) ? 0 : n) * 100);
}

function uniqueSlug(title, exceptId = 0) {
  const base = slugify(title);
  let s = base, i = 2;
  while (db.prepare('SELECT 1 FROM products WHERE slug = ? AND id != ?').get(s, exceptId)) s = `${base}-${i++}`;
  return s;
}

function categoryId(body) {
  const newCat = (body.new_category || '').trim();
  if (newCat) {
    db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(newCat);
    return db.prepare('SELECT id FROM categories WHERE name = ?').get(newCat).id;
  }
  return Number(body.category_id) || null;
}

async function saveCover(file) {
  if (!file) return null;
  const name = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}.webp`;
  try {
    await sharp(file.path).rotate().resize({ width: 700, height: 980, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toFile(path.join(DIRS.covers, name));
    return name;
  } catch {
    return null;
  } finally { fs.promises.unlink(file.path).catch(() => {}); }
}

/** Validate + move an uploaded product file into storage. Returns meta. */
async function saveProductFile(file, kind = 'book') {
  const type = fileTypeOf(file.originalname);
  if (kind === 'software' && type !== 'zip') {
    // Software is always delivered as a zip; other files get wrapped at download time
  }
  const stored = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`;
  const dest = path.join(DIRS.products, stored);
  let pages = null;
  try {
    if (type === 'pdf') {
      ({ pages } = await normalisePdf(file.path, dest));
    } else {
      if (type === 'docx') await validateDocx(file.path);
      await fs.promises.copyFile(file.path, dest);
    }
  } finally { fs.promises.unlink(file.path).catch(() => {}); }
  const size = (await fs.promises.stat(dest)).size;
  // Word books get a PDF twin so they can be read in the app (needs LibreOffice on the server)
  let readerPdf = null;
  if (type === 'docx' && kind !== 'software') readerPdf = await convert.docxToPdf(stored);
  return { stored, type, pages, size, original: file.originalname, readerPdf };
}

/** Save a private supporting document (ID card, copyright certificate). Returns stored name. */
async function savePrivateDoc(file, prefix) {
  if (!file) return null;
  const ext = path.extname(file.originalname).toLowerCase();
  if (!/^\.(pdf|jpe?g|png|webp)$/.test(ext)) { fs.promises.unlink(file.path).catch(() => {}); throw new Error('Documents must be PDF, JPG, PNG or WEBP.'); }
  const name = `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  await fs.promises.rename(file.path, path.join(DIRS.authors, name)).catch(async () => {
    await fs.promises.copyFile(file.path, path.join(DIRS.authors, name));
    fs.promises.unlink(file.path).catch(() => {});
  });
  return name;
}

async function savePhoto(file) {
  if (!file) return null;
  const name = `photo_${Date.now()}_${crypto.randomBytes(5).toString('hex')}.webp`;
  try {
    await sharp(file.path).rotate().resize({ width: 400, height: 400, fit: 'cover' }).webp({ quality: 82 }).toFile(path.join(DIRS.authors, name));
    return name;
  } catch { return null; } finally { fs.promises.unlink(file.path).catch(() => {}); }
}

function removeStored(...names) {
  for (const n of names) if (n) fs.promises.unlink(path.join(DIRS.products, n)).catch(() => {});
}

function cleanupFiles(req) {
  for (const arr of Object.values(req.files || {})) for (const f of arr) fs.promises.unlink(f.path).catch(() => {});
  if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
}

const PLATFORMS = ['Windows', 'Android', 'macOS', 'Linux', 'iOS', 'Web', 'Windows + macOS', 'Multi-platform'];

module.exports = { MAX_MB, upload, nairaToKobo, uniqueSlug, categoryId, saveCover, saveProductFile, savePrivateDoc, savePhoto, removeStored, cleanupFiles, PLATFORMS };
