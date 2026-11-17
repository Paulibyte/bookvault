const { db, getSettings } = require('./db');
const { makePassword } = require('./util');

/** Commission % the store keeps for an author's sale. */
function commissionFor(authorId) {
  const s = getSettings();
  const a = authorId ? db.prepare('SELECT commission_pct FROM authors WHERE id = ?').get(authorId) : null;
  const pct = a && a.commission_pct != null ? Number(a.commission_pct) : Number(s.default_commission_pct);
  return Math.min(Math.max(isNaN(pct) ? 30 : pct, 0), 100);
}

/** Royalty position of an author, all in kobo. */
function authorBalance(authorId) {
  const earned = db.prepare(`SELECT COALESCE(SUM(oi.author_earning_kobo),0) v FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.author_id = ? AND o.status = 'paid'`).get(authorId).v;
  const paid = db.prepare(`SELECT COALESCE(SUM(amount_kobo),0) v FROM payouts WHERE author_id = ? AND status = 'paid'`).get(authorId).v;
  const requested = db.prepare(`SELECT COALESCE(SUM(amount_kobo),0) v FROM payouts WHERE author_id = ? AND status = 'requested'`).get(authorId).v;
  return { earned, paid, requested, available: earned - paid - requested };
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
    for (const it of items) {
      let pct = null, earning = 0;
      if (it.author_id && !isTest) {
        pct = commissionFor(it.author_id);
        earning = Math.floor(it.price_kobo * (100 - pct) / 100);
        authorsTouched.add(it.author_id);
      }
      upd.run(makePassword(8), it.author_id || null, pct, earning, it.id);
      if (!isTest) sold.run(it.product_id);
    }
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  const res = tx();
  // Automatic royalty payout requests once an author crosses the threshold
  for (const aid of authorsTouched) {
    const a = db.prepare('SELECT auto_payout FROM authors WHERE id = ?').get(aid);
    if (a && a.auto_payout) {
      const pending = db.prepare("SELECT COUNT(*) c FROM payouts WHERE author_id = ? AND status = 'requested'").get(aid).c;
      if (!pending) requestPayout(aid, 'auto');
    }
  }
  return res;
}

/** Product IDs the user already owns (paid). */
function ownedProductIds(userId) {
  return new Set(db.prepare(`SELECT oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.user_id = ? AND o.status = 'paid'`).all(userId).map(r => r.product_id));
}

/** Recompute a product's rating from visible reviews. */
function refreshRating(productId) {
  const r = db.prepare('SELECT COUNT(*) n, COALESCE(AVG(rating),0) a FROM reviews WHERE product_id = ? AND is_hidden = 0').get(productId);
  db.prepare('UPDATE products SET rating_avg = ?, rating_count = ? WHERE id = ?').run(Math.round(r.a * 10) / 10, r.n, productId);
}

module.exports = { markPaid, ownedProductIds, commissionFor, authorBalance, requestPayout, refreshRating };
