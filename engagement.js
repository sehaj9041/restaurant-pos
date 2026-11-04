// Customer engagement: coupons, loyalty points and customer feedback.
//
// Loyalty: no separate ledger. A phone's balance is derived from its orders:
//   earned   = sum of floor(total * earn_per_100 / 100) over fully paid, non-void orders of that phone
//   redeemed = sum of orders.points_redeemed (non-void orders)
// so it stays correct whichever screen (POS, table settle, due settle...) marked the order paid.
// Config lives in settings.config.loyalty = { enabled, earn_per_100, point_value, min_redeem, max_redeem_pct }.
//
// Coupons: table `coupons` (managed on /engagement.html, owner PIN). computeDiscount() is the single place that turns
// a coupon code / points to redeem into a rupee discount; createOrderHandler calls it so the client can never fake one.
//
// Feedback: receipts carry a QR (/api/feedback/qr/:orderId) that opens /feedback.html with a signed link.
const crypto = require('crypto');
const QRCode = require('qrcode');

const DEFAULT_LOYALTY = { enabled: false, earn_per_100: 5, point_value: 0.5, min_redeem: 50, max_redeem_pct: 50 };
const DEAD_STATUS = "('VOID', 'CANCELLED', 'HOLD')";

function register(app, { dbAllAsync, getSettingsConfig, saveSettingsConfig }) {
  dbAllAsync(`CREATE TABLE IF NOT EXISTS coupons (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    type TEXT DEFAULT 'percent',
    value NUMERIC DEFAULT 0,
    min_order NUMERIC DEFAULT 0,
    max_discount NUMERIC DEFAULT 0,
    valid_from DATE,
    valid_till DATE,
    usage_limit INTEGER DEFAULT 0,
    once_per_customer INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, []).catch(e => console.error('coupons table error:', e.message));
  dbAllAsync(`CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY,
    order_id INTEGER UNIQUE,
    token_no INTEGER,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    rating INTEGER NOT NULL,
    comment TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, []).catch(e => console.error('feedback table error:', e.message));
  dbAllAsync(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT`, []).catch(() => {});
  dbAllAsync(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redeemed INTEGER DEFAULT 0`, []).catch(() => {});

  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const cleanPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const cleanCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);

  async function loyaltyConfig() {
    const cfg = await getSettingsConfig();
    const l = Object.assign({}, DEFAULT_LOYALTY, cfg.loyalty || {});
    return { enabled: !!l.enabled, earn_per_100: num(l.earn_per_100, 5), point_value: num(l.point_value, 0.5), min_redeem: num(l.min_redeem, 50), max_redeem_pct: num(l.max_redeem_pct, 50) };
  }

  async function loyaltyBalance(phone, L, excludeId = 0) {
    phone = cleanPhone(phone);
    if (!phone) return { phone: '', earned: 0, redeemed: 0, balance: 0 };
    const rows = await dbAllAsync(`SELECT
        COALESCE(SUM(CASE WHEN paid_amount >= total AND total > 0 AND COALESCE(is_complimentary, 0) = 0 THEN FLOOR(total * ? / 100) ELSE 0 END), 0) AS earned,
        COALESCE(SUM(points_redeemed), 0) AS redeemed
      FROM orders WHERE RIGHT(customer_phone, 10) = ? AND id <> ? AND UPPER(COALESCE(status, '')) NOT IN ${DEAD_STATUS}`, [L.earn_per_100, phone, excludeId]);
    const earned = num(rows[0] && rows[0].earned), redeemed = num(rows[0] && rows[0].redeemed);
    return { phone, earned, redeemed, balance: Math.max(0, earned - redeemed) };
  }

  // Returns { error } or { discount, couponDiscount, pointsDiscount, couponCode, pointsRedeemed, reason }
  async function computeDiscount({ subtotal, phone, coupon_code, points_redeem, exclude_order_id }) {
    const ex = Math.floor(num(exclude_order_id)); // an order being edited must not count its own earlier coupon / points
    subtotal = Math.max(0, num(subtotal));
    let couponDiscount = 0, couponCode = '', pointsDiscount = 0, pointsRedeemed = 0;
    const code = cleanCode(coupon_code);
    if (code) {
      const rows = await dbAllAsync('SELECT * FROM coupons WHERE code = ?', [code]);
      const c = rows[0];
      if (!c || !Number(c.active)) return { error: 'Coupon valid nahi hai' };
      const today = new Date().toISOString().slice(0, 10);
      if (c.valid_from && String(c.valid_from.toISOString ? c.valid_from.toISOString() : c.valid_from).slice(0, 10) > today) return { error: 'Coupon abhi shuru nahi hua' };
      if (c.valid_till && String(c.valid_till.toISOString ? c.valid_till.toISOString() : c.valid_till).slice(0, 10) < today) return { error: 'Coupon expire ho chuka hai' };
      if (num(c.min_order) > 0 && subtotal < num(c.min_order)) return { error: `Is coupon ke liye minimum order ₹${num(c.min_order)} chahiye` };
      if (num(c.usage_limit) > 0) {
        const u = await dbAllAsync(`SELECT COUNT(*) AS n FROM orders WHERE coupon_code = ? AND id <> ? AND UPPER(COALESCE(status, '')) NOT IN ${DEAD_STATUS}`, [code, ex]);
        if (num(u[0] && u[0].n) >= num(c.usage_limit)) return { error: 'Coupon ki limit khatam ho gayi' };
      }
      if (Number(c.once_per_customer)) {
        const ph = cleanPhone(phone);
        if (!ph) return { error: 'Is coupon ke liye customer ka phone number zaroori hai' };
        const u = await dbAllAsync(`SELECT COUNT(*) AS n FROM orders WHERE coupon_code = ? AND RIGHT(customer_phone, 10) = ? AND id <> ? AND UPPER(COALESCE(status, '')) NOT IN ${DEAD_STATUS}`, [code, ph, ex]);
        if (num(u[0] && u[0].n) > 0) return { error: 'Ye coupon is customer ne pehle hi use kar liya hai' };
      }
      couponDiscount = c.type === 'flat' ? num(c.value) : subtotal * num(c.value) / 100;
      if (c.type !== 'flat' && num(c.max_discount) > 0) couponDiscount = Math.min(couponDiscount, num(c.max_discount));
      couponDiscount = Math.min(Math.round(couponDiscount * 100) / 100, subtotal);
      couponCode = code;
    }
    const pts = Math.floor(num(points_redeem));
    if (pts > 0) {
      const L = await loyaltyConfig();
      if (!L.enabled) return { error: 'Loyalty points abhi band hain' };
      if (!cleanPhone(phone)) return { error: 'Points redeem karne ke liye customer ka phone zaroori hai' };
      if (pts < L.min_redeem) return { error: `Kam se kam ${L.min_redeem} points redeem karne honge` };
      const bal = await loyaltyBalance(phone, L, ex);
      if (pts > bal.balance) return { error: `Customer ke paas sirf ${bal.balance} points hain` };
      const room = Math.max(0, (subtotal - couponDiscount) * L.max_redeem_pct / 100);
      pointsDiscount = Math.round(pts * L.point_value * 100) / 100;
      if (pointsDiscount > room + 0.001) return { error: `Ek bill par max ${L.max_redeem_pct}% tak hi points redeem ho sakte hain (₹${Math.floor(room)})` };
      pointsRedeemed = pts;
    }
    const parts = [];
    if (couponCode) parts.push('Coupon ' + couponCode);
    if (pointsRedeemed) parts.push(pointsRedeemed + ' pts');
    return { discount: Math.min(subtotal, couponDiscount + pointsDiscount), couponDiscount, pointsDiscount, couponCode, pointsRedeemed, reason: parts.join(' + ') };
  }

  // ---- public / POS routes ----
  app.post('/api/coupons/validate', async (req, res) => {
    try {
      const r = await computeDiscount(req.body || {});
      if (r.error) return res.status(400).json({ error: r.error });
      res.json(r);
    } catch (e) { console.error('coupon validate:', e.message); res.status(500).json({ error: 'Coupon check nahi ho paaya' }); }
  });

  app.get('/api/loyalty/:phone', async (req, res) => {
    try {
      const L = await loyaltyConfig();
      const b = await loyaltyBalance(req.params.phone, L);
      res.json(Object.assign({ enabled: L.enabled, point_value: L.point_value, min_redeem: L.min_redeem, max_redeem_pct: L.max_redeem_pct, earn_per_100: L.earn_per_100 }, b));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- owner routes (guarded by /coupon-admin and /loyalty-admin in OWNER_RULES) ----
  app.get('/api/coupon-admin', async (req, res) => {
    try {
      const rows = await dbAllAsync(`SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.coupon_code = c.code AND UPPER(COALESCE(o.status, '')) NOT IN ${DEAD_STATUS}) AS used
        FROM coupons c ORDER BY c.active DESC, c.id DESC`, []);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const couponFields = (b) => {
    const type = b.type === 'flat' ? 'flat' : 'percent';
    const value = Math.max(0, num(b.value));
    if (!(value > 0)) return { error: 'Discount value daalein' };
    if (type === 'percent' && value > 100) return { error: 'Percent 100 se zyada nahi ho sakta' };
    return { vals: [String(b.description || '').slice(0, 120), type, value, Math.max(0, num(b.min_order)), Math.max(0, num(b.max_discount)),
      b.valid_from || null, b.valid_till || null, Math.max(0, Math.floor(num(b.usage_limit))), b.once_per_customer ? 1 : 0, b.active === false || b.active === 0 ? 0 : 1] };
  };

  app.post('/api/coupon-admin', async (req, res) => {
    const code = cleanCode(req.body.code);
    if (code.length < 3) return res.status(400).json({ error: 'Coupon code kam se kam 3 akshar ka ho (A-Z, 0-9)' });
    const f = couponFields(req.body);
    if (f.error) return res.status(400).json({ error: f.error });
    try {
      await dbAllAsync(`INSERT INTO coupons (code, description, type, value, min_order, max_discount, valid_from, valid_till, usage_limit, once_per_customer, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [code].concat(f.vals));
      res.json({ success: true });
    } catch (e) { res.status(/duplicate|unique/i.test(e.message) ? 409 : 500).json({ error: /duplicate|unique/i.test(e.message) ? 'Ye coupon code pehle se hai' : e.message }); }
  });

  app.put('/api/coupon-admin/:id', async (req, res) => {
    const f = couponFields(req.body);
    if (f.error) return res.status(400).json({ error: f.error });
    try {
      await dbAllAsync(`UPDATE coupons SET description = ?, type = ?, value = ?, min_order = ?, max_discount = ?, valid_from = ?, valid_till = ?, usage_limit = ?, once_per_customer = ?, active = ? WHERE id = ? RETURNING id`,
        f.vals.concat([req.params.id]));
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/coupon-admin/:id', async (req, res) => {
    try { await dbAllAsync('DELETE FROM coupons WHERE id = ? RETURNING id', [req.params.id]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/loyalty-admin/config', async (req, res) => res.json(await loyaltyConfig()));
  app.put('/api/loyalty-admin/config', async (req, res) => {
    const b = req.body || {};
    const l = { enabled: !!b.enabled, earn_per_100: Math.max(0, num(b.earn_per_100)), point_value: Math.max(0, num(b.point_value)), min_redeem: Math.max(0, Math.floor(num(b.min_redeem))), max_redeem_pct: Math.min(100, Math.max(1, num(b.max_redeem_pct, 50))) };
    try { await saveSettingsConfig({ loyalty: l }); res.json({ success: true, config: l }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/loyalty-admin/top', async (req, res) => {
    try {
      const L = await loyaltyConfig();
      const rows = await dbAllAsync(`SELECT RIGHT(customer_phone, 10) AS phone, MAX(customer_name) AS name, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS spent,
          COALESCE(SUM(CASE WHEN paid_amount >= total AND total > 0 AND COALESCE(is_complimentary, 0) = 0 THEN FLOOR(total * ? / 100) ELSE 0 END), 0) - COALESCE(SUM(points_redeemed), 0) AS points
        FROM orders WHERE customer_phone ~ '[0-9]{10}' AND UPPER(COALESCE(status, '')) NOT IN ${DEAD_STATUS}
        GROUP BY RIGHT(customer_phone, 10) ORDER BY spent DESC LIMIT 50`, [L.earn_per_100]);
      res.json(rows.map(r => ({ phone: r.phone, name: r.name || '', orders: num(r.orders), spent: num(r.spent), points: Math.max(0, num(r.points)) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- feedback ----
  async function feedbackSecret() {
    const cfg = await getSettingsConfig();
    if (cfg.feedback_secret) return cfg.feedback_secret;
    const s = crypto.randomBytes(24).toString('hex');
    await saveSettingsConfig({ feedback_secret: s });
    return s;
  }
  const sign = (secret, id) => crypto.createHmac('sha256', secret).update('fb:' + id).digest('hex').slice(0, 20);
  const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const baseUrl = (req) => (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');

  app.get('/api/feedback/qr/:orderId', async (req, res) => {
    const id = Number(req.params.orderId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
    try {
      const url = `${baseUrl(req)}/feedback.html?o=${id}&t=${sign(await feedbackSecret(), id)}`;
      const png = await QRCode.toBuffer(url, { width: 220, margin: 1 });
      res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(png);
    } catch (e) { res.status(500).end(); }
  });

  // feedback.html asks which order this link is for (token no. + whether it was already answered)
  app.get('/api/feedback/order/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !safeEq(req.query.t, sign(await feedbackSecret(), id))) return res.status(403).json({ error: 'Link sahi nahi hai' });
    try {
      const o = await dbAllAsync('SELECT token_no, customer_name FROM orders WHERE id = ?', [id]);
      if (!o[0]) return res.status(404).json({ error: 'Order nahi mila' });
      const f = await dbAllAsync('SELECT rating FROM feedback WHERE order_id = ?', [id]);
      const s = await getSettingsConfig();
      res.json({ token_no: o[0].token_no, name: o[0].customer_name || '', done: !!f[0], restaurant: (await dbAllAsync('SELECT restaurant_name FROM settings WHERE id = 1', []))[0]?.restaurant_name || '', google_review_url: String(s.google_review_url || '') });
    } catch (e) { res.status(500).json({ error: 'Kuch galat hua' }); }
  });

  app.post('/api/feedback', async (req, res) => {
    const id = Number(req.body.order_id);
    const rating = Math.floor(num(req.body.rating));
    if (!Number.isInteger(id) || !safeEq(req.body.t, sign(await feedbackSecret(), id))) return res.status(403).json({ error: 'Link sahi nahi hai' });
    if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating 1 se 5 ke beech chunein' });
    try {
      const o = await dbAllAsync('SELECT token_no, customer_name, customer_phone FROM orders WHERE id = ?', [id]);
      if (!o[0]) return res.status(404).json({ error: 'Order nahi mila' });
      const ins = await dbAllAsync(`INSERT INTO feedback (order_id, token_no, customer_name, customer_phone, rating, comment) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (order_id) DO NOTHING RETURNING id`, [id, o[0].token_no, o[0].customer_name || '', o[0].customer_phone || '', rating, String(req.body.comment || '').trim().slice(0, 500)]);
      if (!ins.length) return res.status(409).json({ error: 'Is order ka feedback pehle hi mil chuka hai. Shukriya!' });
      res.json({ success: true });
    } catch (e) { console.error('feedback save:', e.message); res.status(500).json({ error: 'Feedback save nahi hua' }); }
  });

  app.get('/api/feedback-admin', async (req, res) => {
    try {
      const days = Math.min(365, Math.max(1, Math.floor(num(req.query.days, 30))));
      const rows = await dbAllAsync(`SELECT f.id, f.order_id, f.token_no, f.customer_name, f.customer_phone, f.rating, f.comment, f.created_at
        FROM feedback f WHERE f.created_at >= CURRENT_TIMESTAMP - (? || ' days')::interval ORDER BY f.created_at DESC LIMIT 300`, [String(days)]);
      const dist = [0, 0, 0, 0, 0];
      let sum = 0;
      rows.forEach(r => { dist[r.rating - 1]++; sum += r.rating; });
      res.json({ count: rows.length, average: rows.length ? sum / rows.length : 0, distribution: dist, items: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/feedback-admin/google-url', async (req, res) => {
    const url = String(req.body.url || '').trim();
    if (url && !/^https:\/\//i.test(url)) return res.status(400).json({ error: 'Link https:// se shuru hona chahiye' });
    await saveSettingsConfig({ google_review_url: url });
    res.json({ success: true });
  });
  app.get('/api/feedback-admin/google-url', async (req, res) => res.json({ url: String((await getSettingsConfig()).google_review_url || '') }));

  // PUT /api/orders/:id (POS edit / settle): validate a newly applied coupon / points, rewrite the discount from the DB,
  // remember it on the order and let the discount-password check pass (needsAuth looks at req.promoApproved).
  async function applyPromoToOrderEdit(req, res, next) {
    const b = req.body || {};
    const hasPromoFields = !!(b.coupon_code || Number(b.points_redeem) > 0);
    if (b.is_complimentary || !hasPromoFields) {
      // A saved coupon / points redemption only stays while the discount is still the one it created; removing or replacing it releases the points / coupon.
      try {
        const id = Math.floor(num(req.params.id));
        const cur = (await dbAllAsync('SELECT coupon_code, points_redeemed, discount_reason FROM orders WHERE id = ?', [id]))[0];
        const had = cur && (cur.coupon_code || num(cur.points_redeemed) > 0);
        if (had && (b.is_complimentary || num(b.discount) <= 0 || String(b.discount_reason || '').trim() !== String(cur.discount_reason || '').trim())) {
          await dbAllAsync('UPDATE orders SET coupon_code = NULL, points_redeemed = 0 WHERE id = ? RETURNING id', [id]);
        }
      } catch (e) { console.error('Promo (release) error:', e.message); }
      return next();
    }
    try {
      const id = Math.floor(num(req.params.id));
      const promo = await computeDiscount({ subtotal: b.subtotal, phone: b.customer_phone, coupon_code: b.coupon_code, points_redeem: b.points_redeem, exclude_order_id: id });
      if (promo.error) return res.status(400).json({ error: promo.error });
      await dbAllAsync('UPDATE orders SET coupon_code = ?, points_redeemed = ? WHERE id = ? RETURNING id', [promo.couponCode || null, promo.pointsRedeemed || 0, id]);
      b.discount = promo.discount; b.discount_reason = promo.reason;
      req.promoApproved = true;
      next();
    } catch (e) { console.error('Promo (edit) error:', e.message); res.status(500).json({ error: 'Coupon / points check nahi ho paaya' }); }
  }

  return { computeDiscount, applyPromoToOrderEdit };
}

module.exports = { register };
