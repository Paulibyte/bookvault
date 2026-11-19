const { db, getSettings } = require('./db');
const { makePassword } = require('./util');

/** Commission % the store keeps for an author's sale. */
function commissionFor(authorId) {
  const s = getSettings();
  const a = authorId ? db.prepare('SELECT commission_pct FROM authors WHERE id = ?').get(authorId) : null;
  const pct = a && a.commission_pct != null ? Number(a.commission_pct) : Number(s.default_commission_pct);
  return Math.min(Math.max(isNaN(pct) ? 30 : pct, 0), 100);
}

// A printed-book shipment "clears" (its royalties become withdrawable) once delivered,
// or automatically N days after it was marked shipped.
function clearedSql(alias = 'sh') {
  const days = Math.max(0, Number(getSettings().royalty_hold_days) || 14);
  return `(${alias}.status = 'delivered' OR (${alias}.status = 'shipped' AND ${alias}.shipped_at <= datetime('now', '-${days} days')))`;
}

/** Royalty position of an author, all in kobo. */
function authorBalance(authorId) {
  const C = clearedSql('sh');
  const itemEarned = db.prepare(`SELECT COALESCE(SUM(oi.author_earning_kobo),0) v FROM order_items oi JOIN orders o ON o.id = oi.order_id
    LEFT JOIN shipments sh ON sh.id = oi.shipment_id
    WHERE oi.author_id = ? AND o.status = 'paid' AND (oi.shipment_id IS NULL OR ${C})`).get(authorId).v;
  const shipEarned = db.prepare(`SELECT COALESCE(SUM(sh.author_shipping_kobo),0) v FROM shipments sh JOIN orders o ON o.id = sh.order_id
    WHERE sh.author_id = ? AND o.status = 'paid' AND ${C}`).get(authorId).v;
  const pendingItems = db.prepare(`SELECT COALESCE(SUM(oi.author_earning_kobo),0) v FROM order_items oi JOIN orders o ON o.id = oi.order_id
    JOIN shipments sh ON sh.id = oi.shipment_id
    WHERE oi.author_id = ? AND o.status = 'paid' AND sh.status != 'cancelled' AND NOT ${C}`).get(authorId).v;
  const pendingShip = db.prepare(`SELECT COALESCE(SUM(sh.author_shipping_kobo),0) v FROM shipments sh JOIN orders o ON o.id = sh.order_id
    WHERE sh.author_id = ? AND o.status = 'paid' AND sh.status != 'cancelled' AND NOT ${C}`).get(authorId).v;
  const earned = itemEarned + shipEarned;
  const pending = pendingItems + pendingShip;
  const paid = db.prepare(`SELECT COALESCE(SUM(amount_kobo),0) v FROM payouts WHERE author_id = ? AND status = 'paid'`).get(authorId).v;
  const requested = db.prepare(`SELECT COALESCE(SUM(amount_kobo),0) v FROM payouts WHERE author_id = ? AND status = 'requested'`).get(authorId).v;
  return { earned, pending, paid, requested, available: earned - paid - requested };
}

/** Create a payout request for the author's full available balance, if allowed. Returns payout id or null. */
function requestPayout(authorId, trigger = 'request') {
  const a = db.prepare('SELECT * FROM authors WHERE id = ?').get(authorId);
  if (!a || a.status !== 'verified') return { error: 'Your author account is not verified.' };
  if (!a.bank_account_number || !a.bank_name || !a.bank_account_name) return { error: 'Add your bank account details first.' };
  const min = Number(getSettings().payout_min_kobo) || 0;
  const bal = authorBalance(authorId);
  if (bal.available <= 0) return { error: 'You have no royalties available yet.' };
  if (bal.available < min) return { error: `The minimum payout is ₦${(min / 100).toLocaleString('en-NG')}.` };
  const info = db.prepare(`INSERT INTO payouts (author_id, amount_kobo, trigger, bank_name, bank_account_number, bank_account_name)
    VALUES (?, ?, ?, ?, ?, ?)`).run(authorId, bal.available, trigger, a.bank_name, a.bank_account_number, a.bank_account_name);
  return { id: info.lastInsertRowid, amount: bal.available };
}

/** Mark an order as paid, give every item its own password, credit authors. Idempotent. */
function markPaid(orderId, { note = null, opayOrderNo = null } = {}) {
  const authorsTouched = new Set();
  const tx = db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw new Error('Order not found');
    if (o.status === 'paid') return o;
    db.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now'),
      admin_note = COALESCE(?, admin_note), opay_order_no = COALESCE(?, opay_order_no) WHERE id = ?`)
      .run(note, opayOrderNo, orderId);
    const isTest = (note || o.admin_note) === 'Admin test copy';
    const items = db.prepare(`SELECT oi.id, oi.file_password, oi.price_kobo, oi.product_id, p.author_id
      FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(orderId);
    const upd = db.prepare('UPDATE order_items SET file_password = COALESCE(file_password, ?), author_id = ?, commission_pct = ?, author_earning_kobo = ? WHERE id = ?');
    const sold = db.prepare('UPDATE products SET sales_count = sales_count + 1 WHERE id = ?');
    const destock = db.prepare("UPDATE products SET stock = MAX(COALESCE(stock,0) - 1, 0) WHERE id = ? AND format = 'print'");
    db.prepare("UPDATE shipments SET status = 'processing' WHERE order_id = ? AND status = 'awaiting_payment'").run(orderId);
    db.prepare('SELECT author_id FROM shipments WHERE order_id = ? AND author_id IS NOT NULL').all(orderId).forEach(r => authorsTouched.add(r.author_id));
    for (const it of items) {
      let pct = null, earning = 0;
      if (it.author_id && !isTest) {
        pct = commissionFor(it.author_id);
        earning = Math.floor(it.price_kobo * (100 - pct) / 100);
        authorsTouched.add(it.author_id);
      }
      upd.run(makePassword(8), it.author_id || null, pct, earning, it.id);
      if (!isTest) { sold.run(it.product_id); destock.run(it.product_id); }
    }
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  const res = tx();
  // Automatic royalty payout requests once an author crosses the threshold
  for (const aid of authorsTouched) maybeAutoPayout(aid);
  return res;
}

/** Raise an automatic payout request if the author has auto-payout on and has crossed the threshold. */
function maybeAutoPayout(authorId) {
  const a = db.prepare('SELECT auto_payout FROM authors WHERE id = ?').get(authorId);
  if (!a || !a.auto_payout) return null;
  const pending = db.prepare("SELECT COUNT(*) c FROM payouts WHERE author_id = ? AND status = 'requested'").get(authorId).c;
  if (pending) return null;
  const r = requestPayout(authorId, 'auto');
  return r.error ? null : r;
}

/** Past paid sales of a product (excluding admin test copies). */
function productSales(productId) {
  return db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(oi.price_kobo),0) gross, COALESCE(SUM(oi.author_earning_kobo),0) royalties
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = ? AND o.status = 'paid' AND o.admin_note IS NOT 'Admin test copy'`).get(productId);
}

/**
 * Assign a product to a verified author (or back to the store with null) and move ALL its past sales
 * and royalties to the new owner. Royalties are recalculated with the new author's commission.
 */
function reassignProduct(productId, newAuthorId) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) throw new Error('Product not found');
  newAuthorId = newAuthorId ? Number(newAuthorId) : null;
  let a = null;
  if (newAuthorId) {
    a = db.prepare("SELECT * FROM authors WHERE id = ? AND status = 'verified'").get(newAuthorId);
    if (!a) throw new Error('Choose a verified author.');
  }
  if ((p.author_id || null) === newAuthorId) return { changed: false };
  const prevAuthorId = p.author_id || null;
  const pct = a ? commissionFor(a.id) : null;
  const result = db.transaction(() => {
    db.prepare('UPDATE products SET author_id = ?, author = COALESCE(?, author), updated_at = datetime(\'now\') WHERE id = ?')
      .run(newAuthorId, a ? a.pen_name : null, p.id);
    const items = db.prepare(`SELECT oi.id, oi.price_kobo FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = ? AND o.status = 'paid' AND o.admin_note IS NOT 'Admin test copy'`).all(p.id);
    const upd = db.prepare('UPDATE order_items SET author_id = ?, commission_pct = ?, author_earning_kobo = ? WHERE id = ?');
    let total = 0;
    for (const it of items) {
      const earning = a ? Math.floor(it.price_kobo * (100 - pct) / 100) : 0;
      total += earning;
      upd.run(newAuthorId, pct, earning, it.id);
    }
    return { changed: true, moved: items.length, royalties: total, pct, prevAuthorId, author: a };
  })();
  if (a) result.autoPayout = maybeAutoPayout(a.id);
  return result;
}

/** Product IDs the user already owns (paid). */
function ownedProductIds(userId, { includePrint = true } = {}) {
  return new Set(db.prepare(`SELECT oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
    WHERE o.user_id = ? AND o.status = 'paid' ${includePrint ? '' : "AND p.format != 'print'"}`).all(userId).map(r => r.product_id));
}

/** Update a shipment's status (by the seller, admin or buyer). Returns the updated row. */
function updateShipment(id, { status, courier, tracking, note }) {
  const sh = db.prepare('SELECT * FROM shipments WHERE id = ?').get(id);
  if (!sh) throw new Error('Shipment not found');
  const allowed = { processing: ['shipped', 'delivered', 'cancelled'], shipped: ['delivered', 'shipped'], delivered: [], awaiting_payment: ['cancelled'], cancelled: [] };
  if (status && status !== sh.status && !(allowed[sh.status] || []).includes(status)) throw new Error(`Cannot change a ${sh.status} shipment to ${status}.`);
  if (status === 'shipped' && sh.method !== 'pickup' && !(courier || sh.courier)) throw new Error('Enter the courier or transport company.');
  db.prepare(`UPDATE shipments SET status = COALESCE(?, status), courier = COALESCE(?, courier), tracking = COALESCE(?, tracking), note = COALESCE(?, note),
    shipped_at = CASE WHEN ? = 'shipped' AND shipped_at IS NULL THEN datetime('now') ELSE shipped_at END,
    delivered_at = CASE WHEN ? = 'delivered' THEN datetime('now') ELSE delivered_at END WHERE id = ?`)
    .run(status || null, courier || null, tracking || null, note || null, status || '', status || '', id);
  if (status === 'cancelled' && sh.status === 'processing') {
    // Put the copies back in stock
    db.prepare(`UPDATE products SET stock = COALESCE(stock,0) + 1 WHERE id IN (SELECT product_id FROM order_items WHERE shipment_id = ?)`).run(id);
  }
  if (status === 'delivered' && sh.author_id) maybeAutoPayout(sh.author_id);
  return db.prepare('SELECT * FROM shipments WHERE id = ?').get(id);
}

/** Recompute a product's rating from visible reviews. */
function refreshRating(productId) {
  const r = db.prepare('SELECT COUNT(*) n, COALESCE(AVG(rating),0) a FROM reviews WHERE product_id = ? AND is_hidden = 0').get(productId);
  db.prepare('UPDATE products SET rating_avg = ?, rating_count = ? WHERE id = ?').run(Math.round(r.a * 10) / 10, r.n, productId);
}

module.exports = { updateShipment, clearedSql, reassignProduct, productSales, maybeAutoPayout, markPaid, ownedProductIds, commissionFor, authorBalance, requestPayout, refreshRating };
