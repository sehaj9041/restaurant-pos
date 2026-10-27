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

function register(app, { dbAllAsync, createOrderHandler }) {
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
      await dbAllAsync(
        "UPDATE orders SET status = 'NEEDS_APPROVAL', payment_mode = 'RAZORPAY', paid_amount = total WHERE id = ? RETURNING id",
        [row.pos_order_id]);
      console.log(`[RAZORPAY PAID] ${rpOrderId} Rs.${row.amount} -> POS order #${row.pos_order_id}`);
    }
    return (await dbAllAsync('SELECT * FROM razorpay_payments WHERE rp_order_id = ?', [rpOrderId]))[0];
  }

  app.get('/api/razorpay/config', (req, res) => res.json({ enabled: configured() }));

  app.post('/api/razorpay/create-order', async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'Online payment abhi available nahi hai' });
    let orderId;
    try {
      const o = await runCreateOrder({ ...req.body, pay_online: true });
      orderId = o.orderId;
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
        [rp.id, orderId, o.token_no, o.profile_token || null, total, Date.now()]);
      res.json({ keyId: process.env.RAZORPAY_KEY_ID, rpOrderId: rp.id, amount: Math.round(total * 100), total, orderId, token_no: o.token_no });
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
      if ((ev.event === 'payment.captured' || ev.event === 'order.paid') && pay && pay.order_id) await markPaid(pay.order_id, pay.id);
    } catch (e) {
      console.error('[RAZORPAY] webhook error:', e.message);
      return res.status(500).end();
    }
    res.json({ ok: true });
  });
}

module.exports = { register };
