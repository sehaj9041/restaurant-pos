// Table QR ordering: every table gets a QR that opens /table-order.html?t=<table>&k=<signature>.
// The signature (HMAC with a secret kept in settings) stops people from ordering for tables by guessing the URL.
// Orders are rebuilt from the DB (prices, add-ons) by createOrderHandler, land in "Needs approval" and are paid at the counter.
const crypto = require('crypto');
const QRCode = require('qrcode');

const sig = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex').slice(0, 16);
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cleanText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function register(app, { dbAllAsync, getSettingsConfig, saveSettingsConfig, storeStatus, createOrderHandler }) {
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

  // ---- customer side (public) ----
  app.get('/api/table-qr/info', async (req, res) => {
    try {
      const table = await verifyTable(req.query.t, req.query.k);
      if (!table) return res.status(403).json({ error: 'Ye QR sahi nahi hai. Staff se poochhein.' });
      const cfg = await getSettingsConfig();
      const st = storeStatus(cfg);
      res.json({ table, open: !!st.open, message: st.message || '', restaurant: await restaurantName() });
    } catch (e) { res.status(500).json({ error: 'Load nahi hua' }); }
  });

  app.post('/api/table-qr/order', async (req, res) => {
    try {
      const b = req.body || {};
      const table = await verifyTable(b.t, b.k);
      if (!table) return res.status(403).json({ error: 'Ye QR sahi nahi hai. Staff se poochhein.' });
      const ip = (req.get('x-forwarded-for') || '').split(',').pop().trim() || req.ip || 'x';
      if (limited('ip:' + ip, 15, 600000) || limited('tbl:' + table, 10, 600000)) return res.status(429).json({ error: 'Bahut zyada orders. Thodi der baad try karein ya staff ko bulayein.' });
      const phone = cleanText(b.customer_phone, 15).replace(/\D/g, '');
      if (phone && !/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10-digit mobile number daalein (ya khali chhodein)' });
      const note = cleanText(b.note, 200);
      const items = Array.isArray(b.items) ? b.items.slice(0, 60).map((l, i) => ({
        id: Number(l && l.id), qty: Number(l && l.qty), variant: l && l.variant ? String(l.variant).slice(0, 80) : undefined,
        addons: Array.isArray(l && l.addons) ? l.addons.slice(0, 30).map(a => ({ name: String((a && a.name) || '').slice(0, 80) })) : [],
        notes: i === 0 && note ? 'Note: ' + note : ''
      })) : [];
      // only these fields are ever read from a public request: no discount / payment / status can be injected
      req.body = { order_type: 'Dine-In', table_no: table, customer_name: cleanText(b.customer_name, 60) || 'Table Guest', customer_phone: phone, items };
      req.tableQr = { table };
      const origJson = res.json.bind(res);
      res.json = async (d) => {
        if (d && d.success && d.orderId) d.track = await orderSig(d.orderId);
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
      const o = (await q("SELECT id, token_no, status, table_no, total, source FROM orders WHERE id = ?", [id]))[0];
      if (!o || o.source !== 'TABLE_QR') return res.status(404).json({ error: 'Order nahi mila' });
      const st = String(o.status || '').toUpperCase();
      let state = 'preparing', step = 1;
      if (st === 'NEEDS_APPROVAL') { state = 'waiting'; step = 0; }
      else if (st === 'KOT_DONE') { state = 'ready'; step = 2; }
      else if (['DISPATCHED', 'COMPLETED', 'DUE_PENDING'].includes(st)) { state = 'served'; step = 3; }
      else if (['VOID', 'CANCELLED'].includes(st)) { state = 'rejected'; step = 0; }
      // MERGED = accepted and added to the table's running bill; its readiness is tracked on that bill
      const items = await q("SELECT name, qty FROM order_items WHERE order_id = ? ORDER BY id", [id]);
      res.json({ id: o.id, token_no: o.token_no, state, step, table: o.table_no, total: o.total, items });
    } catch (e) { res.status(500).json({ error: 'Load nahi hua' }); }
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
}

module.exports = { register };
