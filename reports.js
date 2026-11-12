// Owner reports: day-end/payment wise, order type, item, category, hourly, GST, discount/complimentary, due, void, customers, kitchen time.
// GET /api/reports/v2/:name?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD  (owner PIN is enforced by the /api/reports guard in server.js)
//
// A "sale" = order that was billed (COMPLETED / DISPATCHED / DUE_PENDING) and has at least one item.
// This leaves out running (unbilled) orders, VOID/MERGED orders and empty shell rows.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;

// Normalised payment bucket for an order (DUE / COMPLIMENTARY win over the raw payment_mode)
const PM = `CASE WHEN UPPER(o.status) = 'DUE_PENDING' OR UPPER(COALESCE(o.payment_mode, '')) = 'DUE' THEN 'DUE'
  WHEN COALESCE(o.is_complimentary, 0) = 1 OR UPPER(COALESCE(o.payment_mode, '')) = 'COMPLIMENTARY' THEN 'COMPLIMENTARY'
  WHEN UPPER(COALESCE(o.payment_mode, '')) IN ('CASH', 'UPI', 'CARD', 'SPLIT') THEN UPPER(o.payment_mode)
  ELSE COALESCE(NULLIF(UPPER(o.payment_mode), ''), 'UNKNOWN') END`;
const TYPE = `CASE WHEN LOWER(o.order_type) LIKE '%dine%' THEN 'Dine-In'
  WHEN LOWER(o.order_type) LIKE '%takeaway%' OR LOWER(o.order_type) LIKE '%pickup%' THEN 'Takeaway'
  WHEN LOWER(o.order_type) LIKE '%deliver%' THEN 'Delivery'
  WHEN LOWER(o.order_type) LIKE '%kiosk%' THEN 'Kiosk'
  ELSE COALESCE(NULLIF(o.order_type, ''), 'Other') END`;
const HAS_ITEMS = 'EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id)';
const SALE_WHERE = `UPPER(o.status) IN ('COMPLETED', 'DISPATCHED', 'DUE_PENDING') AND ${HAS_ITEMS}`;
const IN_RANGE = 'o.created_at::date BETWEEN ?::date AND ?::date';
// sale CTE: every report below reads FROM s
const SALES = `WITH s AS (SELECT o.*, ${PM} AS pm, ${TYPE} AS otype FROM orders o WHERE ${IN_RANGE} AND ${SALE_WHERE})`;
const BASE_ITEM = "split_part(oi.name, ' (', 1)"; // strip add-on text "(...)" so one dish = one row

function register(app, { dbAllAsync }) {
  const q = (sql, p) => dbAllAsync(sql, p || []);
  const reports = {};

  reports.dayend = async (a, b) => {
    const days = await q(`${SALES} SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') AS d, COUNT(*) AS orders, SUM(subtotal) AS subtotal, SUM(discount) AS discount, SUM(gst) AS gst, SUM(total) AS total,
      SUM(CASE WHEN pm = 'CASH' THEN total ELSE 0 END) AS cash, SUM(CASE WHEN pm = 'UPI' THEN total ELSE 0 END) AS upi, SUM(CASE WHEN pm = 'CARD' THEN total ELSE 0 END) AS card,
      SUM(CASE WHEN pm = 'SPLIT' THEN total ELSE 0 END) AS split, SUM(CASE WHEN pm = 'DUE' THEN total ELSE 0 END) AS due
      FROM s GROUP BY 1 ORDER BY 1 DESC`, [a, b]);
    const modes = await q(`${SALES} SELECT pm AS mode, COUNT(*) AS orders, SUM(total) AS total FROM s GROUP BY pm ORDER BY SUM(total) DESC`, [a, b]);
    // Money that came through the online gateways (a part of the UPI / Card sales above), by the day it was paid (IST)
    const gw = await q(`SELECT 'Razorpay' AS gateway, COUNT(*) AS payments, COALESCE(SUM(amount), 0) AS total FROM razorpay_payments
        WHERE status = 'PAID' AND (to_timestamp(created_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ?::date AND ?::date
      UNION ALL
      SELECT 'Paytm QR', COUNT(*), COALESCE(SUM(amount), 0) FROM upi_payments
        WHERE status = 'PAID' AND (to_timestamp(COALESCE(NULLIF(paid_ms, 0), created_ms) / 1000.0) AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ?::date AND ?::date`, [a, b, a, b]).catch(() => []);
    const exp = await q(`SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(CASE WHEN UPPER(payment_mode) = 'CASH' THEN amount ELSE 0 END), 0) AS cash
      FROM expenses WHERE created_at::date BETWEEN ?::date AND ?::date`, [a, b]);
    const rows = days.map(d => ({ ...d, orders: num(d.orders), subtotal: r2(d.subtotal), discount: r2(d.discount), gst: r2(d.gst), total: r2(d.total),
      cash: r2(d.cash), upi: r2(d.upi), card: r2(d.card), split: r2(d.split), due: r2(d.due) }));
    const sum = (k) => r2(rows.reduce((t, r) => t + r[k], 0));
    return { rows, totals: { orders: sum('orders'), subtotal: sum('subtotal'), discount: sum('discount'), gst: sum('gst'), total: sum('total'), cash: sum('cash'), upi: sum('upi'), card: sum('card'), split: sum('split'), due: sum('due') },
      modes: modes.map(m => ({ mode: m.mode, orders: num(m.orders), total: r2(m.total) })), gateways: gw.map(g => ({ gateway: g.gateway, payments: num(g.payments), total: r2(g.total) })), expenses: { total: r2(exp[0].total), cash: r2(exp[0].cash) } };
  };

  reports.ordertype = async (a, b) => {
    const rows = await q(`${SALES} SELECT otype AS type, COUNT(*) AS orders, SUM(subtotal) AS subtotal, SUM(discount) AS discount, SUM(gst) AS gst, SUM(total) AS total FROM s GROUP BY otype ORDER BY SUM(total) DESC`, [a, b]);
    const all = rows.reduce((t, r) => t + num(r.total), 0);
    return { rows: rows.map(r => ({ type: r.type, orders: num(r.orders), subtotal: r2(r.subtotal), discount: r2(r.discount), gst: r2(r.gst), total: r2(r.total),
      avg: r2(num(r.total) / Math.max(1, num(r.orders))), share: all ? r2(num(r.total) * 100 / all) : 0 })) };
  };

  reports.items = async (a, b) => {
    const rows = await q(`${SALES} SELECT ${BASE_ITEM} AS item, MAX(m.category) AS category, SUM(oi.qty) AS qty, SUM(oi.price * oi.qty) AS gross, COUNT(DISTINCT oi.order_id) AS orders
      FROM order_items oi JOIN s ON s.id = oi.order_id LEFT JOIN menu m ON m.name = ${BASE_ITEM}
      WHERE oi.name <> 'Delivery Charge' GROUP BY 1 ORDER BY SUM(oi.price * oi.qty) DESC`, [a, b]);
    const all = rows.reduce((t, r) => t + num(r.gross), 0);
    return { rows: rows.map(r => ({ item: r.item, category: r.category || 'Uncategorised', qty: num(r.qty), orders: num(r.orders), gross: r2(r.gross), share: all ? r2(num(r.gross) * 100 / all) : 0 })) };
  };

  reports.categories = async (a, b) => {
    const rows = await q(`${SALES} SELECT COALESCE(m.category, 'Uncategorised') AS category, SUM(oi.qty) AS qty, SUM(oi.price * oi.qty) AS gross, COUNT(DISTINCT ${BASE_ITEM}) AS dishes
      FROM order_items oi JOIN s ON s.id = oi.order_id LEFT JOIN menu m ON m.name = ${BASE_ITEM}
      WHERE oi.name <> 'Delivery Charge' GROUP BY 1 ORDER BY SUM(oi.price * oi.qty) DESC`, [a, b]);
    const all = rows.reduce((t, r) => t + num(r.gross), 0);
    return { rows: rows.map(r => ({ category: r.category, qty: num(r.qty), dishes: num(r.dishes), gross: r2(r.gross), share: all ? r2(num(r.gross) * 100 / all) : 0 })) };
  };

  reports.hourly = async (a, b) => {
    const got = await q(`${SALES} SELECT EXTRACT(HOUR FROM created_at)::int AS h, COUNT(*) AS orders, SUM(total) AS total FROM s GROUP BY 1`, [a, b]);
    const rows = [];
    for (let h = 0; h < 24; h++) {
      const g = got.find(x => x.h === h);
      const label = (h % 12 || 12) + ':00 ' + (h < 12 ? 'AM' : 'PM');
      rows.push({ hour: h, label, orders: g ? num(g.orders) : 0, total: g ? r2(g.total) : 0, avg: g ? r2(num(g.total) / Math.max(1, num(g.orders))) : 0 });
    }
    return { rows: rows.filter(r => r.orders > 0) };
  };

  reports.gst = async (a, b) => {
    const days = await q(`${SALES} SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') AS d, COUNT(*) AS orders, SUM(subtotal) AS subtotal, SUM(discount) AS discount, SUM(gst) AS gst, SUM(total) AS total FROM s GROUP BY 1 ORDER BY 1 DESC`, [a, b]);
    const rows = days.map(d => { const net = num(d.subtotal) - num(d.discount); return { d: d.d, orders: num(d.orders), net: r2(net), cgst: r2(num(d.gst) / 2), sgst: r2(num(d.gst) / 2), gst: r2(d.gst), total: r2(d.total) }; });
    const sum = (k) => r2(rows.reduce((t, r) => t + r[k], 0));
    return { rows, totals: { orders: sum('orders'), net: sum('net'), cgst: sum('cgst'), sgst: sum('sgst'), gst: sum('gst'), total: sum('total') } };
  };

  reports.discounts = async (a, b) => {
    const rows = await q(`${SALES} SELECT id, token_no, TO_CHAR(created_at, 'DD Mon HH12:MI AM') AS at, otype AS type, table_no, customer_name, customer_phone, subtotal, discount,
      COALESCE(discount_reason, '') AS reason, COALESCE(coupon_code, '') AS coupon, COALESCE(points_redeemed, 0) AS points, COALESCE(is_complimentary, 0) AS comp, total
      FROM s WHERE COALESCE(discount, 0) > 0 OR COALESCE(is_complimentary, 0) = 1 ORDER BY id DESC`, [a, b]);
    const list = rows.map(r => ({ ...r, subtotal: r2(r.subtotal), discount: r2(r.discount), total: r2(r.total), comp: num(r.comp) === 1, points: num(r.points) }));
    const comp = list.filter(r => r.comp), disc = list.filter(r => !r.comp);
    return { rows: list, totals: { discount_orders: disc.length, discount_amount: r2(disc.reduce((t, r) => t + r.discount, 0)),
      comp_orders: comp.length, comp_value: r2(comp.reduce((t, r) => t + r.discount, 0)), coupon_orders: list.filter(r => r.coupon).length } };
  };

  // Outstanding khata as of now (not limited to the date range) + due given in the selected range
  reports.due = async (a, b) => {
    const DUE_WHERE = `UPPER(o.status) NOT IN ('COMPLETED', 'DISPATCHED', 'VOID', 'MERGED') AND (UPPER(COALESCE(o.payment_mode, '')) = 'DUE' OR UPPER(o.status) = 'DUE_PENDING'
      OR (UPPER(COALESCE(o.payment_mode, '')) LIKE '%PARTIAL%' AND o.total - COALESCE(o.paid_amount, 0) > 0))`;
    const DUE_AMT = `(CASE WHEN o.total - COALESCE(o.paid_amount, 0) > 0 THEN o.total - COALESCE(o.paid_amount, 0) ELSE o.total END)`;
    const orders = await q(`SELECT o.id, o.token_no, TO_CHAR(o.created_at, 'DD Mon HH12:MI AM') AS at, o.customer_name, o.customer_phone, o.total, ${DUE_AMT} AS due,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 86400))::int AS age_days FROM orders o WHERE ${DUE_WHERE} ORDER BY o.id DESC`);
    const byCust = new Map();
    for (const o of orders) {
      const key = String(o.customer_phone || '').trim() || 'WALK-IN';
      const c = byCust.get(key) || { phone: key, name: '', orders: 0, due: 0, oldest: 0 };
      c.name = c.name || o.customer_name || ''; c.orders++; c.due += num(o.due); c.oldest = Math.max(c.oldest, num(o.age_days));
      byCust.set(key, c);
    }
    const given = await q(`${SALES} SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total FROM s WHERE pm = 'DUE'`, [a, b]);
    return { customers: [...byCust.values()].map(c => ({ ...c, due: r2(c.due) })).sort((x, y) => y.due - x.due),
      orders: orders.map(o => ({ ...o, total: r2(o.total), due: r2(o.due), age_days: num(o.age_days) })),
      outstanding: r2(orders.reduce((t, o) => t + num(o.due), 0)), given_in_range: { orders: num(given[0].orders), total: r2(given[0].total) } };
  };

  reports.voids = async (a, b) => {
    const rows = await q(`SELECT o.id, o.token_no, TO_CHAR(o.created_at, 'DD Mon HH12:MI AM') AS at, ${TYPE} AS type, o.table_no, o.customer_name, o.customer_phone, o.total,
      (SELECT STRING_AGG(x.name || ' x' || x.qty, ', ' ORDER BY x.id) FROM order_items x WHERE x.order_id = o.id AND x.name <> 'Delivery Charge') AS items
      FROM orders o WHERE ${IN_RANGE} AND UPPER(o.status) = 'VOID' ORDER BY o.id DESC`, [a, b]);
    return { rows: rows.map(r => ({ ...r, total: r2(r.total), items: r.items || '' })), totals: { orders: rows.length, value: r2(rows.reduce((t, r) => t + num(r.total), 0)) } };
  };

  reports.customers = async (a, b) => {
    const PH = "RIGHT(REGEXP_REPLACE(COALESCE(s.customer_phone, ''), '[^0-9]', '', 'g'), 10)";
    const rows = await q(`${SALES} SELECT ${PH} AS phone, MAX(NULLIF(s.customer_name, '')) AS name, COUNT(*) AS orders, SUM(s.total) AS spent, MIN(s.created_at) AS first_at, MAX(s.created_at) AS last_at,
      COUNT(NULLIF(s.coupon_code, '')) AS coupons, COALESCE(SUM(s.points_redeemed), 0) AS points
      FROM s WHERE LENGTH(${PH}) = 10 GROUP BY ${PH} ORDER BY SUM(s.total) DESC LIMIT 300`, [a, b]);
    // orders each customer placed before the selected range (=> returning customer)
    const prior = rows.length ? await q(`SELECT RIGHT(REGEXP_REPLACE(COALESCE(p.customer_phone, ''), '[^0-9]', '', 'g'), 10) AS phone, COUNT(*) AS n FROM orders p
      WHERE p.created_at::date < ?::date AND UPPER(p.status) IN ('COMPLETED', 'DISPATCHED', 'DUE_PENDING')
        AND RIGHT(REGEXP_REPLACE(COALESCE(p.customer_phone, ''), '[^0-9]', '', 'g'), 10) = ANY(?::text[]) GROUP BY 1`, [a, rows.map(r => r.phone)]) : [];
    const priorBy = new Map(prior.map(p => [p.phone, num(p.n)]));
    rows.forEach(r => { r.prior = priorBy.get(r.phone) || 0; });
    const anon = await q(`${SALES} SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total FROM s WHERE LENGTH(RIGHT(REGEXP_REPLACE(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10)) < 10`, [a, b]);
    const list = rows.map(r => ({ phone: r.phone, name: r.name || '', orders: num(r.orders), spent: r2(r.spent), avg: r2(num(r.spent) / Math.max(1, num(r.orders))),
      first_at: r.first_at, last_at: r.last_at, coupons: num(r.coupons), points: num(r.points), repeat: num(r.orders) > 1 || num(r.prior) > 0 }));
    const rep = list.filter(c => c.repeat);
    return { rows: list, totals: { customers: list.length, repeat: rep.length, new_customers: list.length - rep.length, repeat_spend: r2(rep.reduce((t, c) => t + c.spent, 0)),
      total_spend: r2(list.reduce((t, c) => t + c.spent, 0)), no_phone_orders: num(anon[0].orders), no_phone_spend: r2(anon[0].total) } };
  };

  // Kitchen time = accepted (or placed) -> marked ready on KDS
  reports.kitchen = async (a, b) => {
    const BASE = `FROM orders o WHERE ${IN_RANGE} AND UPPER(o.status) NOT IN ('VOID', 'MERGED') AND o.ready_at IS NOT NULL AND o.ready_at >= COALESCE(o.accepted_at, o.created_at)`;
    const MIN = 'EXTRACT(EPOCH FROM (o.ready_at - COALESCE(o.accepted_at, o.created_at))) / 60';
    const sum = (await q(`SELECT COUNT(*) AS n, AVG(${MIN}) AS avg, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${MIN}) AS median, MAX(${MIN}) AS max,
      COUNT(CASE WHEN ${MIN} > 10 THEN 1 END) AS slow ${BASE}`, [a, b]))[0];
    const byType = await q(`SELECT ${TYPE} AS type, COUNT(*) AS n, AVG(${MIN}) AS avg, MAX(${MIN}) AS max ${BASE} GROUP BY 1 ORDER BY 2 DESC`, [a, b]);
    const byDay = await q(`SELECT TO_CHAR(o.created_at::date, 'YYYY-MM-DD') AS d, COUNT(*) AS n, AVG(${MIN}) AS avg, MAX(${MIN}) AS max ${BASE} GROUP BY 1 ORDER BY 1 DESC`, [a, b]);
    const slowest = await q(`SELECT o.id, o.token_no, TO_CHAR(o.created_at, 'DD Mon HH12:MI AM') AS at, ${TYPE} AS type, o.table_no, ${MIN} AS minutes,
      (SELECT STRING_AGG(x.name || ' x' || x.qty, ', ' ORDER BY x.id) FROM order_items x WHERE x.order_id = o.id AND x.name <> 'Delivery Charge') AS items ${BASE} ORDER BY ${MIN} DESC LIMIT 20`, [a, b]);
    const n = num(sum.n);
    return { summary: { orders: n, avg: r2(sum.avg), median: r2(sum.median), max: r2(sum.max), slow: num(sum.slow), slow_pct: n ? r2(num(sum.slow) * 100 / n) : 0 },
      byType: byType.map(r => ({ type: r.type, orders: num(r.n), avg: r2(r.avg), max: r2(r.max) })), byDay: byDay.map(r => ({ d: r.d, orders: num(r.n), avg: r2(r.avg), max: r2(r.max) })),
      slowest: slowest.map(r => ({ ...r, minutes: r2(r.minutes), items: r.items || '' })) };
  };

  app.get('/api/reports/v2/:name', async (req, res) => {
    const fn = reports[req.params.name];
    if (!fn) return res.status(404).json({ error: 'Report nahi mili' });
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
    const a = DATE_RE.test(req.query.startDate || '') ? req.query.startDate : today;
    const b = DATE_RE.test(req.query.endDate || '') ? req.query.endDate : today;
    if (a > b) return res.status(400).json({ error: 'From date, To date se pehle honi chahiye' });
    try { res.json(await fn(a, b)); }
    catch (e) { console.error(`[REPORT ${req.params.name}]`, e.message); res.status(500).json({ error: 'Report load nahi hui: ' + e.message }); }
  });
}

module.exports = { register };
