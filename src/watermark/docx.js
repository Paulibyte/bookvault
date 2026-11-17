const fs = require('fs');
const JSZip = require('jszip');
const officeCrypto = require('officecrypto-tool');

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function run(text, { bold = false, size = 16 } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="595959"/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function field(instr, size = 16) {
  const rp = `<w:rPr><w:color w:val="595959"/><w:sz w:val="${size}"/></w:rPr>`;
  return `<w:r>${rp}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rp}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    `<w:r>${rp}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rp}<w:t>1</w:t></w:r><w:r>${rp}<w:fldChar w:fldCharType="end"/></w:r>`;
}

function logoDrawing(widthEmu, heightEmu) {
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="page"><wp:align>center</wp:align></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:align>center</wp:align></wp:positionV>` +
    `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
    `<wp:docPr id="9901" name="BookVault watermark"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="9901" name="bv_logo.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rIdBVImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
}

/**
 * Replace headers/footers of every section with buyer details, add a faded centred logo,
 * then encrypt with a password (Agile/AES — opens in Word, LibreOffice and WPS).
 * opts: { header, footer, logoPng (Buffer, already faded) | null, logoW, logoH (px), logoSizePct, userPassword }
 */
async function protectDocx(inputPath, outputPath, opts) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(inputPath));
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Not a valid Word (.docx) document.');
  let doc = await docFile.async('string');

  // Page width (twips) from first section — used to size the logo
  const pgW = Number((doc.match(/<w:pgSz[^>]*w:w="(\d+)"/) || [])[1]) || 11906;
  const sizePct = Math.min(Math.max(Number(opts.logoSizePct) || 45, 10), 90) / 100;

  const hasLogo = !!opts.logoPng;
  let logoXml = '';
  if (hasLogo) {
    const wEmu = Math.round(pgW * 635 * sizePct);
    const hEmu = Math.round(wEmu * (opts.logoH / opts.logoW));
    logoXml = logoDrawing(wEmu, hEmu);
    zip.file('word/media/bv_logo.png', opts.logoPng);
    zip.file('word/_rels/header_bv.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdBVImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/bv_logo.png"/></Relationships>`);
  }

  zip.file('word/header_bv.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>` +
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr>${logoXml}${run(opts.header, { bold: true })}</w:p></w:hdr>`);

  zip.file('word/footer_bv.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}>` +
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr>${run((opts.footer ? opts.footer + '  |  ' : '') + 'Page ')}${field('PAGE')}${run(' of ')}${field('NUMPAGES')}</w:p></w:ftr>`);

  // Relationships from document.xml
  const relPath = 'word/_rels/document.xml.rels';
  let rels = await zip.file(relPath).async('string');
  rels = rels.replace(/<Relationship[^>]*Id="rIdBV(Hdr|Ftr)"[^>]*\/>/g, '');
  rels = rels.replace('</Relationships>',
    `<Relationship Id="rIdBVHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header_bv.xml"/>` +
    `<Relationship Id="rIdBVFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer_bv.xml"/></Relationships>`);
  zip.file(relPath, rels);

  // Content types
  let ct = await zip.file('[Content_Types].xml').async('string');
  if (!/Extension="png"/i.test(ct)) ct = ct.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
  if (!ct.includes('/word/header_bv.xml')) {
    ct = ct.replace('</Types>',
      '<Override PartName="/word/header_bv.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
      '<Override PartName="/word/footer_bv.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>');
  }
  zip.file('[Content_Types].xml', ct);

  // Point every section's default/first/even header & footer at ours
  const refs = ['default', 'first', 'even'].map(t =>
    `<w:headerReference w:type="${t}" r:id="rIdBVHdr"/>`).join('') +
    ['default', 'first', 'even'].map(t => `<w:footerReference w:type="${t}" r:id="rIdBVFtr"/>`).join('');

  if (!/xmlns:r=/.test(doc.slice(0, 3000))) {
    doc = doc.replace(/<w:document\b/, '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
  }
  let sections = 0;
  doc = doc.replace(/<w:sectPr\b([^>]*?)\/>/g, (m, attrs) => { sections++; return `<w:sectPr${attrs}>${refs}</w:sectPr>`; });
  doc = doc.replace(/<w:sectPr\b([^>]*)>([\s\S]*?)<\/w:sectPr>/g, (m, attrs, inner) => {
    if (inner.startsWith(refs)) return m;
    sections++;
    inner = inner.replace(/<w:(header|footer)Reference\b[^>]*\/>/g, '');
    return `<w:sectPr${attrs}>${refs}${inner}</w:sectPr>`;
  });
  if (!sections) {
    doc = doc.replace('</w:body>', `<w:sectPr>${refs}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body>`);
  }
  zip.file('word/document.xml', doc);

  // Make sure Word shows even-page headers too (we point even → ours anyway) and remove write-protection
  const settingsFile = zip.file('word/settings.xml');
  if (settingsFile) {
    let st = await settingsFile.async('string');
    st = st.replace(/<w:documentProtection\b[^>]*\/>/g, '').replace(/<w:writeProtection\b[^>]*\/>/g, '');
    zip.file('word/settings.xml', st);
  }

  const plain = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const encrypted = officeCrypto.encrypt(plain, { password: opts.userPassword });
  await fs.promises.writeFile(outputPath, encrypted);
}

async function validateDocx(path) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(path)).catch(() => null);
  if (!zip || !zip.file('word/document.xml')) {
    throw new Error('This Word file could not be read. If it is password-protected or an old .doc file, save it as an unprotected .docx and upload again.');
  }
}

module.exports = { protectDocx, validateDocx };
