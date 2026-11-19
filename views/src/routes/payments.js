const express = require('express');
const { db } = require('../db');
const { flash, requireLogin } = require('../middleware');
const { markPaid } = require('../orders');
const opay = require('../opay');

const router = express.Router();

function baseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

/** Ask OPay for the real status and unlock the order if it is paid in full. */
async function verify(order) {
  if (order.status === 'paid') return 'SUCCESS';
  const r = await opay.queryStatus(order.reference);
  if (r.status === 'SUCCESS') {
    const paidKobo = r.amount && Number(r.amount.total);
    if (paidKobo && paidKobo < order.total_kobo) {
      db.prepare('UPDATE orders SET admin_note = ? WHERE id = ?').run(`OPay amount mismatch: got ${paidKobo}`, order.id);
      return 'MISMATCH';
    }
    markPaid(order.id, { opayOrderNo: r.orderNo, note: 'Paid via OPay' });
  } else if (['FAIL', 'CLOSE'].includes(r.status)) {
    db.prepare("UPDATE orders SET status = 'pending' WHERE id = ? AND status != 'paid'").run(order.id);
  }
  return r.status;
}

router.get('/opay/start/:ref', requireLogin, async (req, res, next) => {
  try {
    const o = db.prepare('SELECT * FROM orders WHERE reference = ? AND user_id = ?').get(req.params.ref, req.user.id);
    if (!o || o.status === 'paid') return res.redirect('/library');
    if (!opay.configured()) { flash(req, 'error', 'OPay is not configured.'); return res.redirect(`/order/${o.reference}`); }
    if (o.method !== 'opay') db.prepare("UPDATE orders SET method = 'opay' WHERE id = ?").run(o.id);
    const titles = db.prepare(`SELECT p.title FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`)
      .all(o.id).map(r => r.title).join(', ');
    const base = baseUrl(req);
    // OPay needs a fresh reference if a previous attempt was abandoned
    let ref = o.reference;
    if (o.opay_order_no === 'started') {
      ref = o.reference.replace(/-R\d+$/, '') + '-R' + Date.now().toString().slice(-5);
      db.prepare('UPDATE orders SET reference = ? WHERE id = ?').run(ref, o.id);
    }
    const data = await opay.createCashier({
      reference: ref,
      amountKobo: o.total_kobo,
      user: req.user,
      productName: titles || 'Digital purchase',
      returnUrl: `${base}/payments/opay/return/${ref}`,
      cancelUrl: `${base}/order/${ref}`,
      callbackUrl: `${base}/payments/opay/webhook`,
    });
    db.prepare("UPDATE orders SET opay_order_no = 'started' WHERE id = ?").run(o.id);
    res.redirect(data.cashierUrl);
  } catch (e) {
    console.error(e);
    flash(req, 'error', e.message || 'Could not start OPay payment.');
    res.redirect(`/order/${req.params.ref}`);
  }
});

router.get('/opay/return/:ref', requireLogin, async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE reference = ? AND user_id = ?').get(req.params.ref, req.user.id);
  if (!o) return res.redirect('/orders');
  try {
    const status = await verify(o);
    if (status === 'SUCCESS') { flash(req, 'success', 'Payment confirmed! Your downloads are ready below.'); return res.redirect('/library'); }
    if (status === 'PENDING' || status === 'INITIAL') flash(req, 'info', 'Your payment is still processing. Refresh this page in a minute.');
    else if (status === 'MISMATCH') flash(req, 'error', 'The amount paid did not match the order. The store has been notified.');
    else flash(req, 'error', 'Payment was not completed. You can try again.');
  } catch (e) {
    console.error(e);
    flash(req, 'error', 'Could not verify payment right now. Refresh in a minute.');
  }
  res.redirect(`/order/${o.reference}`);
});

router.post('/opay/check/:ref', requireLogin, async (req, res) => {
  res.redirect(`/payments/opay/return/${req.params.ref}`);
});

// Server-to-server notification. We never trust the payload — we re-query OPay.
router.post('/opay/webhook', async (req, res) => {
  try {
    const payload = (req.body && (req.body.payload || req.body)) || {};
    const ref = payload.reference;
    if (ref) {
      const o = db.prepare('SELECT * FROM orders WHERE reference = ?').get(String(ref));
      if (o) await verify(o);
    }
  } catch (e) { console.error('OPay webhook error', e); }
  res.json({ code: '00000', message: 'SUCCESSFUL' });
});

module.exports = router;
