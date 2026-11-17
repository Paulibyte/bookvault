const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

const run = promisify(execFile);
const QPDF = process.env.QPDF_PATH || 'qpdf';

// Standard PDF fonts only support WinAnsi — strip anything else (e.g. Ọ → O)
function ansi(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

/**
 * Validate an uploaded PDF and write an unencrypted, normalised copy.
 * Rejects PDFs that need a password to open.
 */
async function normalisePdf(input, output) {
  try {
    await run(QPDF, ['--decrypt', '--object-streams=generate', input, output], { maxBuffer: 1 << 24 });
  } catch (e) {
    // qpdf exit code 3 = warnings only; output is still valid
    if (e.code !== 3 || !fs.existsSync(output)) {
      const msg = String(e.stderr || e.message);
      if (/password/i.test(msg)) throw new Error('This PDF is password-protected. Upload the original unprotected PDF.');
      throw new Error('This PDF could not be read. It may be damaged.');
    }
  }
  const { stdout } = await run(QPDF, ['--show-npages', output]);
  return { pages: parseInt(stdout, 10) || null };
}

/** Map a point on the page as the reader sees it to PDF user space, honouring /Rotate and box offsets. */
function placer(page) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
  const w = box.width, h = box.height;
  const visW = rot % 180 === 0 ? w : h;
  const visH = rot % 180 === 0 ? h : w;
  function map(x, y) {
    let u, v;
    if (rot === 90) { u = w - y; v = x; }
    else if (rot === 180) { u = w - x; v = h - y; }
    else if (rot === 270) { u = y; v = h - x; }
    else { u = x; v = y; }
    return { x: u + box.x, y: v + box.y };
  }
  return { visW, visH, map, angle: rot };
}

/**
 * Stamp header, footer and a faint centred logo on every page, then encrypt.
 * opts: { header, footer, logoBytes (png/jpg Buffer|null), logoMime, opacity, logoSizePct, userPassword, ownerPassword, allowPrint }
 */
async function protectPdf(inputPath, outputPath, opts) {
  const src = await fs.promises.readFile(inputPath);
  const pdf = await PDFDocument.load(src, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let logo = null;
  if (opts.logoBytes) {
    try {
      logo = opts.logoMime === 'image/jpeg' ? await pdf.embedJpg(opts.logoBytes) : await pdf.embedPng(opts.logoBytes);
    } catch { logo = null; }
  }

  const header = ansi(opts.header);
  const footer = ansi(opts.footer);
  const opacity = Math.min(Math.max(Number(opts.opacity) || 0.12, 0.03), 0.6);
  const sizePct = Math.min(Math.max(Number(opts.logoSizePct) || 45, 10), 90) / 100;
  const grey = rgb(0.35, 0.35, 0.35);

  const pages = pdf.getPages();
  pages.forEach((page, idx) => {
    const P = placer(page);
    const fs1 = Math.max(6, Math.min(9, P.visW / 70));

    const drawCentered = (text, yVis, f, size, color, op) => {
      if (!text) return;
      let t = text;
      while (t.length > 4 && f.widthOfTextAtSize(t, size) > P.visW - 24) t = t.slice(0, -2);
      const tw = f.widthOfTextAtSize(t, size);
      const pt = P.map((P.visW - tw) / 2, yVis);
      page.drawText(t, { x: pt.x, y: pt.y, size, font: f, color, opacity: op, rotate: degrees(P.angle) });
    };

    // Header (top) and footer (bottom), on a thin white band so it stays legible
    drawCentered(header, P.visH - 6 - fs1, bold, fs1, grey, 0.85);
    drawCentered(`${footer}${footer ? '  |  ' : ''}Page ${idx + 1} of ${pages.length}`, 6, font, fs1, grey, 0.85);

    // Centred logo watermark
    if (logo) {
      const targetW = P.visW * sizePct;
      const scale = targetW / logo.width;
      const lw = logo.width * scale, lh = logo.height * scale;
      const pt = P.map((P.visW - lw) / 2, (P.visH - lh) / 2);
      page.drawImage(logo, { x: pt.x, y: pt.y, width: lw, height: lh, opacity, rotate: degrees(P.angle) });
    }
  });

  pdf.setProducer('BookVault');
  const tmp = outputPath + '.plain.pdf';
  await fs.promises.writeFile(tmp, await pdf.save({ useObjectStreams: true }));

  // AES-256 encryption with qpdf: buyer password to open; owner password locks editing/copying
  const args = ['--encrypt', opts.userPassword, opts.ownerPassword, '256',
    `--print=${opts.allowPrint ? 'full' : 'none'}`, '--modify=none', '--extract=n', '--annotate=n', '--',
    tmp, outputPath];
  try {
    await run(QPDF, args, { maxBuffer: 1 << 24 });
  } catch (e) {
    if (e.code !== 3) throw new Error('Encryption failed: ' + (e.stderr || e.message));
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

module.exports = { normalisePdf, protectPdf, ansi };
