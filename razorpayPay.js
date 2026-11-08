// Razorpay online payment for order.html (customer ordering).
// 1. /api/razorpay/create-order: the POS order is created hidden (status HOLD, ONLINE_PENDING) with prices rebuilt from the DB,
//    then a Razorpay order is created for that exact DB total.
// 2. Customer pays in Razorpay Checkout; /api/razorpay/verify checks the signature, or the webhook confirms it.
// 3. Only then the order becomes visible to staff (NEEDS_APPROVAL) and is marked paid.
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, optional RAZORPAY_WEBHOOK_SECRET (Dashboard > Webhooks, event payment.captured / order.paid).
const crypto = require('crypto');

const configured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function register(app, { dbAllAsync, createOrderHandler, extraMarkPaid }) {
  dbAllAsync(`CREATE TABLE IF NOT EXISTS razorpay_payments (
    id SERIAL PRIMARY KEY,
    rp_order_id TEXT UNIQUE,
    pos_order_id INTEGER,
    token_no INTEGER,
    profile_token TEXT,
    amount NUMERIC,
    status TEXT DEFAULT 'CREATED',
    payment_id TEXT,
    created_ms BIGINT
  )`, []).catch(e => console.error('razorpay_payments table error:', e.message));

  function runCreateOrder(payload) {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { return this.statusCode >= 400 ? reject(Object.assign(new Error((b && b.error) || 'order failed'), { userFacing: true })) : resolve(b); }
      };
      Promise.resolve(createOrderHandler({ body: payload }, res)).catch(reject);
    });
  }

  // Idempotent: verify endpoint and webhook may both arrive. Also revives an order the customer cancelled but still paid for.
  async function markPaid(rpOrderId, paymentId) {
    const claimed = await dbAllAsync(
      "UPDATE razorpay_payments SET status = 'PAID', payment_id = ? WHERE rp_order_id = ? AND status <> 'PAID' RETURNING *",
      [paymentId || '', rpOrderId]);
    if (claimed.length) {
      const row = claimed[0];
      // actual method the customer used (upi / card); anything else or a lookup failure stays 'RAZORPAY'
      let mode = 'RAZORPAY';
      try {
        if (paymentId) {
          const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
          const pr = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${auth}` } });
          const pj = await pr.json();
          if (pj && pj.method === 'upi') mode = 'UPI';
          else if (pj && pj.method === 'card') mode = 'CARD';
        }
      } catch (e) { console.error('[RAZORPAY] method lookup failed:', e.message); }
      await dbAllAsync(
        "UPDATE orders SET status = 'NEEDS_APPROVAL', payment_mode = ?, paid_amount = total WHERE id = ? RETURNING id",
        [mode, row.pos_order_id]);
      console.log(`[RAZORPAY PAID] ${rpOrderId} Rs.${row.amount} -> POS order #${row.pos_order_id}`);
    }
    return (await dbAllAsync('SELECT * FROM razorpay_payments WHERE rp_order_id = ?', [rpOrderId]))[0];
  }

  // Full refund of a paid Razorpay order (used when staff rejects it). speed 'optimum' = instant when the
  // payment method/account supports it, else normal; same as the dashboard's default. Returns null if nothing to refund.
  app.locals.razorpayRefund = async function refundOrder(posOrderId) {
    const claimed = await dbAllAsync(
      "UPDATE razorpay_payments SET status = 'REFUNDING' WHERE pos_order_id = ? AND status = 'PAID' AND payment_id <> '' RETURNING *",
      [posOrderId]);
    if (!claimed.length) return null;
    const row = claimed[0];
    try {
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const r = await fetch(`https://api.razorpay.com/v1/payments/${row.payment_id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify({ amount: Math.round(Number(row.amount) * 100), speed: 'optimum', receipt: `REJ${posOrderId}`, notes: { pos_order_id: String(posOrderId), reason: 'order rejected' } })
      });
      const rf = await r.json();
      if (!r.ok || !rf.id) throw new Error((rf.error && rf.error.description) || 'refund failed');
      await dbAllAsync("UPDATE razorpay_payments SET status = 'REFUNDED' WHERE id = ? RETURNING id", [row.id]);
      console.log(`[RAZORPAY REFUND] order #${posOrderId} Rs.${row.amount} refund ${rf.id} (${rf.speed_processed || rf.speed_requested || ''})`);
      return { id: rf.id, amount: Number(row.amount), speed: rf.speed_processed || rf.speed_requested || '' };
    } catch (e) {
      await dbAllAsync("UPDATE razorpay_payments SET status = 'PAID' WHERE id = ? RETURNING id", [row.id]).catch(() => {}); // allow a retry
      console.error('[RAZORPAY REFUND] failed for order #' + posOrderId + ':', e.message);
      throw e;
    }
  };

  app.get('/api/razorpay/config', (req, res) => res.json({ enabled: configured() }));

  // Creates the Razorpay order for an already saved HOLD order (its DB total) and records it. Used by the website checkout and by table QR "Pay now".
  async function startRazorpay(orderId, tokenNo, profileToken) {
    const rows = await dbAllAsync('SELECT total FROM orders WHERE id = ?', [orderId]);
    const total = Number(rows[0] && rows[0].total);
    if (!(total > 0)) throw new Error('invalid total');

    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({ amount: Math.round(total * 100), currency: 'INR', receipt: `POS${orderId}`, notes: { pos_order_id: String(orderId) } })
    });
    const rp = await r.json();
    if (!r.ok || !rp.id) throw new Error('razorpay order failed: ' + JSON.stringify(rp.error || rp));

    await dbAllAsync(
      'INSERT INTO razorpay_payments (rp_order_id, pos_order_id, token_no, profile_token, amount, created_ms) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      [rp.id, orderId, tokenNo, profileToken || null, total, Date.now()]);
    return { keyId: process.env.RAZORPAY_KEY_ID, rpOrderId: rp.id, amount: Math.round(total * 100), total, orderId, token_no: tokenNo };
  }
  app.locals.razorpayStart = (orderId, tokenNo, profileToken) => configured() ? startRazorpay(orderId, tokenNo, profileToken) : Promise.reject(new Error('razorpay not configured'));

  app.post('/api/razorpay/create-order', async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'Online payment abhi available nahi hai' });
    let orderId;
    try {
      const o = await runCreateOrder({ ...req.body, pay_online: true });
      orderId = o.orderId;
      res.json(await startRazorpay(orderId, o.token_no, o.profile_token));
    } catch (e) {
      console.error('[RAZORPAY] create-order error:', e.message);
      if (orderId) dbAllAsync("UPDATE orders SET status = 'VOID' WHERE id = ? AND status = 'HOLD' RETURNING id", [orderId]).catch(() => {});
      res.status(e.userFacing ? 400 : 500).json({ error: e.userFacing ? e.message : 'Payment shuru nahi ho paaya. Dobara try karein.' });
    }
  });

  app.post('/api/razorpay/verify', async (req, res) => {
    try {
      const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body || {};
      if (!oid || !pid || !safeEqual(hmac(process.env.RAZORPAY_KEY_SECRET || '', `${oid}|${pid}`), sig)) {
        return res.status(400).json({ error: 'Payment verify nahi hui' });
      }
      const row = await markPaid(oid, pid);
      if (!row) return res.status(404).json({ error: 'Order nahi mila' });
      res.json({ success: true, orderId: row.pos_order_id, token_no: row.token_no, profile_token: row.profile_token });
    } catch (e) {
      console.error('[RAZORPAY] verify error:', e.message);
      res.status(500).json({ error: 'Verify me dikkat aayi. Staff se sampark karein, paisa kata ho to order mil jayega.' });
    }
  });

  // Customer closed the payment window. A payment that still lands later is picked up by the webhook.
  app.post('/api/razorpay/cancel', async (req, res) => {
    try {
      const rows = await dbAllAsync("UPDATE razorpay_payments SET status = 'CANCELLED' WHERE rp_order_id = ? AND status = 'CREATED' RETURNING pos_order_id", [req.body && req.body.rpOrderId]);
      if (rows.length) await dbAllAsync("UPDATE orders SET status = 'VOID' WHERE id = ? AND status = 'HOLD' RETURNING id", [rows[0].pos_order_id]);
    } catch (e) { /* best effort */ }
    res.json({ ok: true });
  });

  app.post('/api/razorpay/webhook', async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !req.rawBody || !safeEqual(hmac(secret, req.rawBody), req.headers['x-razorpay-signature'])) return res.status(400).end();
    try {
      const ev = req.body || {};
      const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
      if ((ev.event === 'payment.captured' || ev.event === 'order.paid') && pay && pay.order_id) {
        await markPaid(pay.order_id, pay.id);
        if (extraMarkPaid) await extraMarkPaid(pay.order_id, pay.id); // table QR bill payments (tableQr.js)
      }
    } catch (e) {
      console.error('[RAZORPAY] webhook error:', e.message);
      return res.status(500).end();
    }
    res.json({ ok: true });
  });
}

module.exports = { register };
