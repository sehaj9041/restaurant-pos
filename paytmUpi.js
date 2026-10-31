// Paytm Dynamic QR for the self-order kiosk.
// Kiosk -> /api/upi/create (order is NOT created yet, only parked in upi_payments) -> customer scans QR.
// Payment is confirmed by Paytm's callback and/or by polling Paytm's Transaction Status API.
// Only after a verified TXN_SUCCESS (same orderId + same amount) the real POS order is created, already marked paid.
//
// Env: PAYTM_ENV = stage | prod | mock (default stage), PAYTM_MID, PAYTM_KEY, optional PAYTM_POS_ID, PAYTM_CLIENT_ID.
const express = require('express');
const crypto = require('crypto');
const PaytmChecksum = require('paytmchecksum');
const QRCode = require('qrcode');

const QR_WINDOW_MS = 5 * 60 * 1000;
const STATUS_THROTTLE_MS = 2000;

const paytmEnv = () => String(process.env.PAYTM_ENV || 'stage').toLowerCase();
const isMock = () => paytmEnv() === 'mock';
const host = () => (paytmEnv() === 'prod' ? 'https://securegw.paytm.in' : 'https://securegw-stage.paytm.in');
const configured = () => isMock() || (process.env.PAYTM_MID && process.env.PAYTM_KEY);

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
function payableAmount(p) {
  let subtotal = Number(p.subtotal) || 0;
  if (!subtotal && Array.isArray(p.items)) subtotal = p.items.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);
  // "No GST" (is_exempt) items par tax nahi lagta
  const taxable = Array.isArray(p.items) && p.items.length
    ? p.items.reduce((s, i) => Number(i.is_exempt) ? s : s + Number(i.price) * Number(i.qty), 0)
    : subtotal;
  const gst = Math.round((taxable * 5) / 100);
  return Math.round(subtotal + gst - (Number(p.discount) || 0));
}

function register(app, { dbAllAsync, createOrderHandler }) {
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
      Promise.resolve(createOrderHandler({ body: payload }, res)).catch(reject);
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

  app.post('/api/upi/create', async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: 'UPI abhi configure nahi hai. Staff se help lein.' });
      const p = req.body || {};
      if (!Array.isArray(p.items) || !p.items.length) return res.status(400).json({ error: 'Cart khali hai' });
      const amount = payableAmount(p);
      if (!(amount > 0)) return res.status(400).json({ error: 'Invalid amount' });

      const paytmOrderId = 'KIOSK' + Date.now() + crypto.randomBytes(2).toString('hex');
      let qrData;
      if (isMock()) {
        qrData = `upi://pay?pa=mock@paytm&pn=MockStore&am=${amount.toFixed(2)}&tr=${paytmOrderId}&cu=INR`;
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

  // Paytm webhook. The payload is NOT trusted: it only tells us which order to re-check via the Status API.
  app.post('/api/paytm/callback', express.urlencoded({ extended: true }), express.text({ type: '*/*' }), async (req, res) => {
    try {
      const b = typeof req.body === 'string' ? {} : (req.body || {});
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
      if (row) await checkWithPaytm(row);
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
