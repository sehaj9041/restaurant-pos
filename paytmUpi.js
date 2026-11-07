// Paytm Dynamic QR for the self-order kiosk.
// Kiosk -> /api/upi/create (order is NOT created yet, only parked in upi_payments) -> customer scans QR.
// Payment is confirmed by Paytm's callback and/or by polling Paytm's Transaction Status API.
// Only after a verified TXN_SUCCESS (same orderId + same amount) the real POS order is created, already marked paid.
//
// Env: PAYTM_ENV = stage | prod | mock (default stage), PAYTM_MID, PAYTM_KEY, optional PAYTM_POS_ID, PAYTM_CLIENT_ID.
// Own-QR mode: set PAYTM_UPI_ID (merchant UPI id, e.g. xxxx@ptys) and the QR is built here as a upi://pay link with our order id in tr/tn
// (no Paytm QR API needed). Paytm then echoes that id back as ORDERID in its callback, which is checked (checksum or Status API) before the order is made.
// Optional PAYTM_PAYEE_NAME. PAYTM_TRUST_CALLBACK=1 = accept matching callbacks without any signature (unsafe, see confirmFromCallback). Staff can also confirm a payment by hand from the POS (see /api/upi/pending + /api/upi/manual-confirm).
const express = require('express');
const crypto = require('crypto');
const PaytmChecksum = require('paytmchecksum');
const QRCode = require('qrcode');

const QR_WINDOW_MS = 5 * 60 * 1000;
const STATUS_THROTTLE_MS = 2000;

const paytmEnv = () => String(process.env.PAYTM_ENV || 'stage').toLowerCase();
const isMock = () => paytmEnv() === 'mock';
if (paytmEnv() !== 'prod') console.warn('[PAYTM] PAYTM_ENV=' + paytmEnv() + ' (prod nahi hai). Live payments ke liye PAYTM_ENV=prod set karo.');
const host = () => (paytmEnv() === 'prod' ? 'https://securegw.paytm.in' : 'https://securegw-stage.paytm.in');
const selfQr = () => !!process.env.PAYTM_UPI_ID && !isMock();
const configured = () => isMock() || selfQr() || (process.env.PAYTM_MID && process.env.PAYTM_KEY);
// Optional: PAYTM_CALLBACK_SECRET. Without the merchant key a callback cannot be signature-checked, so Paytm can be given the callback URL with ?s=<secret>; only a call carrying it is trusted.
const secretOk = (given) => { const a = Buffer.from(String(given || '')), b = Buffer.from(String(process.env.PAYTM_CALLBACK_SECRET || '')); return b.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b); };
const upiLink = (amount, orderId) => 'upi://pay?pa=' + process.env.PAYTM_UPI_ID + '&pn=' + encodeURIComponent(process.env.PAYTM_PAYEE_NAME || 'Vishal Foodiez') +
  '&am=' + Number(amount).toFixed(2) + '&cu=INR&tn=' + orderId + '&tr=' + orderId;
// Paytm signs its callback with the merchant key: CHECKSUMHASH over all other fields
function callbackChecksumOk(params) {
  try {
    const p = { ...params }, cs = p.CHECKSUMHASH;
    if (!cs || !process.env.PAYTM_KEY) return false;
    return !!PaytmChecksum.verifySignature(p, process.env.PAYTM_KEY, cs);
  } catch (e) { return false; }
}

async function paytmPost(path, body, head = {}) {
  const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), process.env.PAYTM_KEY);
  const r = await fetch(host() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ head: { ...head, signature }, body })
  });
  const json = await r.json();
  return json.body || {};
}

// Same maths as POST /api/orders (5% GST on subtotal), so the QR amount equals the order total.
function subtotalOf(p) {
  let subtotal = Number(p.subtotal) || 0;
  if (!subtotal && Array.isArray(p.items)) subtotal = p.items.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);
  return subtotal;
}
function payableAmount(p) {
  const subtotal = subtotalOf(p);
  // "No GST" (is_exempt) items par tax nahi lagta
  const taxable = Array.isArray(p.items) && p.items.length
    ? p.items.reduce((s, i) => Number(i.is_exempt) ? s : s + Number(i.price) * Number(i.qty), 0)
    : subtotal;
  // GST is charged after the discount, exactly like createOrderHandler
  const disc = Math.min(Math.max(0, Number(p.discount) || 0), subtotal);
  const taxAfterDiscount = subtotal > 0 ? Math.max(0, taxable - disc * taxable / subtotal) : 0;
  const gst = Math.round((taxAfterDiscount * 5) / 100);
  return Math.round(subtotal + gst - disc);
}

function register(app, { dbAllAsync, createOrderHandler, computeDiscount, discountPasswordOk }) {
  dbAllAsync(`CREATE TABLE IF NOT EXISTS upi_payments (
    id SERIAL PRIMARY KEY,
    paytm_order_id TEXT UNIQUE,
    amount NUMERIC,
    payload TEXT,
    status TEXT DEFAULT 'PENDING',
    pos_order_id INTEGER,
    token_no INTEGER,
    txn_id TEXT,
    created_ms BIGINT,
    checked_ms BIGINT DEFAULT 0
  )`, []).catch(e => console.error('upi_payments table error:', e.message));

  dbAllAsync(`CREATE TABLE IF NOT EXISTS paytm_callback_log (
    id SERIAL PRIMARY KEY,
    content_type TEXT,
    body TEXT,
    created_ms BIGINT
  )`, []).catch(e => console.error('paytm_callback_log table error:', e.message));

  const mockPaid = new Set();
  const getRow = async (paytmOrderId) => (await dbAllAsync('SELECT * FROM upi_payments WHERE paytm_order_id = ?', [paytmOrderId]))[0];

  function runCreateOrder(payload) {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { return this.statusCode >= 400 ? reject(new Error((b && b.error) || 'order failed')) : resolve(b); }
      };
      // _promo_verified is only ever set by /api/upi/create after the redeem code was checked and spent (a client value is stripped there)
      Promise.resolve(createOrderHandler({ body: payload, promoVerified: !!payload._promo_verified }, res)).catch(reject);
    });
  }

  // Creates the paid POS order exactly once, even if callback and polling arrive together.
  async function finalize(row, txnId) {
    const claimed = await dbAllAsync(
      "UPDATE upi_payments SET status = 'FINALIZING', txn_id = ? WHERE id = ? AND status IN ('PENDING','CANCELLED','EXPIRED','ORDER_FAILED') RETURNING id",
      [txnId || '', row.id]);
    if (!claimed.length) return;
    try {
      const o = await runCreateOrder({ ...JSON.parse(row.payload), payment_mode: 'UPI', is_kiosk: true, is_hold: false });
      await dbAllAsync("UPDATE upi_payments SET status = 'PAID', pos_order_id = ?, token_no = ? WHERE id = ? RETURNING id", [o.orderId, o.token_no, row.id]);
      console.log(`[UPI PAID] ${row.paytm_order_id} Rs.${row.amount} -> POS order #${o.orderId}`);
    } catch (e) {
      await dbAllAsync("UPDATE upi_payments SET status = 'ORDER_FAILED' WHERE id = ? RETURNING id", [row.id]);
      console.error(`[UPI ERROR] Paid but order creation failed for ${row.paytm_order_id} (txn ${txnId}):`, e.message);
    }
  }

  // Asks Paytm (server to server) whether this order is paid. This is the only thing that can mark it paid.
  async function checkWithPaytm(row) {
    if (row.status === 'PAID' || row.status === 'FINALIZING') return;
    if (!isMock() && !(process.env.PAYTM_MID && process.env.PAYTM_KEY)) return; // own-QR mode without MID: callback / staff confirm only
    let success = false, txnId = '';
    if (isMock()) {
      success = mockPaid.has(row.paytm_order_id);
    } else {
      const b = await paytmPost('/v3/order/status', { mid: process.env.PAYTM_MID, orderId: row.paytm_order_id });
      success = b.resultInfo && b.resultInfo.resultStatus === 'TXN_SUCCESS'
        && String(b.orderId) === row.paytm_order_id
        && Math.abs(Number(b.txnAmount) - Number(row.amount)) < 0.005;
      txnId = b.txnId || '';
      if (b.resultInfo && b.resultInfo.resultStatus === 'TXN_SUCCESS' && !success) {
        console.error(`[UPI MISMATCH] ${row.paytm_order_id}: paytm amount ${b.txnAmount} vs expected ${row.amount}`);
      }
    }
    await dbAllAsync('UPDATE upi_payments SET checked_ms = ? WHERE id = ? RETURNING id', [Date.now(), row.id]);
    if (success) await finalize(row, txnId);
  }

  // Own-QR mode: a callback is only believed when it is a success for this order id, this amount and this merchant, AND it is authentic
  // (valid CHECKSUMHASH, or Paytm's own Status API says the same). Anything else is left for Paytm's Status API / the staff to confirm.
  async function confirmFromCallback(row, b, trusted) {
    if (row.status === 'PAID' || row.status === 'FINALIZING') return;
    if (String(b.STATUS) !== 'TXN_SUCCESS') return;
    const amountOk = Math.abs(Number(b.TXNAMOUNT) - Number(row.amount)) < 0.005;
    const midOk = !process.env.PAYTM_MID || String(b.MID) === process.env.PAYTM_MID;
    if (!amountOk || !midOk) { console.error(`[UPI MISMATCH] ${row.paytm_order_id}: callback amount ${b.TXNAMOUNT} mid ${b.MID} vs expected ${row.amount}`); return; }
    if (callbackChecksumOk(b)) { console.log(`[UPI CALLBACK] ${row.paytm_order_id} checksum ok`); return finalize(row, b.TXNID); }
    if (trusted) { console.log(`[UPI CALLBACK] ${row.paytm_order_id} accepted via callback secret`); return finalize(row, b.TXNID); }
    // Explicit owner opt-in (PAYTM_TRUST_CALLBACK=1): no key / secret, so anyone who knows the order id could fake this call. Txn id is logged to check against the Paytm app.
    if (process.env.PAYTM_TRUST_CALLBACK === '1') { console.warn(`[UPI CALLBACK] ${row.paytm_order_id} accepted UNVERIFIED (PAYTM_TRUST_CALLBACK=1), txn ${b.TXNID}`); return finalize(row, b.TXNID); }
    console.error(`[UPI CALLBACK] ${row.paytm_order_id} not verifiable (no valid checksum / secret). Staff can confirm it from the POS; trying Status API`);
    await checkWithPaytm(row);
  }

  app.post('/api/upi/create', async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: 'UPI abhi configure nahi hai. Staff se help lein.' });
      const p = req.body || {};
      if (!Array.isArray(p.items) || !p.items.length) return res.status(400).json({ error: 'Cart khali hai' });
      // The discount is never taken from the client: only a loyalty-points redemption (code checked and spent right now) can lower the amount
      delete p._promo_verified;
      p.discount = 0;
      const pts = Math.floor(Number(p.points_redeem) || 0);
      if (pts > 0 && computeDiscount) {
        const promo = await computeDiscount({ subtotal: subtotalOf(p), phone: p.customer_phone, points_redeem: pts, points_code: p.points_code, staff_override: false, consume: true });
        if (promo.error) return res.status(400).json({ error: promo.error });
        p.discount = promo.discount; p.points_redeem = promo.pointsRedeemed; p._promo_verified = true;
      } else { p.points_redeem = 0; }
      delete p.points_code; delete p.coupon_code; delete p.is_complimentary; delete p.auth_password; delete p.discount_reason;
      const amount = payableAmount(p);
      if (!(amount > 0)) return res.status(400).json({ error: 'Invalid amount' });

      const paytmOrderId = 'KIOSK' + Date.now() + crypto.randomBytes(2).toString('hex');
      let qrData;
      if (isMock()) {
        qrData = `upi://pay?pa=mock@paytm&pn=MockStore&am=${amount.toFixed(2)}&tr=${paytmOrderId}&cu=INR`;
      } else if (selfQr()) {
        qrData = upiLink(amount, paytmOrderId);
      } else {
        const b = await paytmPost('/paymentservices/qr/create', {
          mid: process.env.PAYTM_MID,
          orderId: paytmOrderId,
          amount: amount.toFixed(2),
          businessType: 'UPI_QR_CODE',
          posId: process.env.PAYTM_POS_ID || 'KIOSK1'
        }, { clientId: process.env.PAYTM_CLIENT_ID || 'C11', version: 'v1' });
        if (!b.qrData) {
          console.error('[UPI] QR create failed:', JSON.stringify(b.resultInfo || b));
          return res.status(502).json({ error: 'QR nahi ban paaya. Dobara try karein ya Cash/Counter chunein.' });
        }
        qrData = b.qrData;
      }

      await dbAllAsync(
        'INSERT INTO upi_payments (paytm_order_id, amount, payload, created_ms) VALUES (?, ?, ?, ?) RETURNING id',
        [paytmOrderId, amount, JSON.stringify(p), Date.now()]);
      res.json({ paytmOrderId, amount, expiresInSec: QR_WINDOW_MS / 1000, qrImage: await QRCode.toDataURL(qrData, { margin: 1, width: 420 }), mock: isMock() });
    } catch (e) {
      console.error('[UPI] create error:', e.message);
      res.status(500).json({ error: 'QR nahi ban paaya. Dobara try karein.' });
    }
  });

  app.get('/api/upi/status/:id', async (req, res) => {
    try {
      let row = await getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'PAID' && Date.now() - Number(row.checked_ms) > STATUS_THROTTLE_MS) {
        await checkWithPaytm(row);
        row = await getRow(req.params.id);
      }
      if (row.status === 'PAID') return res.json({ status: 'PAID', orderId: row.pos_order_id, token_no: row.token_no });
      const expired = Date.now() - Number(row.created_ms) > QR_WINDOW_MS || row.status === 'CANCELLED';
      res.json({ status: expired ? 'EXPIRED' : 'PENDING' });
    } catch (e) {
      console.error('[UPI] status error:', e.message);
      res.json({ status: 'PENDING' });
    }
  });

  // Customer pressed Back / QR timed out. Final check first so a payment made at the last second is not lost.
  app.post('/api/upi/cancel', async (req, res) => {
    try {
      let row = await getRow(req.body && req.body.paytmOrderId);
      if (!row) return res.json({ status: 'EXPIRED' });
      if (row.status !== 'PAID') { await checkWithPaytm(row); row = await getRow(row.paytm_order_id); }
      if (row.status === 'PAID') return res.json({ status: 'PAID', orderId: row.pos_order_id, token_no: row.token_no });
      await dbAllAsync("UPDATE upi_payments SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING' RETURNING id", [row.id]);
      res.json({ status: 'EXPIRED' });
    } catch (e) {
      res.json({ status: 'EXPIRED' });
    }
  });

  // ---- POS staff: kiosk QR payments that are not confirmed yet (list is public, it holds no personal data) ----
  app.get('/api/upi/pending', async (req, res) => {
    try {
      const rows = await dbAllAsync("SELECT paytm_order_id, amount, status, payload, created_ms FROM upi_payments WHERE status IN ('PENDING','CANCELLED','EXPIRED','ORDER_FAILED') AND created_ms > ? ORDER BY created_ms DESC LIMIT 30", [Date.now() - 30 * 60 * 1000]);
      res.json(rows.map(r => {
        let items = [];
        try { items = (JSON.parse(r.payload).items || []).map(i => ({ name: String(i.name || '').slice(0, 60), qty: Number(i.qty) || 1 })); } catch (e) { /* no items */ }
        return { id: r.paytm_order_id, amount: Number(r.amount), status: r.status, created_ms: Number(r.created_ms), items };
      }));
    } catch (e) { res.json([]); }
  });

  // Staff saw the money in the Paytm app / soundbox: create the paid order by hand. Needs the staff (discount) password, so a kiosk customer cannot call it.
  const manualFails = new Map(); // ip -> { n, until }
  app.post('/api/upi/manual-confirm', async (req, res) => {
    try {
      const ip = req.ip || 'x', f = manualFails.get(ip);
      if (f && f.until > Date.now()) return res.status(429).json({ error: 'Bahut galat password. Thodi der baad try karein.' });
      if (!discountPasswordOk || !discountPasswordOk(req.body && req.body.auth_password)) {
        const n = (f && !(f.until && f.until <= Date.now()) ? f.n : 0) + 1;
        manualFails.set(ip, { n, until: n >= 8 ? Date.now() + 60000 : 0 });
        return res.status(403).json({ error: 'Staff password galat hai' });
      }
      manualFails.delete(ip);
      const id = String((req.body && req.body.paytmOrderId) || '');
      let row = await getRow(id);
      if (!row) return res.status(404).json({ error: 'Ye payment nahi mili' });
      if (row.status !== 'PAID') { await finalize(row, 'MANUAL'); row = await getRow(id); console.log(`[UPI MANUAL CONFIRM] ${id} Rs.${row.amount} by staff`); }
      if (row.status === 'PAID') return res.json({ ok: true, orderId: row.pos_order_id, token_no: row.token_no });
      res.status(409).json({ error: 'Order nahi ban paaya (status ' + row.status + '). Dobara try karein.' });
    } catch (e) {
      console.error('[UPI] manual confirm error:', e.message);
      res.status(500).json({ error: 'Confirm nahi ho paaya' });
    }
  });

  // Paytm webhook. The payload is NOT trusted: it only tells us which order to re-check via the Status API.
  app.post('/api/paytm/callback', express.urlencoded({ extended: true }), express.text({ type: '*/*' }), async (req, res) => {
    try {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b && typeof b === 'object' ? b : {};
      // Keep every raw callback so the real Paytm payload format can be inspected (static-QR flow needs it).
      const raw = (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})).slice(0, 5000);
      console.log('[PAYTM CALLBACK RAW]', req.headers['content-type'], raw);
      // Optional: keep an older software working by relaying every callback to its URL (set PAYTM_FORWARD_URL).
      if (process.env.PAYTM_FORWARD_URL) {
        fetch(process.env.PAYTM_FORWARD_URL, { method: 'POST', headers: { 'Content-Type': String(req.headers['content-type'] || 'application/json') }, body: typeof req.body === 'string' ? req.body : (/json/i.test(req.headers['content-type'] || '') ? JSON.stringify(req.body || {}) : new URLSearchParams(req.body || {}).toString()) })
          .catch(e => console.error('[PAYTM CALLBACK] forward failed:', e.message));
      }
      dbAllAsync('INSERT INTO paytm_callback_log (content_type, body, created_ms) VALUES (?, ?, ?) RETURNING id', [String(req.headers['content-type'] || ''), raw, Date.now()]).catch(() => {});
      const orderId = b.ORDERID || b.orderId || b.order_id || (b.body && b.body.orderId);
      const row = orderId && await getRow(String(orderId));
      if (row && selfQr()) await confirmFromCallback(row, b, secretOk(req.query && req.query.s));
      else if (row) await checkWithPaytm(row);
      else console.log('[PAYTM CALLBACK] unknown order', orderId);
    } catch (e) {
      console.error('[PAYTM CALLBACK] error:', e.message);
    }
    res.status(200).send('OK');
  });

  // View recent raw callbacks: GET /api/paytm/callback-log?key=<PAYTM_LOG_KEY>. Disabled unless PAYTM_LOG_KEY is set.
  app.get('/api/paytm/callback-log', async (req, res) => {
    if (!process.env.PAYTM_LOG_KEY || req.query.key !== process.env.PAYTM_LOG_KEY) return res.status(404).end();
    res.json(await dbAllAsync('SELECT * FROM paytm_callback_log ORDER BY id DESC LIMIT 50', []));
  });

  // Local testing without Paytm credentials: PAYTM_ENV=mock, then POST /api/upi/mock-pay/<paytmOrderId>.
  if (isMock()) {
    app.post('/api/upi/mock-pay/:id', (req, res) => { mockPaid.add(req.params.id); res.json({ ok: true }); });
  }
}

module.exports = { register };
