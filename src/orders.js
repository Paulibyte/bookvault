const { db } = require('./db');
const { makePassword } = require('./util');

/** Mark an order as paid and give every item its own password. Idempotent. */
function markPaid(orderId, { note = null, opayOrderNo = null } = {}) {
  const tx = db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw new Error('Order not found');
    if (o.status === 'paid') return o;
    db.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now'),
      admin_note = COALESCE(?, admin_note), opay_order_no = COALESCE(?, opay_order_no) WHERE id = ?`)
      .run(note, opayOrderNo, orderId);
    const items = db.prepare('SELECT id, file_password FROM order_items WHERE order_id = ?').all(orderId);
    const upd = db.prepare('UPDATE order_items SET file_password = ? WHERE id = ?');
    for (const it of items) if (!it.file_password) upd.run(makePassword(8), it.id);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  return tx();
}

/** Product IDs the user already owns (paid). */
function ownedProductIds(userId) {
  return new Set(db.prepare(`SELECT oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.user_id = ? AND o.status = 'paid'`).all(userId).map(r => r.product_id));
}

module.exports = { markPaid, ownedProductIds };
