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

const STATUS_THROTTLE_MS = 2000;

const isPaid = (st) => st === 'PAID';

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

  dbAllAsync('ALTER TABLE upi_payments ADD COLUMN IF NOT EXISTS paid_ms BIGINT DEFAULT 0', []).catch(e => console.error('upi_payments paid_ms error:', e.message));

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
      // autoAccept: the money is already confirmed, so the kiosk order skips the POS "Accept" step
      Promise.resolve(createOrderHandler({ body: payload, promoVerified: !!payload._promo_verified, autoAccept: true }, res)).catch(reject);
    });
  }

  // A POS / rider collection is tied to the order (or the customer's khata) the QR was made for. When Paytm confirms, the money is applied there by the
  // server itself, so it still lands on the right order even if the screen that showed the QR was closed before the payment came in.
  async function applyCollect(parked, amount) {
    if (parked.order_id) {
      await dbAllAsync(`UPDATE orders SET paid_amount = LEAST(total, COALESCE(paid_amount, 0) + ?::numeric),
          payment_mode = CASE WHEN COALESCE(paid_amount, 0) > 0 AND UPPER(COALESCE(payment_mode, '')) <> 'UPI' THEN 'SPLIT' ELSE 'UPI' END,
          status = CASE WHEN UPPER(status) = 'KOT_DONE' AND COALESCE(paid_amount, 0) + ?::numeric >= total THEN 'DISPATCHED'
                        WHEN UPPER(status) = 'DUE_PENDING' AND COALESCE(paid_amount, 0) + ?::numeric >= total THEN 'COMPLETED'   -- a khata (Due) order paid in full leaves the Due list, like "settle customer"
                        ELSE status END
        WHERE id = ? AND UPPER(COALESCE(status, '')) NOT IN ('VOID', 'CANCELLED', 'COMPLETED') RETURNING id`, [amount, amount, amount, parked.order_id]);
    } else if (parked.settle_customer) {
      await dbAllAsync(`UPDATE orders SET status = 'COMPLETED', payment_mode = 'UPI', paid_amount = total
        WHERE COALESCE(NULLIF(customer_phone, ''), 'WALK-IN') = ? AND status NOT IN ('COMPLETED', 'DISPATCHED', 'VOID')
          AND (UPPER(payment_mode) = 'DUE' OR status = 'DUE_PENDING' OR (UPPER(payment_mode) LIKE '%PARTIAL%' AND (total - COALESCE(paid_amount, 0)) > 0)) RETURNING id`, [parked.settle_customer]);
    }
  }

  // Creates the paid POS order exactly once, even if callback and polling arrive together.
  async function finalize(row, txnId) {
    const claimed = await dbAllAsync(
      "UPDATE upi_payments SET status = 'FINALIZING', txn_id = ? WHERE id = ? AND status IN ('PENDING','CANCELLED','EXPIRED','ORDER_FAILED') RETURNING id",
      [txnId || '', row.id]);
    if (!claimed.length) return;
    let parked = {}; try { parked = JSON.parse(row.payload); } catch (e) { /* kiosk payload below will fail the same way */ }
    if (parked._collect) {
      try { await applyCollect(parked, Number(row.amount)); }
      catch (e) { await dbAllAsync("UPDATE upi_payments SET status = 'ORDER_FAILED' WHERE id = ? RETURNING id", [row.id]); console.error(`[UPI ERROR] Paid but could not be applied for ${row.paytm_order_id}:`, e.message); return; }
      await dbAllAsync("UPDATE upi_payments SET status = 'PAID', paid_ms = ? WHERE id = ? RETURNING id", [Date.now(), row.id]);
      console.log(`[UPI PAID] ${row.paytm_order_id} Rs.${row.amount} (POS / rider collection${parked.order_id ? ' -> order #' + parked.order_id : parked.settle_customer ? ' -> khata ' + parked.settle_customer : ''})`);
      return;
    }
    if (parked._web_order) {
      // Website order: it was saved hidden (HOLD) before the QR / UPI link was shown. Paid now -> staff approval, like a verified Razorpay payment.
      // Also revives an order the customer backed out of but still paid for.
      try {
        await dbAllAsync("UPDATE orders SET status = 'NEEDS_APPROVAL', payment_mode = 'UPI', paid_amount = total WHERE id = ? AND UPPER(status) IN ('HOLD', 'VOID') RETURNING id", [parked._web_order]);
        await dbAllAsync("UPDATE upi_payments SET status = 'PAID', pos_order_id = ?, token_no = ?, paid_ms = ? WHERE id = ? RETURNING id", [parked._web_order, parked.token_no || null, Date.now(), row.id]);
        console.log(`[UPI PAID] ${row.paytm_order_id} Rs.${row.amount} -> website order #${parked._web_order}`);
      } catch (e) {
        await dbAllAsync("UPDATE upi_payments SET status = 'ORDER_FAILED' WHERE id = ? RETURNING id", [row.id]);
        console.error(`[UPI ERROR] Paid but website order could not be updated for ${row.paytm_order_id} (txn ${txnId}):`, e.message);
      }
      return;
    }
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
    if (isPaid(row.status) || row.status === 'FINALIZING') return;
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
    if (isPaid(row.status) || row.status === 'FINALIZING') return;
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

  // POS: QR payments that a rider's app collected and Paytm confirmed (polled by the POS for its notification + sound). First call (no `since`) only returns the server clock.
  app.get('/api/upi/rider-paid', async (req, res) => {
    try {
      const since = Number(req.query.since);
      if (!(since > 0)) return res.json({ now: Date.now(), items: [] });
      const rows = await dbAllAsync("SELECT paytm_order_id, amount, payload, paid_ms FROM upi_payments WHERE status = 'PAID' AND paid_ms > ? AND payload LIKE '%\"source\":\"rider\"%' ORDER BY paid_ms LIMIT 20", [since]);
      const items = [];
      for (const r of rows) {
        let oid = 0; try { oid = Math.floor(Number(JSON.parse(r.payload).order_id)); } catch (e) { /* none */ }
        const o = oid > 0 ? (await dbAllAsync('SELECT id, token_no, customer_name, rider_name FROM orders WHERE id = ?', [oid]))[0] : null;
        items.push({ id: r.paytm_order_id, amount: Number(r.amount), paid_ms: Number(r.paid_ms), order_id: oid || null, token_no: o ? o.token_no : null, customer: o ? o.customer_name : '', rider: o ? o.rider_name : '' });
      }
      res.json({ now: Math.max(Date.now(), ...items.map(i => i.paid_ms)), items });
    } catch (e) { res.json({ now: Date.now(), items: [] }); }
  });

  // The text inside the QR for `amount`, tagged with our order id (mock / own-QR / Paytm Dynamic QR API). null = Paytm refused.
  async function qrDataFor(amount, paytmOrderId, posId) {
    if (isMock()) return `upi://pay?pa=mock@paytm&pn=MockStore&am=${Number(amount).toFixed(2)}&tr=${paytmOrderId}&cu=INR`;
    if (selfQr()) return upiLink(amount, paytmOrderId);
    const b = await paytmPost('/paymentservices/qr/create', {
      mid: process.env.PAYTM_MID,
      orderId: paytmOrderId,
      amount: Number(amount).toFixed(2),
      businessType: 'UPI_QR_CODE',
      posId
    }, { clientId: process.env.PAYTM_CLIENT_ID || 'C11', version: 'v1' });
    if (!b.qrData) { console.error('[UPI] QR create failed:', JSON.stringify(b.resultInfo || b)); return null; }
    return b.qrData;
  }

  // POS / rider app: a QR for an amount that is collected on an order which already exists (or is being placed). No order is made here:
  // the row is only a "was this QR paid" flag that the staff / rider screen waits for, then it carries on with its normal payment save.
  const collectAsks = new Map(); // ip -> timestamps
  app.post('/api/upi/collect', async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: 'UPI abhi configure nahi hai.' });
      const ip = req.ip || 'x', now = Date.now(), asks = (collectAsks.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
      if (asks.length >= 40) return res.status(429).json({ error: 'Bahut zyada QR maange. Thodi der baad try karein.' });
      asks.push(now); collectAsks.set(ip, asks);
      const amount = Math.round((Number(req.body && req.body.amount) || 0) * 100) / 100;
      if (!(amount >= 1) || amount > 100000) return res.status(400).json({ error: 'Amount sahi nahi hai' });
      const label = String((req.body && req.body.label) || '').slice(0, 60);
      const link = {};
      const oid = Math.floor(Number(req.body && req.body.order_id));
      if (oid > 0) {
        if (!(await dbAllAsync('SELECT id FROM orders WHERE id = ?', [oid])).length) return res.status(404).json({ error: 'Order nahi mila' });
        link.order_id = oid;
      } else if (req.body && /^\d{6,15}$/.test(String(req.body.settle_customer || ''))) link.settle_customer = String(req.body.settle_customer);
      if (req.body && req.body.source === 'rider') link.source = 'rider';   // the POS gets a notification when a rider's QR is paid
      const paytmOrderId = 'COL' + now + crypto.randomBytes(2).toString('hex');
      const qrData = await qrDataFor(amount, paytmOrderId, process.env.PAYTM_COLLECT_POS_ID || 'POS1');
      if (!qrData) return res.status(502).json({ error: 'QR nahi ban paaya.' });
      await dbAllAsync('INSERT INTO upi_payments (paytm_order_id, amount, payload, created_ms) VALUES (?, ?, ?, ?) RETURNING id',
        [paytmOrderId, amount, JSON.stringify({ _collect: true, label, ...link }), now]);
      res.json({ paytmOrderId, amount, qrImage: await QRCode.toDataURL(qrData, { margin: 1, width: 420 }), mock: isMock() });
    } catch (e) {
      console.error('[UPI] collect error:', e.message);
      res.status(500).json({ error: 'QR nahi ban paaya.' });
    }
  });

  // ---- Website checkout: pay by Paytm UPI (from this phone via UPI app link, or from another phone via QR) ----
  app.get('/api/upi/web-config', (req, res) => res.json({ enabled: !!configured() }));

  function runCreateWebOrder(payload) {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { return this.statusCode >= 400 ? reject(Object.assign(new Error((b && b.error) || 'order failed'), { userFacing: true })) : resolve(b); }
      };
      Promise.resolve(createOrderHandler({ body: payload }, res)).catch(reject);
    });
  }

  app.post('/api/upi/web-create', async (req, res) => {
    let orderId;
    try {
      if (!configured()) return res.status(503).json({ error: 'UPI abhi available nahi hai' });
      // saved hidden (HOLD) with the server-side total; it only reaches staff once Paytm confirms the payment
      const o = await runCreateWebOrder({ ...(req.body || {}), pay_online: true });
      orderId = o.orderId;
      const total = Number((await dbAllAsync('SELECT total FROM orders WHERE id = ?', [orderId]))[0].total);
      if (!(total > 0)) throw new Error('invalid total');
      const paytmOrderId = 'WEB' + Date.now() + crypto.randomBytes(2).toString('hex');
      const qrData = await qrDataFor(total, paytmOrderId, process.env.PAYTM_POS_ID || 'WEB1');
      if (!qrData) throw new Error('QR nahi ban paaya');
      await dbAllAsync('INSERT INTO upi_payments (paytm_order_id, amount, payload, created_ms) VALUES (?, ?, ?, ?) RETURNING id',
        [paytmOrderId, total, JSON.stringify({ _web_order: orderId, token_no: o.token_no }), Date.now()]);
      res.json({ paytmOrderId, amount: total, upiLink: qrData, qrImage: await QRCode.toDataURL(qrData, { margin: 1, width: 420 }), orderId, token_no: o.token_no, profile_token: o.profile_token, mock: isMock() });
    } catch (e) {
      console.error('[UPI] web-create error:', e.message);
      if (orderId) dbAllAsync("UPDATE orders SET status = 'VOID' WHERE id = ? AND status = 'HOLD' RETURNING id", [orderId]).catch(() => {});
      res.status(e.userFacing ? 400 : 500).json({ error: e.userFacing ? e.message : 'Payment shuru nahi ho paaya. Dobara try karein.' });
    }
  });

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
      const qrData = await qrDataFor(amount, paytmOrderId, process.env.PAYTM_POS_ID || 'KIOSK1');
      if (!qrData) return res.status(502).json({ error: 'QR nahi ban paaya. Dobara try karein ya Cash/Counter chunein.' });

      await dbAllAsync(
        'INSERT INTO upi_payments (paytm_order_id, amount, payload, created_ms) VALUES (?, ?, ?, ?) RETURNING id',
        [paytmOrderId, amount, JSON.stringify(p), Date.now()]);
      res.json({ paytmOrderId, amount, qrImage: await QRCode.toDataURL(qrData, { margin: 1, width: 420 }), mock: isMock() });
    } catch (e) {
      console.error('[UPI] create error:', e.message);
      res.status(500).json({ error: 'QR nahi ban paaya. Dobara try karein.' });
    }
  });

  app.get('/api/upi/status/:id', async (req, res) => {
    try {
      let row = await getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (!isPaid(row.status) && Date.now() - Number(row.checked_ms) > STATUS_THROTTLE_MS) {
        await checkWithPaytm(row);
        row = await getRow(req.params.id);
      }
      if (isPaid(row.status)) return res.json({ status: 'PAID', orderId: row.pos_order_id, token_no: row.token_no });
      res.json({ status: row.status === 'CANCELLED' ? 'EXPIRED' : 'PENDING' });
    } catch (e) {
      console.error('[UPI] status error:', e.message);
      res.json({ status: 'PENDING' });
    }
  });

  // Customer pressed Back / the screen closed. Final check first so a payment made at the last second is not lost.
  app.post('/api/upi/cancel', async (req, res) => {
    try {
      let row = await getRow(req.body && req.body.paytmOrderId);
      if (!row) return res.json({ status: 'EXPIRED' });
      if (!isPaid(row.status)) { await checkWithPaytm(row); row = await getRow(row.paytm_order_id); }
      if (isPaid(row.status)) return res.json({ status: 'PAID', orderId: row.pos_order_id, token_no: row.token_no });
      const cancelled = await dbAllAsync("UPDATE upi_payments SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING' RETURNING payload", [row.id]);
      try {
        const pk = cancelled.length ? JSON.parse(cancelled[0].payload || '{}') : {};
        if (pk._web_order) await dbAllAsync("UPDATE orders SET status = 'VOID' WHERE id = ? AND status = 'HOLD' RETURNING id", [pk._web_order]);
      } catch (e) { /* best effort */ }
      res.json({ status: 'EXPIRED' });
    } catch (e) {
      res.json({ status: 'EXPIRED' });
    }
  });

  // ---- POS staff: kiosk QR payments that are not confirmed yet (list is public, it holds no personal data) ----
  app.get('/api/upi/pending', async (req, res) => {
    try {
      const rows = await dbAllAsync("SELECT paytm_order_id, amount, status, payload, created_ms FROM upi_payments WHERE status IN ('PENDING','CANCELLED','EXPIRED','ORDER_FAILED') AND payload NOT LIKE '%\"_collect\":true%' AND created_ms > ? ORDER BY created_ms DESC LIMIT 30", [Date.now() - 30 * 60 * 1000]);
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
      if (!isPaid(row.status)) { await finalize(row, 'MANUAL'); row = await getRow(id); console.log(`[UPI MANUAL CONFIRM] ${id} Rs.${row.amount} by staff`); }
      if (isPaid(row.status)) return res.json({ ok: true, orderId: row.pos_order_id, token_no: row.token_no });
      res.status(409).json({ error: 'Order nahi ban paaya (status ' + row.status + '). Dobara try karein.' });
    } catch (e) {
      console.error('[UPI] manual confirm error:', e.message);
      res.status(500).json({ error: 'Confirm nahi ho paaya' });
    }
  });

  // POS only: the QR could not be made, so the staff records the UPI money by hand (staff password) and it is applied the same way
  app.post('/api/upi/apply-manual', async (req, res) => {
    try {
      const ip = req.ip || 'x', f = manualFails.get(ip);
      if (f && f.until > Date.now()) return res.status(429).json({ error: 'Bahut galat password. Thodi der baad try karein.' });
      if (!discountPasswordOk || !discountPasswordOk(req.body && req.body.auth_password)) {
        const n = (f && !(f.until && f.until <= Date.now()) ? f.n : 0) + 1;
        manualFails.set(ip, { n, until: n >= 8 ? Date.now() + 60000 : 0 });
        return res.status(403).json({ error: 'Staff password galat hai' });
      }
      manualFails.delete(ip);
      const amount = Math.round((Number(req.body.amount) || 0) * 100) / 100;
      if (!(amount > 0) || amount > 100000) return res.status(400).json({ error: 'Amount sahi nahi hai' });
      const oid = Math.floor(Number(req.body.order_id));
      const parked = oid > 0 ? { order_id: oid } : /^\d{6,15}$/.test(String(req.body.settle_customer || '')) ? { settle_customer: String(req.body.settle_customer) } : null;
      if (!parked) return res.status(400).json({ error: 'Order ya customer chahiye' });
      await applyCollect(parked, amount);
      console.log(`[UPI MANUAL APPLY] Rs.${amount} ${JSON.stringify(parked)} by staff`);
      res.json({ ok: true });
    } catch (e) {
      console.error('[UPI] apply-manual error:', e.message);
      res.status(500).json({ error: 'Record nahi ho paaya' });
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
