// Table QR ordering: every table gets a QR that opens /table-order.html?t=<table>&k=<signature>.
// The signature (HMAC with a secret kept in settings) stops people from ordering for tables by guessing the URL.
// Orders are rebuilt from the DB (prices, add-ons) by createOrderHandler, land in "Needs approval" and are paid at the counter.
const crypto = require('crypto');
const QRCode = require('qrcode');

const sig = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex').slice(0, 16);
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cleanText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function register(app, { dbAllAsync, getSettingsConfig, saveSettingsConfig, storeStatus, createOrderHandler, profileTokenOk, taxableSubtotal, computeDiscount }) {
  const q = (sql, p) => dbAllAsync(sql, p || []);

  async function secret() {
    const cfg = await getSettingsConfig();
    if (cfg.table_qr_secret) return cfg.table_qr_secret;
    const s = crypto.randomBytes(24).toString('hex');
    await saveSettingsConfig({ table_qr_secret: s });
    return s;
  }
  const tableSig = async (table) => sig(await secret(), 'tbl:' + table.toUpperCase());
  const orderSig = async (id) => sig(await secret(), 'tord:' + id);
  const restaurantName = async () => { try { return ((await q('SELECT restaurant_name FROM settings WHERE id = 1'))[0] || {}).restaurant_name || ''; } catch (e) { return ''; } };
  const baseUrl = (req) => (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');

  // The POS floor plan keeps its table ids in the page itself (T01..T08), so the QR tables are a list in settings.
  // Default matches the POS; owners can change it on the Table QR page.
  const DEFAULT_TABLES = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'];
  async function tableList() {
    const cfg = await getSettingsConfig();
    const list = Array.isArray(cfg.table_qr_tables) ? cfg.table_qr_tables.map(t => cleanText(t, 20)).filter(Boolean) : [];
    return list.length ? list : DEFAULT_TABLES;
  }

  // Valid QR => the table id exactly as configured, else null
  async function verifyTable(t, k) {
    const table = cleanText(t, 20);
    if (!table || !k || !safeEq(k, await tableSig(table))) return null;
    const found = (await tableList()).find(x => x.toUpperCase() === table.toUpperCase());
    return found || null;
  }

  // simple in-memory rate limit: at most `max` hits per `ms` for a key
  const hits = new Map();
  const limited = (key, max, ms) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < ms);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(now); hits.set(key, arr); return false;
  };
  setInterval(() => { const now = Date.now(); hits.forEach((arr, k) => { if (!arr.some(t => now - t < 600000)) hits.delete(k); }); }, 600000).unref();

  // What the customer should see for an order. Items of a table's later orders are merged into the table's first bill,
  // so they must see that bill's token (and its progress), both before staff accepts and after the merge.
  const LIVE_BILL = "LOWER(order_type) LIKE '%dine%' AND UPPER(status) IN ('RUNNING_TABLE', 'KOT_DONE')";
  const ORDER_COLS = 'id, token_no, status, table_no, merged_into, source, total';
  async function resolveOrder(id) {
    const own = (await q(`SELECT ${ORDER_COLS} FROM orders WHERE id = ?`, [id]))[0];
    if (!own) return null;
    let o = own;
    for (let hops = 0; hops < 5 && String(o.status).toUpperCase() === 'MERGED' && o.merged_into; hops++) {
      const t = (await q(`SELECT ${ORDER_COLS} FROM orders WHERE id = ?`, [o.merged_into]))[0];
      if (!t) break;
      o = t;
    }
    if (o.id !== own.id) return { own, bill: o, token: o.token_no, shared: true };
    if (String(own.status).toUpperCase() === 'NEEDS_APPROVAL' && own.table_no) {
      const live = (await q(`SELECT id, token_no FROM orders WHERE ${LIVE_BILL} AND UPPER(table_no) = UPPER(?) AND id <> ? ORDER BY id LIMIT 1`, [own.table_no, own.id]))[0];
      if (live) return { own, bill: own, token: live.token_no, shared: true };
      const first = (await q(`SELECT id, token_no FROM orders WHERE source = 'TABLE_QR' AND UPPER(status) = 'NEEDS_APPROVAL' AND UPPER(table_no) = UPPER(?) AND id < ? ORDER BY id LIMIT 1`, [own.table_no, own.id]))[0];
      if (first) return { own, bill: own, token: first.token_no, shared: true };
    }
    return { own, bill: own, token: own.token_no, shared: false };
  }

  // ---- customer side (public) ----
  app.get('/api/table-qr/info', async (req, res) => {
    try {
      const table = await verifyTable(req.query.t, req.query.k);
      if (!table) return res.status(403).json({ error: 'Ye QR sahi nahi hai. Staff se poochhein.' });
      const cfg = await getSettingsConfig();
      const st = storeStatus(cfg);
      res.json({ table, open: !!st.open, message: st.message || '', restaurant: await restaurantName(), require_otp: (cfg.ordering_rules || {}).require_otp !== false });
    } catch (e) { res.status(500).json({ error: 'Load nahi hua' }); }
  });

  app.post('/api/table-qr/order', async (req, res) => {
    try {
      const b = req.body || {};
      const table = await verifyTable(b.t, b.k);
      if (!table) return res.status(403).json({ error: 'Ye QR sahi nahi hai. Staff se poochhein.' });
      const ip = (req.get('x-forwarded-for') || '').split(',').pop().trim() || req.ip || 'x';
      if (limited('ip:' + ip, 15, 600000) || limited('tbl:' + table, 10, 600000)) return res.status(429).json({ error: 'Bahut zyada orders. Thodi der baad try karein ya staff ko bulayein.' });
      const name = cleanText(b.customer_name, 60);
      if (name.length < 2) return res.status(400).json({ error: 'Apna naam daalein' });
      const phone = cleanText(b.customer_phone, 15).replace(/\D/g, '');
      if (!/^[6-9]\d{9}$/.test(phone) || /^(\d)\1{9}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10-digit mobile number daalein' });
      const note = cleanText(b.note, 200);
      const items = Array.isArray(b.items) ? b.items.slice(0, 60).map((l, i) => ({
        id: Number(l && l.id), qty: Number(l && l.qty), variant: l && l.variant ? String(l.variant).slice(0, 80) : undefined,
        addons: Array.isArray(l && l.addons) ? l.addons.slice(0, 30).map(a => ({ name: String((a && a.name) || '').slice(0, 80) })) : [],
        notes: i === 0 && note ? 'Note: ' + note : ''
      })) : [];
      // only these fields are ever read from a public request: no discount / payment / status can be injected
      // "Pay now" (first order only, chosen by the guest): the order stays hidden until Razorpay confirms the payment. Points are only used when paying:
      // here for Pay now, later on the bill sheet for pay-at-the-end (never when the order is placed unpaid).
      const payNow = b.pay_now === true;
      if (payNow && !rzConfigured()) return res.status(503).json({ error: 'Online payment abhi available nahi hai. Pay at the end chunein.' });
      const pts = payNow ? Math.floor(Number(b.points_redeem)) : 0;
      req.body = { order_type: 'Dine-In', table_no: table, customer_name: name, customer_phone: phone, items,
        points_redeem: pts > 0 ? pts : undefined, profile_token: String(b.profile_token || '').slice(0, 100) };
      req.tableQr = { table };
      req.tableQrPayNow = payNow;
      const origJson = res.json.bind(res);
      res.json = async (d) => {
        if (d && d.success && d.orderId) {
          d.track = await orderSig(d.orderId);
          try { const r = await resolveOrder(d.orderId); if (r) { d.token_no = r.token; d.shared = r.shared; } } catch (e) { /* keep the order's own token */ }
          if (payNow) {
            try { d.pay = await app.locals.razorpayStart(d.orderId, d.token_no, d.profile_token); }
            catch (e) {
              console.error('[TABLE QR PAY NOW] razorpay start failed:', e.message);
              await q("UPDATE orders SET status = 'VOID' WHERE id = ? AND status = 'HOLD' RETURNING id", [d.orderId]).catch(() => {});
              res.status(500);
              return origJson({ error: 'Payment shuru nahi ho paaya. Dobara try karein ya Pay at the end chunein.' });
            }
          }
        }
        return origJson(d);
      };
      return createOrderHandler(req, res);
    } catch (e) { console.error('[TABLE QR ORDER]', e.message); res.status(500).json({ error: 'Order nahi ho paaya' }); }
  });

  // Order progress for the customer's phone (needs the signature returned when the order was placed)
  app.get('/api/table-qr/status', async (req, res) => {
    try {
      const id = Number(req.query.o);
      if (!Number.isInteger(id) || !safeEq(req.query.s, await orderSig(id))) return res.status(403).json({ error: 'Invalid' });
      const r = await resolveOrder(id);
      if (!r || r.own.source !== 'TABLE_QR') return res.status(404).json({ error: 'Order nahi mila' });
      const o = r.bill;
      const st = String(o.status || '').toUpperCase();
      let state = 'preparing', step = 1;
      if (st === 'NEEDS_APPROVAL') { state = 'waiting'; step = 0; }
      else if (st === 'KOT_DONE') { state = 'ready'; step = 2; }
      else if (['DISPATCHED', 'COMPLETED', 'DUE_PENDING'].includes(st)) { state = 'served'; step = 3; }
      else if (['VOID', 'CANCELLED'].includes(st)) { state = 'rejected'; step = 0; }
      // MERGED orders follow the bill they were merged into (same token, same progress)
      res.json({ id: r.own.id, token_no: r.token, shared: r.shared, state, step, table: r.own.table_no });
    } catch (e) { res.status(500).json({ error: 'Load nahi hua' }); }
  });

  // ---- bill + online payment (Razorpay) ----
  q(`CREATE TABLE IF NOT EXISTS table_bill_payments (
    id SERIAL PRIMARY KEY, rp_order_id TEXT UNIQUE, table_no TEXT, orders TEXT, amount NUMERIC,
    status TEXT DEFAULT 'CREATED', payment_id TEXT, created_ms BIGINT)`)
    .then(() => q('ALTER TABLE table_bill_payments ADD COLUMN IF NOT EXISTS points_plan TEXT'))
    .then(() => q('ALTER TABLE table_bill_payments ADD COLUMN IF NOT EXISTS paid_ms BIGINT')).catch(e => console.error('table_bill_payments error:', e.message));
  const rzConfigured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  const rzHmac = (data) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(data).digest('hex');
  const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // The table's bill = every accepted (running) dine-in order on the table. Orders still waiting for staff are listed apart and not payable yet.
  async function tableBill(table) {
    const live = await q(`SELECT id, token_no, status, subtotal, discount, gst, total, customer_phone, COALESCE(points_redeemed, 0) AS points_redeemed, COALESCE(paid_amount, 0) AS paid FROM orders
      WHERE ${LIVE_BILL} AND UPPER(table_no) = UPPER(?) ORDER BY id`, [table]);
    const pending = await q(`SELECT id, token_no FROM orders WHERE source = 'TABLE_QR' AND UPPER(status) = 'NEEDS_APPROVAL' AND UPPER(table_no) = UPPER(?) ORDER BY id`, [table]);
    const lineMap = new Map();
    for (const o of live) {
      for (const it of await q('SELECT name, qty, price FROM order_items WHERE order_id = ? AND name <> ? ORDER BY id', [o.id, 'Delivery Charge'])) {
        const key = it.name + '|' + it.price, cur = lineMap.get(key) || { name: it.name, price: money(it.price), qty: 0 };
        cur.qty += Number(it.qty) || 0; lineMap.set(key, cur);
      }
    }
    const pendingItems = [];
    for (const o of pending) for (const it of await q('SELECT name, qty, price FROM order_items WHERE order_id = ? ORDER BY id', [o.id])) pendingItems.push({ name: it.name, qty: Number(it.qty) || 0, price: money(it.price) });
    const sum = (k) => money(live.reduce((t, o) => t + (Number(o[k]) || 0), 0));
    const total = sum('total'), paid = sum('paid');
    return { live, pendingCount: pending.length, pendingItems, lines: [...lineMap.values()],
      subtotal: sum('subtotal'), discount: sum('discount'), gst: sum('gst'), total, paid, due: money(Math.max(0, total - paid)),
      token: live.length ? live[0].token_no : null };
  }

  app.get('/api/table-qr/bill', async (req, res) => {
    try {
      const table = await verifyTable(req.query.t, req.query.k);
      if (!table) return res.status(403).json({ error: 'Ye QR sahi nahi hai. Staff se poochhein.' });
      const bill = await tableBill(table);
      // points can be used on the final online payment: this guest's own order the points discount would go on (see planPoints)
      const ph = cleanText(req.query.phone, 15).replace(/\D/g, '').slice(-10);
      const cand = ph.length === 10 ? pointsTarget(bill, ph) : null;
      const points_base = cand ? money(cand.subtotal) : 0;
      delete bill.live;
      res.json({ table, ...bill, online: rzConfigured(), points_base });
    } catch (e) { console.error('[TABLE QR BILL]', e.message); res.status(500).json({ error: 'Bill load nahi hua' }); }
  });

  // Loyalty points on the final bill payment: the whole points discount goes on ONE order of the table placed with the guest's own number
  // (the points ledger is per phone/order), with GST recomputed on the reduced amount exactly like a counter discount.
  const pointsTarget = (bill, phone) => bill.live
    .filter(o => String(o.customer_phone || '').slice(-10) === phone && !(Number(o.discount) > 0) && !(Number(o.points_redeemed) > 0) && money(Number(o.total) - Number(o.paid)) > 0 && Number(o.subtotal) > 0)
    .sort((a, b) => Number(b.subtotal) - Number(a.subtotal))[0];
  async function planPoints(bill, phone, pts, token) {
    phone = cleanText(phone, 15).replace(/\D/g, '').slice(-10);
    pts = Math.floor(Number(pts));
    if (!(pts > 0) || phone.length !== 10) return { error: 'Points sahi nahi hain' };
    if (!(await profileTokenOk(phone, token))) return { error: 'Points verify nahi ho paaye. Number WhatsApp OTP se verify karein.' };
    const o = pointsTarget(bill, phone);
    if (!o) return { error: 'Points sirf aapke apne number se kiye gaye order par lag sakte hain, aur us par koi discount nahi hona chahiye.' };
    const promo = await computeDiscount({ subtotal: Number(o.subtotal), phone, points_redeem: pts, staff_override: true, consume: false });
    if (promo.error) return { error: promo.error };
    const items = await q('SELECT name, qty, price, is_exempt FROM order_items WHERE order_id = ?', [o.id]);
    const sub = Number(o.subtotal), disc = promo.discount, taxBase = taxableSubtotal(items);
    const gst = Math.round((Math.max(0, taxBase - disc * taxBase / sub) * 5) / 100);
    const total = Math.round(sub + gst - disc);
    return { orderId: o.id, pts: promo.pointsRedeemed, discount: disc, gst, total, reason: promo.reason, paid: Number(o.paid) };
  }
  // what the guest owes per order, with the points order's reduced total applied
  const payParts = (bill, plan) => bill.live.map(o => ({ id: o.id, amount: money(Math.max(0, (plan && plan.orderId === o.id ? plan.total : Number(o.total)) - Number(o.paid))) })).filter(p => p.amount > 0);

  app.post('/api/table-qr/pay/quote', async (req, res) => {
    try {
      const b = req.body || {};
      const table = await verifyTable(b.t, b.k);
      if (!table) return res.status(403).json({ error: 'Ye QR sahi nahi hai.' });
      if (limited('quote:' + table, 30, 600000)) return res.status(429).json({ error: 'Thodi der baad try karein.' });
      const bill = await tableBill(table);
      const plan = await planPoints(bill, b.phone, b.points_redeem, b.profile_token);
      if (plan.error) return res.status(400).json({ error: plan.error });
      res.json({ points: plan.pts, discount: money(plan.discount), amount: money(payParts(bill, plan).reduce((t, p) => t + p.amount, 0)) });
    } catch (e) { console.error('[TABLE QR QUOTE]', e.message); res.status(500).json({ error: 'Points check nahi ho paaye' }); }
  });

  app.post('/api/table-qr/pay/create', async (req, res) => {
    try {
      if (!rzConfigured()) return res.status(503).json({ error: 'Online payment abhi available nahi hai. Counter par payment karein.' });
      const table = await verifyTable((req.body || {}).t, (req.body || {}).k);
      if (!table) return res.status(403).json({ error: 'Ye QR sahi nahi hai. Staff se poochhein.' });
      if (limited('pay:' + table, 8, 600000)) return res.status(429).json({ error: 'Bahut baar try kiya. Thodi der baad dobara karein ya counter par payment karein.' });
      const bill = await tableBill(table);
      if (!bill.live.length) return res.status(404).json({ error: 'Abhi is table ka koi bill nahi hai' });
      if (bill.pendingCount) return res.status(409).json({ error: 'Aapka naya order abhi staff accept kar rahe hain. Accept hone ke baad payment karein.' });
      if (bill.due <= 0) return res.status(400).json({ error: 'Ye bill pehle hi paid hai' });
      const busy = await q("SELECT 1 FROM table_bill_payments WHERE table_no = ? AND status = 'CREATED' AND created_ms > ? LIMIT 1", [table, Date.now() - 180000]);
      if (busy.length) return res.status(409).json({ error: 'Is table ka payment already chal raha hai. 2-3 minute baad dobara dekhein.' });

      let plan = null;
      if (Math.floor(Number((req.body || {}).points_redeem)) > 0) {
        plan = await planPoints(bill, req.body.phone, req.body.points_redeem, req.body.profile_token);
        if (plan.error) return res.status(400).json({ error: plan.error });
      }
      const parts = payParts(bill, plan);
      const amount = money(parts.reduce((t, p) => t + p.amount, 0));
      if (plan && amount < 1) return res.status(400).json({ error: 'Itne points ke baad amount bahut kam bachta hai. Kam points use karein.' });
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const r = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify({ amount: Math.round(amount * 100), currency: 'INR', receipt: `TBL${table}`.slice(0, 40), notes: { table, pos_orders: parts.map(p => p.id).join(',') } })
      });
      const rp = await r.json();
      if (!r.ok || !rp.id) throw new Error('razorpay order failed: ' + JSON.stringify(rp.error || rp));
      await q('INSERT INTO table_bill_payments (rp_order_id, table_no, orders, amount, created_ms, points_plan) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [rp.id, table, JSON.stringify(parts), amount, Date.now(), plan ? JSON.stringify(plan) : null]);
      res.json({ keyId: process.env.RAZORPAY_KEY_ID, rpOrderId: rp.id, amount: Math.round(amount * 100), total: amount, token: bill.token });
    } catch (e) {
      console.error('[TABLE QR PAY] create error:', e.message);
      res.status(500).json({ error: 'Payment shuru nahi ho paaya. Dobara try karein.' });
    }
  });

  // Credits the payment once (verify endpoint and Razorpay webhook may both arrive). A fully paid bill that the kitchen already
  // finished is closed like the POS "Settle" does; one still being cooked stays on the KDS and closes when the kitchen dispatches it.
  async function markBillPaid(rpOrderId, paymentId) {
    const claimed = await q("UPDATE table_bill_payments SET status = 'PAID', payment_id = ?, paid_ms = ? WHERE rp_order_id = ? AND status <> 'PAID' RETURNING *", [paymentId || '', Date.now(), rpOrderId]);
    if (!claimed.length) return false;
    let parts = []; try { parts = JSON.parse(claimed[0].orders || '[]'); } catch (e) { parts = []; }
    // points used on this payment: now that it is paid, put the discount on the order (this also spends the points in the ledger)
    let plan = null; try { plan = claimed[0].points_plan ? JSON.parse(claimed[0].points_plan) : null; } catch (e) { plan = null; }
    if (plan && plan.orderId) {
      await q("UPDATE orders SET discount = ?, gst = ?, total = ?, points_redeemed = ?, discount_reason = ? WHERE id = ? AND COALESCE(points_redeemed, 0) = 0 RETURNING id",
        [plan.discount, plan.gst, plan.total, plan.pts, plan.reason || (plan.pts + ' pts'), plan.orderId]);
    }
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
    } catch (e) { console.error('[TABLE QR PAY] method lookup failed:', e.message); }
    for (const p of parts) {
      await q(`UPDATE orders SET paid_amount = LEAST(total, COALESCE(paid_amount, 0) + ?::numeric), payment_mode = ?,
          status = CASE WHEN UPPER(status) = 'KOT_DONE' AND COALESCE(paid_amount, 0) + ?::numeric >= total THEN 'DISPATCHED' ELSE status END
        WHERE id = ? AND UPPER(status) IN ('RUNNING_TABLE', 'KOT_DONE') RETURNING id`, [p.amount, mode, p.amount, p.id]);
    }
    console.log(`[TABLE QR PAID] ${rpOrderId} Rs.${claimed[0].amount} table ${claimed[0].table_no}`);
    return true;
  }

  app.post('/api/table-qr/pay/verify', async (req, res) => {
    try {
      const { t, k, razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sg } = req.body || {};
      const table = await verifyTable(t, k);
      if (!table) return res.status(403).json({ error: 'Ye QR sahi nahi hai.' });
      if (!oid || !pid || !safeEq(rzHmac(`${oid}|${pid}`), sg)) return res.status(400).json({ error: 'Payment verify nahi hui' });
      const row = (await q('SELECT table_no FROM table_bill_payments WHERE rp_order_id = ?', [oid]))[0];
      if (!row || String(row.table_no).toUpperCase() !== table.toUpperCase()) return res.status(404).json({ error: 'Payment nahi mili' });
      await markBillPaid(oid, pid);
      res.json({ success: true });
    } catch (e) {
      console.error('[TABLE QR PAY] verify error:', e.message);
      res.status(500).json({ error: 'Verify me dikkat aayi. Agar paisa kata hai to staff ko bataiye, payment mil jayegi.' });
    }
  });

  // POS: bills that guests paid from their phone (table QR), polled for its notification + sound. First call (no `since`) only returns the server clock.
  app.get('/api/table-qr/paid-feed', async (req, res) => {
    try {
      const since = Number(req.query.since);
      if (!(since > 0)) return res.json({ now: Date.now(), items: [] });
      const rows = await q("SELECT rp_order_id, table_no, orders, amount, paid_ms FROM table_bill_payments WHERE status = 'PAID' AND paid_ms > ? ORDER BY paid_ms LIMIT 20", [since]);
      const items = [];
      for (const r of rows) {
        let ids = []; try { ids = JSON.parse(r.orders || '[]').map(p => Number(p.id)).filter(n => n > 0); } catch (e) { /* none */ }
        const o = ids.length ? (await q('SELECT token_no, customer_name, payment_mode FROM orders WHERE id = ?', [ids[0]]))[0] : null;
        items.push({ id: r.rp_order_id, table: r.table_no, amount: Number(r.amount), paid_ms: Number(r.paid_ms), token_no: o ? o.token_no : null, customer: o ? o.customer_name : '', mode: o ? o.payment_mode : '' });
      }
      res.json({ now: Math.max(Date.now(), ...items.map(i => i.paid_ms)), items });
    } catch (e) { res.json({ now: Date.now(), items: [] }); }
  });

  // Customer closed the payment window without paying
  app.post('/api/table-qr/pay/cancel', async (req, res) => {
    try { await q("UPDATE table_bill_payments SET status = 'CANCELLED' WHERE rp_order_id = ? AND status = 'CREATED' RETURNING id", [(req.body || {}).rpOrderId]); } catch (e) { /* best effort */ }
    res.json({ ok: true });
  });

  // ---- staff side (owner PIN via /api/table-qr-admin guard in server.js) ----
  app.get('/api/table-qr-admin/list', async (req, res) => {
    try {
      const tables = await tableList();
      const base = baseUrl(req);
      const out = [];
      for (const t of tables) {
        const url = `${base}/table-order.html?t=${encodeURIComponent(t)}&k=${await tableSig(t)}`;
        out.push({ table: t, url, qr: await QRCode.toDataURL(url, { width: 360, margin: 1 }) });
      }
      res.json({ restaurant: await restaurantName(), base, tables: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Table ids that get a QR (must match the table ids used in the POS, e.g. T01)
  app.post('/api/table-qr-admin/tables', async (req, res) => {
    try {
      const raw = Array.isArray((req.body || {}).tables) ? req.body.tables : [];
      const seen = new Set(), tables = [];
      for (const r of raw) {
        const t = cleanText(r, 20).toUpperCase();
        if (!t) continue;
        if (!/^[A-Z0-9][A-Z0-9 _-]*$/.test(t)) return res.status(400).json({ error: `Table naam sahi nahi hai: ${t} (sirf letters, numbers, - aur _)` });
        if (!seen.has(t)) { seen.add(t); tables.push(t); }
      }
      if (!tables.length) return res.status(400).json({ error: 'Kam se kam ek table chahiye' });
      if (tables.length > 100) return res.status(400).json({ error: 'Zyada se zyada 100 tables' });
      await saveSettingsConfig({ table_qr_tables: tables });
      res.json({ success: true, tables });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Rotating the secret makes every printed QR stop working (use if QR codes leak or are misused)
  app.post('/api/table-qr-admin/reset', async (req, res) => {
    try { await saveSettingsConfig({ table_qr_secret: crypto.randomBytes(24).toString('hex') }); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { markBillPaid };
}

module.exports = { register };
