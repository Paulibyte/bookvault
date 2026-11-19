// OPay Checkout (Cashier) integration — https://documentation.opaycheckout.com/cashier-create
const crypto = require('crypto');

const BASE = process.env.OPAY_MODE === 'live'
  ? 'https://liveapi.opaycheckout.com'
  : 'https://testapi.opaycheckout.com';

function configured() {
  return !!(process.env.OPAY_MERCHANT_ID && process.env.OPAY_PUBLIC_KEY && process.env.OPAY_SECRET_KEY);
}

async function post(pathname, body, authorization) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      MerchantId: process.env.OPAY_MERCHANT_ID,
      Authorization: 'Bearer ' + authorization,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return json;
}

/** Create a hosted checkout. Amount in kobo (OPay uses the smallest currency unit). Returns cashierUrl. */
async function createCashier({ reference, amountKobo, user, productName, returnUrl, callbackUrl, cancelUrl }) {
  const body = {
    country: 'NG',
    reference,
    amount: { total: amountKobo, currency: 'NGN' },
    returnUrl,
    callbackUrl,
    cancelUrl,
    expireAt: 30,
    userInfo: {
      userEmail: user.email,
      userId: String(user.id),
      userMobile: (user.phone || '').replace(/\s+/g, ''),
      userName: user.full_name,
    },
    product: { name: productName.slice(0, 100), description: productName.slice(0, 200) },
  };
  const json = await post('/api/v1/international/cashier/create', body, process.env.OPAY_PUBLIC_KEY);
  if (json.code !== '00000' || !json.data || !json.data.cashierUrl) {
    throw new Error('OPay: ' + (json.message || 'could not start payment'));
  }
  return json.data;
}

/** Query the true payment status from OPay (signed with HMAC-SHA512 of the body). */
async function queryStatus(reference) {
  const payload = JSON.stringify({ country: 'NG', reference });
  const sig = crypto.createHmac('sha512', process.env.OPAY_SECRET_KEY).update(payload).digest('hex');
  const json = await post('/api/v1/international/cashier/status', payload, sig);
  if (json.code !== '00000' || !json.data) return { status: 'UNKNOWN', raw: json };
  return { status: json.data.status, amount: json.data.amount, orderNo: json.data.orderNo, raw: json };
}

module.exports = { configured, createCashier, queryStatus, BASE };
