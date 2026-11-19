// Optional: convert .docx books to PDF so they can be read inside the app.
// Needs LibreOffice on the server (apt install -y libreoffice-writer --no-install-recommends).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { DIRS } = require('../util');
const { normalisePdf } = require('./pdf');

let soffice = process.env.SOFFICE_PATH || null;
if (!soffice) {
  for (const c of ['soffice', 'libreoffice']) {
    try { execFileSync('which', [c], { stdio: 'pipe' }); soffice = c; break; } catch {}
  }
}

function available() { return !!soffice; }

/** Convert a stored .docx to a normalised PDF in storage/products. Returns the stored PDF name, or null. */
function docxToPdf(storedDocx) {
  if (!soffice) return Promise.resolve(null);
  const src = path.join(DIRS.products, storedDocx);
  const outDir = path.join(DIRS.tmp, 'conv_' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(outDir, { recursive: true });
  return new Promise(resolve => {
    execFile(soffice, ['--headless', `-env:UserInstallation=file://${outDir}/profile`, '--convert-to', 'pdf', '--outdir', outDir, src],
      { timeout: 180000 }, async (err) => {
        try {
          const produced = path.join(outDir, path.basename(storedDocx, path.extname(storedDocx)) + '.pdf');
          if (err || !fs.existsSync(produced)) return resolve(null);
          const name = path.basename(storedDocx, path.extname(storedDocx)) + '_reader.pdf';
          await normalisePdf(produced, path.join(DIRS.products, name));
          resolve(name);
        } catch { resolve(null); }
        finally { fs.rm(outDir, { recursive: true, force: true }, () => {}); }
      });
  });
}

module.exports = { available, docxToPdf };
