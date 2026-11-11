// Customer engagement: coupons, loyalty points and customer feedback.
//
// Loyalty: no separate ledger. A phone's balance is derived from its orders:
//   earned   = sum of floor(total * earn_per_100 / 100) over fully paid, non-void orders of that phone
//   redeemed = sum of orders.points_redeemed (non-void orders)
// so it stays correct whichever screen (POS, table settle, due settle...) marked the order paid.
// Config lives in settings.config.loyalty = { enabled, earn_per_100, point_value, min_redeem, max_redeem_pct,
//   expiry_days, bonus_enabled, bonus_start, bonus_end, bonus_multiplier, bonus_days, first_order_bonus, *_since }.
// The balance is replayed order by order (simulateLoyalty): points earned are lots, redemptions use the oldest lots first, lots expire
// `expiry_days` after they were earned. Expiry / bonus-hours / first-order bonus only apply from the day they were switched on (`*_since`),
// so existing customers keep their points and old orders are never re-valued.
//
// Coupons: table `coupons` (managed on /engagement.html, owner PIN). computeDiscount() is the single place that turns
// a coupon code / points to redeem into a rupee discount; createOrderHandler calls it so the client can never fake one.
//
// Feedback: receipts carry a QR (/api/feedback/qr/:orderId) that opens /feedback.html with a signed link.
const crypto = require('crypto');
const QRCode = require('qrcode');

const DEFAULT_LOYALTY = { enabled: false, earn_per_100: 5, point_value: 0.5, min_redeem: 50, max_redeem_pct: 50,
  expiry_days: 0, expiry_since: 0, bonus_enabled: false, bonus_start: '15:00', bonus_end: '18:00', bonus_multiplier: 2, bonus_days: [], bonus_since: 0, first_order_bonus: 0, first_bonus_since: 0 };
const DEAD_STATUS = "('VOID', 'CANCELLED', 'HOLD')";

const numOr = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 0; };

// Is the order time (IST wall clock: hour, minute, day of week) inside the double-points window?
function inBonusWindow(L, hh, mm, dow) {
  if (!L.bonus_enabled) return false;
  if (Array.isArray(L.bonus_days) && L.bonus_days.length && !L.bonus_days.includes(dow)) return false;
  const t = hh * 60 + mm, s = toMin(L.bonus_start), e = toMin(L.bonus_end);
  if (s === e) return false;
  return s < e ? (t >= s && t < e) : (t >= s || t < e); // window may run past midnight
}

// rows: that phone's orders (not void/hold), oldest first, with created_at, hh, mm, dow, total, paid_amount, is_complimentary, points_redeemed
const EARN_SOURCES = ['KIOSK', 'ONLINE', 'TABLE_QR'];
function simulateLoyalty(rows, L, nowMs) {
  const DAY = 86400000, lots = [];
  let earned = 0, redeemed = 0, firstSeen = false;
  const expire = (at) => { if (L.expiry_days > 0) for (let i = lots.length - 1; i >= 0; i--) if (lots[i].anchor + L.expiry_days * DAY <= at) lots.splice(i, 1); };
  for (const r of rows) {
    const at = new Date(r.created_at).getTime();
    expire(at);
    // points spent on this order come from the oldest lots; the points this order earns are added afterwards
    let red = Math.floor(numOr(r.points_redeemed));
    redeemed += red;
    while (red > 0 && lots.length) { const take = Math.min(red, lots[0].qty); lots[0].qty -= take; red -= take; if (lots[0].qty <= 0) lots.shift(); }
    if (!EARN_SOURCES.includes(String(r.source || '').toUpperCase())) continue; // points are earned only on kiosk / website / table-QR orders, not counter (POS) orders
    const paid = numOr(r.paid_amount) >= numOr(r.total) && numOr(r.total) > 0 && !numOr(r.is_complimentary);
    if (!paid) continue;
    const base = numOr(r.total) * L.earn_per_100 / 100;
    let pts = Math.floor(base);
    if (pts > 0 && at >= L.bonus_since && inBonusWindow(L, numOr(r.hh), numOr(r.mm), numOr(r.dow))) pts = Math.floor(base * L.bonus_multiplier);
    if (!firstSeen) { firstSeen = true; if (L.first_order_bonus > 0 && at >= L.first_bonus_since) pts += L.first_order_bonus; }
    if (pts > 0) { lots.push({ anchor: Math.max(at, L.expiry_since || 0), qty: pts }); earned += pts; }
  }
  expire(nowMs);
  const balance = lots.reduce((t, l) => t + l.qty, 0);
  // points that will expire within the next 30 days (and the first date it happens)
  let expiring = null;
  if (L.expiry_days > 0) {
    const soon = lots.map(l => ({ on: l.anchor + L.expiry_days * DAY, qty: l.qty })).filter(l => l.on <= nowMs + 30 * DAY);
    if (soon.length) expiring = { points: soon.reduce((t, l) => t + l.qty, 0), on: new Date(Math.min.apply(null, soon.map(l => l.on))).toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }) };
  }
  return { earned, redeemed, balance, expiring };
}

function register(app, { dbAllAsync, getSettingsConfig, saveSettingsConfig, discountPasswordOk }) {
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
  // Kiosk orders used to be saved without a source; they are recognisable by the fixed guest name the kiosk sends
  dbAllAsync(`UPDATE orders SET source = 'KIOSK' WHERE source IS NULL AND customer_name = 'Self Kiosk Guest'`, []).catch(() => {});

  // One short-lived redeem code per phone: the customer shows it on their own phone (needs their profile token), staff types it at the POS.
  dbAllAsync(`CREATE TABLE IF NOT EXISTS loyalty_codes (
    phone TEXT PRIMARY KEY, code_hash TEXT, expires_ms BIGINT, fails INTEGER DEFAULT 0, lock_until BIGINT DEFAULT 0, created_ms BIGINT
  )`, []).catch(e => console.error('loyalty_codes table error:', e.message));

  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const cleanPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const cleanCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);

  async function loyaltyConfig() {
    const cfg = await getSettingsConfig();
    const l = Object.assign({}, DEFAULT_LOYALTY, cfg.loyalty || {});
    return {
      enabled: !!l.enabled, earn_per_100: num(l.earn_per_100, 5), point_value: num(l.point_value, 0.5), min_redeem: num(l.min_redeem, 50), max_redeem_pct: num(l.max_redeem_pct, 50),
      expiry_days: Math.max(0, Math.floor(num(l.expiry_days, 0))), expiry_since: num(l.expiry_since, 0),
      bonus_enabled: !!l.bonus_enabled, bonus_start: /^\d{1,2}:\d{2}$/.test(l.bonus_start) ? l.bonus_start : '15:00', bonus_end: /^\d{1,2}:\d{2}$/.test(l.bonus_end) ? l.bonus_end : '18:00',
      bonus_multiplier: Math.min(5, Math.max(1, num(l.bonus_multiplier, 2))), bonus_days: (Array.isArray(l.bonus_days) ? l.bonus_days : []).map(Number).filter(d => d >= 0 && d <= 6), bonus_since: num(l.bonus_since, 0),
      first_order_bonus: Math.max(0, Math.floor(num(l.first_order_bonus, 0))), first_bonus_since: num(l.first_bonus_since, 0)
    };
  }

  // What customers may be told about the offers (no internals)
  const publicOffers = (L) => ({ expiry_days: L.expiry_days, first_order_bonus: L.first_order_bonus,
    bonus: L.bonus_enabled ? { start: L.bonus_start, end: L.bonus_end, multiplier: L.bonus_multiplier, days: L.bonus_days } : null });

  const ledgerCols = `id, total, paid_amount, is_complimentary, points_redeemed, source, created_at,
    EXTRACT(HOUR FROM created_at)::int AS hh, EXTRACT(MINUTE FROM created_at)::int AS mm, EXTRACT(DOW FROM created_at)::int AS dow`;

  async function loyaltyBalance(phone, L, excludeId = 0) {
    phone = cleanPhone(phone);
    if (!phone) return { phone: '', earned: 0, redeemed: 0, balance: 0, expiring: null };
    const rows = await dbAllAsync(`SELECT ${ledgerCols} FROM orders WHERE RIGHT(customer_phone, 10) = ? AND id <> ? AND UPPER(COALESCE(status, '')) NOT IN ${DEAD_STATUS} ORDER BY created_at, id`, [phone, excludeId]);
    return Object.assign({ phone }, simulateLoyalty(rows, L, Date.now()));
  }

  // ---- redeem codes ----
  const CODE_TTL_MS = 15 * 60 * 1000, MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
  const codeHash = (phone, code) => crypto.createHash('sha256').update(phone + ':' + String(code).trim()).digest('hex');
  const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  async function profileOk(phone, token) {
    phone = cleanPhone(phone);
    if (phone.length !== 10 || !token) return false;
    const r = await dbAllAsync('SELECT token FROM customer_profiles WHERE phone = ?', [phone]);
    return !!(r[0] && safeEq(r[0].token, token));
  }

  // consume=false only checks (POS "Apply" preview); consume=true spends the code when the bill is saved
  async function checkRedeemCode(phone, code, consume) {
    phone = cleanPhone(phone);
    const row = (await dbAllAsync('SELECT * FROM loyalty_codes WHERE phone = ?', [phone]))[0];
    const now = Date.now();
    if (row && num(row.lock_until) > now) return { error: 'Bahut galat codes daale gaye. 15 minute baad try karein ya staff password use karein' };
    if (!code || !row || num(row.expires_ms) < now) return { error: 'Customer ka redeem code chahiye. Customer apne phone par "My Points" se naya code dekh sakta hai' };
    if (!safeEq(row.code_hash, codeHash(phone, code))) {
      const fails = num(row.fails) + 1;
      await dbAllAsync('UPDATE loyalty_codes SET fails = ?, lock_until = ? WHERE phone = ? RETURNING phone', [fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? now + LOCK_MS : 0, phone]);
      return { error: 'Redeem code galat hai' };
    }
    if (consume) await dbAllAsync('DELETE FROM loyalty_codes WHERE phone = ? RETURNING phone', [phone]);
    return { ok: true };
  }

  // Returns { error } or { discount, couponDiscount, pointsDiscount, couponCode, pointsRedeemed, reason }
  // Points need the customer's redeem code (or the staff discount password as an override); `consume` spends the code (order save).
  async function computeDiscount({ subtotal, phone, coupon_code, points_redeem, exclude_order_id, points_code, staff_override, consume }) {
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
    let needCode = false;
    if (pts > 0) {
      const L = await loyaltyConfig();
      if (!L.enabled) return { error: 'Loyalty points abhi band hain' };
      if (!cleanPhone(phone)) return { error: 'Points redeem karne ke liye customer ka phone zaroori hai' };
      if (pts < L.min_redeem) return { error: `Kam se kam ${L.min_redeem} points redeem karne honge` };
      // Points this very order already holds (it is being edited) need no new code; only extra points do
      const held = ex ? num(((await dbAllAsync('SELECT points_redeemed FROM orders WHERE id = ? AND RIGHT(customer_phone, 10) = ?', [ex, cleanPhone(phone)]))[0] || {}).points_redeemed) : 0;
      needCode = pts > held && !staff_override;
      if (needCode) { const c = await checkRedeemCode(phone, points_code, false); if (c.error) return c; }
      const bal = await loyaltyBalance(phone, L, ex);
      if (pts > bal.balance) return { error: `Customer ke paas sirf ${bal.balance} points hain` };
      const room = Math.max(0, (subtotal - couponDiscount) * L.max_redeem_pct / 100);
      pointsDiscount = Math.round(pts * L.point_value * 100) / 100;
      if (pointsDiscount > room + 0.001) return { error: `Ek bill par max ${L.max_redeem_pct}% tak hi points redeem ho sakte hain (₹${Math.floor(room)})` };
      pointsRedeemed = pts;
    }
    if (needCode && consume) { const c = await checkRedeemCode(phone, points_code, true); if (c.error) return c; }
    const parts = [];
    if (couponCode) parts.push('Coupon ' + couponCode);
    if (pointsRedeemed) parts.push(pointsRedeemed + ' pts');
    return { discount: Math.min(subtotal, couponDiscount + pointsDiscount), couponDiscount, pointsDiscount, couponCode, pointsRedeemed, reason: parts.join(' + ') };
  }

  // ---- public / POS routes ----
  app.post('/api/coupons/validate', async (req, res) => {
    try {
      const body = req.body || {};
      const r = await computeDiscount({ ...body, staff_override: discountPasswordOk(body.auth_password), consume: false });
      if (r.error) return res.status(400).json({ error: r.error });
      res.json(r);
    } catch (e) { console.error('coupon validate:', e.message); res.status(500).json({ error: 'Coupon check nahi ho paaya' }); }
  });

  // Public: what the restaurant offers (shown as a banner on the ordering pages)
  app.get('/api/loyalty-info', async (req, res) => {
    try { const L = await loyaltyConfig(); res.json(Object.assign({ enabled: L.enabled, earn_per_100: L.earn_per_100, point_value: L.point_value }, publicOffers(L))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/loyalty/my', async (req, res) => {
    try {
      const { phone, token } = req.body || {};
      if (!(await profileOk(phone, token))) return res.status(401).json({ error: 'Profile verify nahi hui' });
      const L = await loyaltyConfig();
      const b = await loyaltyBalance(phone, L);
      res.json(Object.assign({ enabled: L.enabled, balance: b.balance, earned: b.earned, redeemed: b.redeemed, expiring: b.expiring, point_value: L.point_value, min_redeem: L.min_redeem, max_redeem_pct: L.max_redeem_pct, earn_per_100: L.earn_per_100 }, publicOffers(L)));
    } catch (e) { res.status(500).json({ error: 'Load nahi hua' }); }
  });

  // ---- WhatsApp OTP: proves the customer owns the phone, then hands back the profile token (creates the profile if needed) ----
  dbAllAsync(`CREATE TABLE IF NOT EXISTS otp_codes (phone TEXT PRIMARY KEY, code_hash TEXT, expires_ms BIGINT, attempts INTEGER DEFAULT 0, last_sent_ms BIGINT DEFAULT 0, sent_log TEXT DEFAULT '')`, [])
    .catch(e => console.error('otp_codes table error:', e.message));
  const OTP_TTL_MS = 5 * 60 * 1000, OTP_RESEND_MS = 60 * 1000, OTP_MAX_ATTEMPTS = 5, OTP_PER_HOUR = 5, OTP_DAILY_CAP = Number(process.env.OTP_DAILY_CAP) || 300;
  const otpDay = { day: '', n: 0 };

  async function sendWhatsAppOtp(phone, code) {
    const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID, tpl = process.env.WHATSAPP_OTP_TEMPLATE;
    if (!token || !phoneId || !tpl) throw new Error('WhatsApp OTP configure nahi hai');
    const r = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '91' + phone, type: 'template', template: { name: tpl, language: { code: process.env.WHATSAPP_OTP_LANG || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] } })
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('WhatsApp API ' + r.status + ' ' + t.slice(0, 300)); }
  }

  app.post('/api/otp/send', async (req, res) => {
    try {
      const ph = cleanPhone(req.body && req.body.phone);
      if (ph.length !== 10) return res.status(400).json({ error: 'Phone number sahi nahi hai' });
      const now = Date.now(), today = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
      if (otpDay.day !== today) { otpDay.day = today; otpDay.n = 0; }
      if (otpDay.n >= OTP_DAILY_CAP) return res.status(429).json({ error: 'Aaj ke OTP ki limit poori ho gayi. Kal try karein' });
      const row = (await dbAllAsync('SELECT * FROM otp_codes WHERE phone = ?', [ph]))[0];
      if (row && now - num(row.last_sent_ms) < OTP_RESEND_MS) return res.status(429).json({ error: 'Thodi der baad dobara try karein', wait: Math.ceil((OTP_RESEND_MS - (now - num(row.last_sent_ms))) / 1000) });
      const log = String((row && row.sent_log) || '').split(',').map(Number).filter(t => t && now - t < 3600 * 1000);
      if (log.length >= OTP_PER_HOUR) return res.status(429).json({ error: 'Bahut baar OTP manga. Ek ghante baad try karein' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      log.push(now);
      await dbAllAsync(`INSERT INTO otp_codes (phone, code_hash, expires_ms, attempts, last_sent_ms, sent_log) VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_ms = EXCLUDED.expires_ms, attempts = 0, last_sent_ms = EXCLUDED.last_sent_ms, sent_log = EXCLUDED.sent_log RETURNING phone`,
        [ph, codeHash(ph, code), now + OTP_TTL_MS, now, log.join(',')]);
      try { await sendWhatsAppOtp(ph, code); } catch (e) {
        console.error('otp send:', e.message);
        await dbAllAsync('UPDATE otp_codes SET last_sent_ms = 0, expires_ms = 0 WHERE phone = ? RETURNING phone', [ph]);
        return res.status(502).json({ error: 'OTP nahi bhej paaye. Thodi der baad try karein' });
      }
      otpDay.n += 1;
      res.json({ success: true, expires_in: Math.floor(OTP_TTL_MS / 1000), resend_in: Math.floor(OTP_RESEND_MS / 1000) });
    } catch (e) { console.error('otp send:', e.message); res.status(500).json({ error: 'OTP nahi bhej paaye' }); }
  });

  app.post('/api/otp/verify', async (req, res) => {
    try {
      const ph = cleanPhone(req.body && req.body.phone), code = String((req.body && req.body.code) || '').replace(/\D/g, '');
      if (ph.length !== 10 || code.length !== 6) return res.status(400).json({ error: 'OTP 6 digit ka hota hai' });
      const row = (await dbAllAsync('SELECT * FROM otp_codes WHERE phone = ?', [ph]))[0], now = Date.now();
      if (!row || num(row.expires_ms) < now || num(row.attempts) >= OTP_MAX_ATTEMPTS) return res.status(400).json({ error: 'OTP expire ho gaya. Naya OTP mangwayein' });
      if (!safeEq(row.code_hash, codeHash(ph, code))) {
        await dbAllAsync('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ? RETURNING phone', [ph]);
        return res.status(401).json({ error: 'OTP galat hai' });
      }
      await dbAllAsync('UPDATE otp_codes SET expires_ms = 0 WHERE phone = ? RETURNING phone', [ph]);
      await dbAllAsync('INSERT INTO customer_profiles (phone, name, token) VALUES (?, ?, ?) ON CONFLICT (phone) DO NOTHING', [ph, '', crypto.randomBytes(16).toString('hex')]);
      const r = (await dbAllAsync('SELECT token, name FROM customer_profiles WHERE phone = ?', [ph]))[0];
      res.json({ success: true, phone: ph, token: r.token, name: r.name || '' });
    } catch (e) { console.error('otp verify:', e.message); res.status(500).json({ error: 'Verify nahi hua' }); }
  });

  const codeAsks = new Map();
  app.post('/api/loyalty/code', async (req, res) => {
    try {
      const { phone, token } = req.body || {};
      if (!(await profileOk(phone, token))) return res.status(401).json({ error: 'Profile verify nahi hui' });
      const ph = cleanPhone(phone), now = Date.now();
      const asks = (codeAsks.get(ph) || []).filter(t => now - t < 10 * 60 * 1000);
      if (asks.length >= 6) return res.status(429).json({ error: 'Bahut baar code manga. Thodi der baad try karein.' });
      asks.push(now); codeAsks.set(ph, asks);
      const L = await loyaltyConfig();
      if (!L.enabled) return res.status(400).json({ error: 'Loyalty points abhi band hain' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await dbAllAsync(`INSERT INTO loyalty_codes (phone, code_hash, expires_ms, fails, lock_until, created_ms) VALUES (?, ?, ?, 0, 0, ?)
        ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_ms = EXCLUDED.expires_ms, fails = 0, created_ms = EXCLUDED.created_ms RETURNING phone`,
        [ph, codeHash(ph, code), now + CODE_TTL_MS, now]);
      res.json({ code, expires_in: Math.floor(CODE_TTL_MS / 1000) });
    } catch (e) { console.error('loyalty code:', e.message); res.status(500).json({ error: 'Code nahi ban paaya' }); }
  });

  app.get('/api/loyalty/:phone', async (req, res) => {
    try {
      const L = await loyaltyConfig();
      const b = await loyaltyBalance(req.params.phone, L);
      res.json(Object.assign({ enabled: L.enabled, point_value: L.point_value, min_redeem: L.min_redeem, max_redeem_pct: L.max_redeem_pct, earn_per_100: L.earn_per_100 }, publicOffers(L), b));
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
    const isNum = (v) => v !== '' && v != null && Number.isFinite(Number(v));
    if (!isNum(b.earn_per_100) || Number(b.earn_per_100) < 0) return res.status(400).json({ error: 'Earn points per ₹100 sahi daalein' });
    if (!isNum(b.point_value) || Number(b.point_value) < 0) return res.status(400).json({ error: '1 point ki value sahi daalein' });
    if (!isNum(b.min_redeem) || Number(b.min_redeem) < 0) return res.status(400).json({ error: 'Min points to redeem daalein (0 ya zyada)' });
    if (!isNum(b.max_redeem_pct) || Number(b.max_redeem_pct) < 1 || Number(b.max_redeem_pct) > 100) return res.status(400).json({ error: 'Max % of bill 1 se 100 ke beech daalein (khali chhodne par points use nahi ho paate)' });
    const days = Math.max(0, Math.floor(numOr(b.expiry_days, 0)));
    const bonusOn = !!b.bonus_enabled;
    if (bonusOn) {
      if (!/^\d{1,2}:\d{2}$/.test(String(b.bonus_start || '')) || !/^\d{1,2}:\d{2}$/.test(String(b.bonus_end || ''))) return res.status(400).json({ error: 'Double points ka start aur end time daalein' });
      if (toMin(b.bonus_start) === toMin(b.bonus_end)) return res.status(400).json({ error: 'Double points ka start aur end time alag hona chahiye' });
      if (!(numOr(b.bonus_multiplier) >= 1.5 && numOr(b.bonus_multiplier) <= 5)) return res.status(400).json({ error: 'Multiplier 1.5 se 5 ke beech rakhein' });
    }
    try {
      const prev = await loyaltyConfig(), now = Date.now();
      const bonusDays = (Array.isArray(b.bonus_days) ? b.bonus_days : []).map(Number).filter(d => d >= 0 && d <= 6).sort();
      const bonusChanged = bonusOn && (!prev.bonus_enabled || prev.bonus_start !== b.bonus_start || prev.bonus_end !== b.bonus_end || prev.bonus_multiplier !== numOr(b.bonus_multiplier) || JSON.stringify(prev.bonus_days) !== JSON.stringify(bonusDays));
      const firstBonus = Math.max(0, Math.floor(numOr(b.first_order_bonus, 0)));
      const l = {
        enabled: !!b.enabled, earn_per_100: num(b.earn_per_100), point_value: num(b.point_value), min_redeem: Math.floor(num(b.min_redeem)), max_redeem_pct: Math.min(100, num(b.max_redeem_pct)),
        expiry_days: days, expiry_since: days > 0 ? (prev.expiry_days > 0 && prev.expiry_since ? prev.expiry_since : now) : prev.expiry_since,
        bonus_enabled: bonusOn, bonus_start: bonusOn ? String(b.bonus_start) : prev.bonus_start, bonus_end: bonusOn ? String(b.bonus_end) : prev.bonus_end,
        bonus_multiplier: bonusOn ? numOr(b.bonus_multiplier, 2) : prev.bonus_multiplier, bonus_days: bonusOn ? bonusDays : prev.bonus_days, bonus_since: bonusChanged ? now : prev.bonus_since,
        first_order_bonus: firstBonus, first_bonus_since: firstBonus > 0 ? (prev.first_order_bonus > 0 && prev.first_bonus_since ? prev.first_bonus_since : now) : prev.first_bonus_since
      };
      await saveSettingsConfig({ loyalty: l });
      res.json({ success: true, config: l });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/loyalty-admin/top', async (req, res) => {
    try {
      const L = await loyaltyConfig();
      const top = await dbAllAsync(`SELECT RIGHT(customer_phone, 10) AS phone, MAX(customer_name) AS name, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS spent
        FROM orders WHERE customer_phone ~ '[0-9]{10}' AND UPPER(COALESCE(status, '')) NOT IN ${DEAD_STATUS}
        GROUP BY RIGHT(customer_phone, 10) ORDER BY spent DESC LIMIT 50`, []);
      const orders = top.length ? await dbAllAsync(`SELECT RIGHT(customer_phone, 10) AS phone, ${ledgerCols} FROM orders
        WHERE RIGHT(customer_phone, 10) = ANY(?::text[]) AND UPPER(COALESCE(status, '')) NOT IN ${DEAD_STATUS} ORDER BY created_at, id`, [top.map(t => t.phone)]) : [];
      const byPhone = new Map();
      orders.forEach(o => { (byPhone.get(o.phone) || byPhone.set(o.phone, []).get(o.phone)).push(o); });
      res.json(top.map(r => {
        const s = simulateLoyalty(byPhone.get(r.phone) || [], L, Date.now());
        return { phone: r.phone, name: r.name || '', orders: num(r.orders), spent: num(r.spent), points: s.balance, expiring: s.expiring };
      }));
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

  // Bill QR #2: one QR for both apps. /app sends Android phones to the Play Store link and iPhones to the App Store link
  // (Settings > Receipt > App Links); anything else (or a missing link) goes to app_url, then the website order page.
  const okLink = (v) => (/^https?:\/\//i.test(String(v || '').trim()) ? String(v).trim() : '');
  // Android: a plain https://play.google.com link often opens the Play Store *website* (QR scanners / in-app browsers).
  // The native market:// (via an intent:// URL for Chrome) opens the Play Store app; the https link is the fallback if the app does not take over.
  const playId = (u) => { try { const x = new URL(u); return /(^|\.)play\.google\.com$/i.test(x.hostname) ? (x.searchParams.get('id') || '') : ''; } catch (e) { return ''; } };
  app.get('/app', async (req, res) => {
    try {
      const r = (await getSettingsConfig()).receipt || {};
      const ua = String(req.get('user-agent') || '');
      const android = okLink(r.app_android_url), ios = okLink(r.app_ios_url), other = okLink(r.app_url) || '/order.html';
      res.set('Cache-Control', 'no-store');
      const isIos = /iphone|ipad|ipod/i.test(ua), isAndroid = /android/i.test(ua);
      if (isIos) return res.redirect(302, ios || other);
      if (isAndroid && !playId(android)) return res.redirect(302, android || other);
      // Android with a Play Store link, or a user-agent that does not say what the phone is: a small page decides in the browser
      const J = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
      const pid = playId(android);
      res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vishal Foodiez</title>
<body style="font-family:sans-serif;text-align:center;padding:40px"><p id="m">Opening...</p><p><a id="b" style="display:none;background:#4f46e5;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:bold">Open Play Store</a></p><script>
var a=${J(android)},i=${J(ios)},o=${J(other)},pid=${J(pid)},n=navigator,ua=n.userAgent||'',pl=(n.userAgentData&&n.userAgentData.platform)||n.platform||'',t=n.maxTouchPoints||0;
var isA=/android/i.test(ua)||/android/i.test(pl)||(/linux/i.test(pl)&&t>0);
var isI=!isA&&(/iphone|ipad|ipod/i.test(ua)||/iphone|ipad/i.test(pl)||(/mac/i.test(pl)&&t>1));
if(isI) location.replace(i||o);
else if(isA&&pid){
  var intent='intent://details?id='+pid+'#Intent;scheme=market;package=com.android.vending;S.browser_fallback_url='+encodeURIComponent(a)+';end';
  var btn=document.getElementById('b'); btn.href=intent; btn.style.display='inline-block';
  location.href=intent;
  setTimeout(function(){ if(!document.hidden) location.replace(a); },2500);
}
else location.replace(isA?(a||o):o);
</script><noscript><meta http-equiv="refresh" content="0;url=${other.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></noscript>`);
    } catch (e) { res.redirect(302, '/order.html'); }
  });
  app.get('/api/app/qr', async (req, res) => {
    try {
      const png = await QRCode.toBuffer(`${baseUrl(req)}/app`, { width: 220, margin: 1 });
      res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=300').send(png);
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
    if (Number(b.points_redeem) > 0) return res.status(400).json({ error: 'Points sirf kiosk, website ya table QR se redeem ho sakte hain' });
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
      const promo = await computeDiscount({ subtotal: b.subtotal, phone: b.customer_phone, coupon_code: b.coupon_code, points_redeem: b.points_redeem, exclude_order_id: id,
        points_code: b.points_code, staff_override: discountPasswordOk(b.auth_password), consume: true });
      if (promo.error) return res.status(400).json({ error: promo.error });
      await dbAllAsync('UPDATE orders SET coupon_code = ?, points_redeemed = ? WHERE id = ? RETURNING id', [promo.couponCode || null, promo.pointsRedeemed || 0, id]);
      b.discount = promo.discount; b.discount_reason = promo.reason;
      req.promoApproved = true;
      next();
    } catch (e) { console.error('Promo (edit) error:', e.message); res.status(500).json({ error: 'Coupon / points check nahi ho paaya' }); }
  }

  return { computeDiscount, applyPromoToOrderEdit };
}

module.exports = { register, simulateLoyalty };
