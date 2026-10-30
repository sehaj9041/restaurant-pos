// Staff, attendance (PIN punch + manual) and hourly payroll.
// Admin endpoints need the owner PIN (x-owner-pin header). Only POST /api/attendance/punch is public (staff PIN).
// Times are stored as TIMESTAMPTZ and always shown/bucketed in IST.
//
// Payroll maths (hourly): each completed shift -> regular = min(hours, shift_hours), overtime = rest.
// gross = regular*rate + overtime*rate*ot_multiplier. net = gross + bonus - deductions - advance recovered.
const TZ = 'Asia/Kolkata';
const LOCAL = (col) => `(${col} AT TIME ZONE '${TZ}')`;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function register(app, { dbAllAsync, checkOwnerPin }) {
  const q = (sql, p) => dbAllAsync(sql, p || []);
  const fail = (res, e, code) => res.status(code || 500).json({ error: e && e.message ? e.message : String(e) });

  (async () => {
    try {
      await q(`CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', role TEXT DEFAULT '',
        pin TEXT, biometric_id TEXT, hourly_rate NUMERIC DEFAULT 0, shift_hours NUMERIC DEFAULT 8,
        ot_multiplier NUMERIC DEFAULT 1.5, active BOOLEAN DEFAULT TRUE, joined_on DATE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      await q(`CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY, staff_id INTEGER NOT NULL, in_time TIMESTAMPTZ NOT NULL, out_time TIMESTAMPTZ,
        source TEXT DEFAULT 'MANUAL', note TEXT DEFAULT '')`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS attendance_staff_in_uq ON attendance (staff_id, in_time)`);
      await q(`CREATE TABLE IF NOT EXISTS staff_advances (
        id SERIAL PRIMARY KEY, staff_id INTEGER NOT NULL, amount NUMERIC NOT NULL, given_on DATE DEFAULT CURRENT_DATE,
        note TEXT DEFAULT '', recovered NUMERIC DEFAULT 0, expense_id INTEGER)`);
      await q(`CREATE TABLE IF NOT EXISTS staff_adjustments (
        id SERIAL PRIMARY KEY, staff_id INTEGER NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL,
        amount NUMERIC NOT NULL, note TEXT DEFAULT '')`);
      await q(`CREATE TABLE IF NOT EXISTS payroll (
        id SERIAL PRIMARY KEY, staff_id INTEGER NOT NULL, month TEXT NOT NULL, hours NUMERIC, ot_hours NUMERIC,
        rate NUMERIC, ot_multiplier NUMERIC, gross NUMERIC, bonus NUMERIC, deductions NUMERIC, advance_deducted NUMERIC,
        net_pay NUMERIC, payment_mode TEXT, expense_id INTEGER, paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (staff_id, month))`);
      await q(`CREATE TABLE IF NOT EXISTS advance_recoveries (
        id SERIAL PRIMARY KEY, payroll_id INTEGER NOT NULL, advance_id INTEGER NOT NULL, amount NUMERIC NOT NULL)`);
    } catch (e) { console.error('staffPayroll table error:', e.message); }
  })();

  const admin = (req, res, next) => checkOwnerPin(req.get('x-owner-pin'), (ok) => (ok ? next() : res.status(401).json({ error: 'Owner PIN required' })));
  app.use(['/api/staff', '/api/staff-advances', '/api/staff-adjustments', '/api/payroll'], admin);
  app.use('/api/attendance', (req, res, next) => (req.path === '/punch' && req.method === 'POST' ? next() : admin(req, res, next)));

  const toNum = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

  // ---------------- Staff ----------------
  app.get('/api/staff', async (req, res) => {
    try {
      res.json(await q(`SELECT id, name, phone, role, biometric_id, hourly_rate, shift_hours, ot_multiplier, active,
        TO_CHAR(joined_on, 'YYYY-MM-DD') AS joined_on, (pin IS NOT NULL AND pin <> '') AS has_pin FROM staff ORDER BY active DESC, name`));
    } catch (e) { fail(res, e); }
  });

  async function pinTaken(pin, exceptId) {
    if (!pin) return false;
    return (await q('SELECT id FROM staff WHERE pin = ? AND id <> ?', [pin, exceptId || 0])).length > 0;
  }

  function staffFields(b) {
    const name = String(b.name || '').trim();
    const pin = b.pin == null ? null : String(b.pin).trim();
    if (!name) throw new Error('Naam zaroori hai');
    if (pin && !/^\d{4,6}$/.test(pin)) throw new Error('Staff PIN 4-6 digits ka hona chahiye');
    return {
      name, pin, phone: String(b.phone || '').trim(), role: String(b.role || '').trim(),
      biometric_id: String(b.biometric_id || '').trim() || null,
      hourly_rate: toNum(b.hourly_rate, 0), shift_hours: toNum(b.shift_hours, 8) || 8, ot_multiplier: toNum(b.ot_multiplier, 1.5) || 1,
      joined_on: /^\d{4}-\d{2}-\d{2}$/.test(b.joined_on || '') ? b.joined_on : null
    };
  }

  app.post('/api/staff', async (req, res) => {
    try {
      const f = staffFields(req.body || {});
      if (await pinTaken(f.pin)) return fail(res, 'Ye PIN kisi aur staff ke paas hai', 409);
      const r = await q(`INSERT INTO staff (name, phone, role, pin, biometric_id, hourly_rate, shift_hours, ot_multiplier, joined_on)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [f.name, f.phone, f.role, f.pin, f.biometric_id, f.hourly_rate, f.shift_hours, f.ot_multiplier, f.joined_on]);
      res.json({ success: true, id: r[0].id });
    } catch (e) { fail(res, e, 400); }
  });

  app.put('/api/staff/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const f = staffFields(b);
      if (f.pin && await pinTaken(f.pin, id)) return fail(res, 'Ye PIN kisi aur staff ke paas hai', 409);
      // pin omitted/blank = keep current PIN
      await q(`UPDATE staff SET name=?, phone=?, role=?, pin=COALESCE(NULLIF(?, ''), pin), biometric_id=?, hourly_rate=?, shift_hours=?,
        ot_multiplier=?, joined_on=?, active=? WHERE id=?`,
        [f.name, f.phone, f.role, f.pin || '', f.biometric_id, f.hourly_rate, f.shift_hours, f.ot_multiplier, f.joined_on, b.active === false ? false : true, id]);
      res.json({ success: true });
    } catch (e) { fail(res, e, 400); }
  });

  // ---------------- Attendance ----------------
  const failures = new Map(); // ip -> { n, until }
  app.post('/api/attendance/punch', async (req, res) => {
    const ip = (req.get('x-forwarded-for') || '').split(',').pop().trim() || req.ip || 'x'; // last hop = added by Render's proxy
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return fail(res, 'Bahut galat PIN. Thodi der baad try karein.', 429);
    try {
      const pin = String((req.body && req.body.pin) || '').trim();
      const s = pin ? (await q('SELECT id, name FROM staff WHERE pin = ? AND active = TRUE', [pin]))[0] : null;
      if (!s) {
        const base = f && !(f.until && f.until <= Date.now()) ? f.n : 0;
        const n = base + 1;
        failures.set(ip, { n, until: n >= 8 ? Date.now() + 60000 : 0 });
        return fail(res, 'Galat PIN', 401);
      }
      failures.delete(ip);
      const open = (await q('SELECT id, EXTRACT(EPOCH FROM (NOW() - in_time)) AS age FROM attendance WHERE staff_id = ? AND out_time IS NULL ORDER BY in_time DESC LIMIT 1', [s.id]))[0];
      const fmt = `TO_CHAR(${LOCAL('NOW()')}, 'DD Mon HH12:MI AM') AS time`;
      if (open) {
        if (Number(open.age) < 60) return fail(res, `${s.name}, aapka Punch In abhi ho chuka hai`, 409);
        const r = await q(`UPDATE attendance SET out_time = NOW() WHERE id = ? AND out_time IS NULL RETURNING id,
          EXTRACT(EPOCH FROM (out_time - in_time))/3600 AS hrs, ${fmt}`, [open.id]);
        if (!r.length) return fail(res, 'Punch pehle hi ho chuka hai', 409);
        return res.json({ success: true, action: 'OUT', name: s.name, time: r[0].time, hours: r2(r[0].hrs) });
      }
      const r = await q(`INSERT INTO attendance (staff_id, in_time, source) VALUES (?, NOW(), 'PIN') RETURNING id, ${fmt}`, [s.id]);
      res.json({ success: true, action: 'IN', name: s.name, time: r[0].time });
    } catch (e) { fail(res, e); }
  });

  const attSelect = `SELECT a.id, a.staff_id, s.name, a.source, a.note,
    TO_CHAR(${LOCAL('a.in_time')}, 'YYYY-MM-DD"T"HH24:MI') AS in_local,
    TO_CHAR(${LOCAL('a.out_time')}, 'YYYY-MM-DD"T"HH24:MI') AS out_local,
    TO_CHAR(${LOCAL('a.in_time')}, 'YYYY-MM-DD') AS work_date,
    CASE WHEN a.out_time IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM (a.out_time - a.in_time))/3600 END AS hours
    FROM attendance a JOIN staff s ON s.id = a.staff_id`;

  app.get('/api/attendance', async (req, res) => {
    try {
      const month = String(req.query.month || '');
      if (!MONTH_RE.test(month)) return fail(res, 'month=YYYY-MM chahiye', 400);
      const sid = Number(req.query.staff_id) || null;
      const rows = await q(`${attSelect} WHERE TO_CHAR(${LOCAL('a.in_time')}, 'YYYY-MM') = ? ${sid ? 'AND a.staff_id = ?' : ''} ORDER BY a.in_time DESC`,
        sid ? [month, sid] : [month]);
      res.json(rows.map(r => ({ ...r, hours: r.hours == null ? null : r2(r.hours) })));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/attendance/today', async (req, res) => {
    try {
      const rows = await q(`${attSelect} WHERE TO_CHAR(${LOCAL('a.in_time')}, 'YYYY-MM-DD') = TO_CHAR(${LOCAL('NOW()')}, 'YYYY-MM-DD') OR a.out_time IS NULL ORDER BY a.in_time DESC`);
      res.json(rows.map(r => ({ ...r, hours: r.hours == null ? null : r2(r.hours) })));
    } catch (e) { fail(res, e); }
  });

  function shiftInput(b) {
    const staffId = Number(b.staff_id);
    const inT = String(b.in_time || ''), outT = b.out_time ? String(b.out_time) : '';
    if (!staffId) throw new Error('Staff chuno');
    if (!DT_RE.test(inT) || (outT && !DT_RE.test(outT))) throw new Error('Time ka format galat hai');
    if (outT && outT <= inT) throw new Error('Out time, In time ke baad ka hona chahiye');
    return { staffId, inT, outT: outT || null, note: String(b.note || '').slice(0, 200) };
  }
  const ist = (p) => `(${p}::timestamp AT TIME ZONE '${TZ}')`;

  app.post('/api/attendance', async (req, res) => {
    try {
      const f = shiftInput(req.body || {});
      const r = await q(`INSERT INTO attendance (staff_id, in_time, out_time, source, note) VALUES (?, ${ist('?')}, ${f.outT ? ist('?') : 'NULL'}, 'MANUAL', ?) RETURNING id`,
        f.outT ? [f.staffId, f.inT, f.outT, f.note] : [f.staffId, f.inT, f.note]);
      res.json({ success: true, id: r[0].id });
    } catch (e) { fail(res, /unique/i.test(e.message) ? 'Is time pe entry pehle se hai' : e, 400); }
  });

  app.put('/api/attendance/:id', async (req, res) => {
    try {
      const f = shiftInput(req.body || {});
      await q(`UPDATE attendance SET staff_id = ?, in_time = ${ist('?')}, out_time = ${f.outT ? ist('?') : 'NULL'}, note = ? WHERE id = ?`,
        f.outT ? [f.staffId, f.inT, f.outT, f.note, req.params.id] : [f.staffId, f.inT, f.note, req.params.id]);
      res.json({ success: true });
    } catch (e) { fail(res, /unique/i.test(e.message) ? 'Is time pe entry pehle se hai' : e, 400); }
  });

  app.delete('/api/attendance/:id', async (req, res) => {
    try { await q('DELETE FROM attendance WHERE id = ?', [req.params.id]); res.json({ success: true }); } catch (e) { fail(res, e); }
  });

  // ---------------- Advances ----------------
  app.get('/api/staff-advances', async (req, res) => {
    try {
      const sid = Number(req.query.staff_id) || null;
      res.json(await q(`SELECT a.id, a.staff_id, s.name, a.amount, a.recovered, a.note, TO_CHAR(a.given_on, 'YYYY-MM-DD') AS given_on
        FROM staff_advances a JOIN staff s ON s.id = a.staff_id ${sid ? 'WHERE a.staff_id = ?' : ''} ORDER BY a.id DESC LIMIT 300`, sid ? [sid] : []));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/staff-advances', async (req, res) => {
    try {
      const b = req.body || {};
      const staffId = Number(b.staff_id), amount = r2(b.amount);
      if (!staffId || amount <= 0) return fail(res, 'Staff aur amount (>0) zaroori hai', 400);
      const s = (await q('SELECT name FROM staff WHERE id = ?', [staffId]))[0];
      if (!s) return fail(res, 'Staff nahi mila', 404);
      const note = String(b.note || '').slice(0, 200);
      let expenseId = null;
      if (b.add_expense !== false) {
        expenseId = (await q('INSERT INTO expenses (title, amount, payment_mode) VALUES (?, ?, ?) RETURNING id',
          [`Staff Advance - ${s.name}`, amount, String(b.payment_mode || 'CASH')]))[0].id;
      }
      const r = await q('INSERT INTO staff_advances (staff_id, amount, note, expense_id) VALUES (?, ?, ?, ?) RETURNING id', [staffId, amount, note, expenseId]);
      res.json({ success: true, id: r[0].id });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/staff-advances/:id', async (req, res) => {
    try {
      const a = (await q('SELECT recovered, expense_id FROM staff_advances WHERE id = ?', [req.params.id]))[0];
      if (!a) return fail(res, 'Nahi mila', 404);
      if (Number(a.recovered) > 0) return fail(res, 'Is advance ka kuch hissa salary se kat chuka hai, delete nahi ho sakta', 409);
      await q('DELETE FROM staff_advances WHERE id = ?', [req.params.id]);
      if (a.expense_id) await q('DELETE FROM expenses WHERE id = ?', [a.expense_id]);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------- Bonus / deductions ----------------
  const monthPaid = async (staffId, month) => (await q('SELECT id FROM payroll WHERE staff_id = ? AND month = ?', [staffId, month])).length > 0;

  app.get('/api/staff-adjustments', async (req, res) => {
    try {
      const month = String(req.query.month || '');
      if (!MONTH_RE.test(month)) return fail(res, 'month=YYYY-MM chahiye', 400);
      res.json(await q(`SELECT j.id, j.staff_id, s.name, j.month, j.kind, j.amount, j.note FROM staff_adjustments j JOIN staff s ON s.id = j.staff_id
        WHERE j.month = ? ORDER BY j.id DESC`, [month]));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/staff-adjustments', async (req, res) => {
    try {
      const b = req.body || {};
      const staffId = Number(b.staff_id), amount = r2(b.amount), kind = b.kind === 'DEDUCTION' ? 'DEDUCTION' : 'BONUS';
      if (!staffId || amount <= 0 || !MONTH_RE.test(String(b.month || ''))) return fail(res, 'Staff, month aur amount (>0) zaroori hai', 400);
      if (await monthPaid(staffId, b.month)) return fail(res, 'Is mahine ki salary paid ho chuki hai', 409);
      const r = await q('INSERT INTO staff_adjustments (staff_id, month, kind, amount, note) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [staffId, b.month, kind, amount, String(b.note || '').slice(0, 200)]);
      res.json({ success: true, id: r[0].id });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/staff-adjustments/:id', async (req, res) => {
    try {
      const j = (await q('SELECT staff_id, month FROM staff_adjustments WHERE id = ?', [req.params.id]))[0];
      if (!j) return fail(res, 'Nahi mila', 404);
      if (await monthPaid(j.staff_id, j.month)) return fail(res, 'Is mahine ki salary paid ho chuki hai', 409);
      await q('DELETE FROM staff_adjustments WHERE id = ?', [req.params.id]);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------- Payroll ----------------
  async function compute(staff, month) {
    const shifts = await q(`SELECT EXTRACT(EPOCH FROM (out_time - in_time))/3600 AS hrs FROM attendance
      WHERE staff_id = ? AND out_time IS NOT NULL AND TO_CHAR(${LOCAL('in_time')}, 'YYYY-MM') = ?`, [staff.id, month]);
    const open = (await q(`SELECT COUNT(*)::int AS n FROM attendance WHERE staff_id = ? AND out_time IS NULL AND TO_CHAR(${LOCAL('in_time')}, 'YYYY-MM') = ?`, [staff.id, month]))[0].n;
    const sh = Number(staff.shift_hours) || 8, rate = Number(staff.hourly_rate) || 0, mult = Number(staff.ot_multiplier) || 1;
    let reg = 0, ot = 0;
    for (const s of shifts) { const h = Math.max(0, Number(s.hrs) || 0); reg += Math.min(h, sh); ot += Math.max(0, h - sh); }
    const gross = r2(reg * rate + ot * rate * mult);
    const adj = await q('SELECT kind, SUM(amount) AS t FROM staff_adjustments WHERE staff_id = ? AND month = ? GROUP BY kind', [staff.id, month]);
    const sum = (k) => r2((adj.find(a => a.kind === k) || {}).t);
    const bonus = sum('BONUS'), deductions = sum('DEDUCTION');
    const advanceDue = r2((await q('SELECT COALESCE(SUM(amount - recovered), 0) AS t FROM staff_advances WHERE staff_id = ?', [staff.id]))[0].t);
    const before = r2(gross + bonus - deductions);
    return {
      staff_id: staff.id, name: staff.name, role: staff.role, rate, ot_multiplier: mult, shift_hours: sh,
      days: shifts.length, hours: r2(reg + ot), regular_hours: r2(reg), ot_hours: r2(ot), open_shifts: open,
      gross, bonus, deductions, advance_due: advanceDue,
      advance_deduct: r2(Math.max(0, Math.min(advanceDue, before))), net_before_advance: before
    };
  }

  app.get('/api/payroll/preview', async (req, res) => {
    try {
      const month = String(req.query.month || '');
      if (!MONTH_RE.test(month)) return fail(res, 'month=YYYY-MM chahiye', 400);
      const staff = await q(`SELECT * FROM staff WHERE active = TRUE OR id IN (SELECT staff_id FROM payroll WHERE month = ?)
        OR id IN (SELECT staff_id FROM attendance WHERE TO_CHAR(${LOCAL('in_time')}, 'YYYY-MM') = ?) ORDER BY name`, [month, month]);
      const paid = await q('SELECT * FROM payroll WHERE month = ?', [month]);
      const out = [];
      for (const s of staff) {
        const c = await compute(s, month);
        const p = paid.find(x => x.staff_id === s.id);
        if (p) {
          Object.assign(c, { hours: r2(p.hours), ot_hours: r2(p.ot_hours), gross: r2(p.gross), bonus: r2(p.bonus), deductions: r2(p.deductions),
            advance_deduct: r2(p.advance_deducted), rate: r2(p.rate), ot_multiplier: Number(p.ot_multiplier) });
        }
        c.net = p ? r2(p.net_pay) : r2(c.net_before_advance - c.advance_deduct);
        c.payroll_id = p ? p.id : null;
        c.paid = !!p;
        out.push(c);
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  app.post('/api/payroll/pay', async (req, res) => {
    let payrollId = null;
    try {
      const b = req.body || {};
      const staffId = Number(b.staff_id), month = String(b.month || '');
      if (!staffId || !MONTH_RE.test(month)) return fail(res, 'staff_id aur month zaroori hai', 400);
      const staff = (await q('SELECT * FROM staff WHERE id = ?', [staffId]))[0];
      if (!staff) return fail(res, 'Staff nahi mila', 404);
      if (await monthPaid(staffId, month)) return fail(res, 'Is mahine ki salary pehle hi paid hai', 409);
      const c = await compute(staff, month);
      if (c.open_shifts > 0 && !b.force) return fail(res, `${c.open_shifts} shift me Out time nahi hai. Pehle usko theek karein.`, 409);
      const adv = b.advance_deduct == null ? c.advance_deduct : r2(Math.max(0, Math.min(Number(b.advance_deduct) || 0, c.advance_due, c.net_before_advance)));
      const net = r2(c.net_before_advance - adv);
      const mode = String(b.payment_mode || 'CASH');

      const ins = await q(`INSERT INTO payroll (staff_id, month, hours, ot_hours, rate, ot_multiplier, gross, bonus, deductions, advance_deducted, net_pay, payment_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (staff_id, month) DO NOTHING RETURNING id`,
        [staffId, month, c.hours, c.ot_hours, c.rate, c.ot_multiplier, c.gross, c.bonus, c.deductions, adv, net, mode]);
      if (!ins.length) return fail(res, 'Is mahine ki salary pehle hi paid hai', 409);
      payrollId = ins[0].id;

      let left = adv;
      const advances = await q('SELECT id, amount, recovered FROM staff_advances WHERE staff_id = ? AND amount > recovered ORDER BY id', [staffId]);
      for (const a of advances) {
        if (left <= 0) break;
        const take = r2(Math.min(left, Number(a.amount) - Number(a.recovered)));
        await q('UPDATE staff_advances SET recovered = recovered + ? WHERE id = ?', [take, a.id]);
        await q('INSERT INTO advance_recoveries (payroll_id, advance_id, amount) VALUES (?, ?, ?)', [payrollId, a.id, take]);
        left = r2(left - take);
      }
      if (net > 0) {
        const e = await q('INSERT INTO expenses (title, amount, payment_mode) VALUES (?, ?, ?) RETURNING id', [`Salary - ${staff.name} (${month})`, net, mode]);
        await q('UPDATE payroll SET expense_id = ? WHERE id = ?', [e[0].id, payrollId]);
      }
      res.json({ success: true, payroll_id: payrollId, net_pay: net });
    } catch (e) { fail(res, e); }
  });

  // Undo a paid month: restores advance recoveries and removes the expense entry.
  app.delete('/api/payroll/:id', async (req, res) => {
    try {
      const p = (await q('SELECT id, expense_id FROM payroll WHERE id = ?', [req.params.id]))[0];
      if (!p) return fail(res, 'Nahi mila', 404);
      for (const r of await q('SELECT advance_id, amount FROM advance_recoveries WHERE payroll_id = ?', [p.id])) {
        await q('UPDATE staff_advances SET recovered = GREATEST(0, recovered - ?) WHERE id = ?', [r.amount, r.advance_id]);
      }
      await q('DELETE FROM advance_recoveries WHERE payroll_id = ?', [p.id]);
      if (p.expense_id) await q('DELETE FROM expenses WHERE id = ?', [p.expense_id]);
      await q('DELETE FROM payroll WHERE id = ?', [p.id]);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/payroll/payslip', async (req, res) => {
    try {
      const staffId = Number(req.query.staff_id), month = String(req.query.month || '');
      if (!staffId || !MONTH_RE.test(month)) return fail(res, 'staff_id aur month zaroori hai', 400);
      const staff = (await q('SELECT * FROM staff WHERE id = ?', [staffId]))[0];
      if (!staff) return fail(res, 'Staff nahi mila', 404);
      const p = (await q(`SELECT *, TO_CHAR(paid_at, 'DD Mon YYYY') AS paid_on FROM payroll WHERE staff_id = ? AND month = ?`, [staffId, month]))[0];
      const c = await compute(staff, month);
      const shifts = await q(`${attSelect} WHERE a.staff_id = ? AND a.out_time IS NOT NULL AND TO_CHAR(${LOCAL('a.in_time')}, 'YYYY-MM') = ? ORDER BY a.in_time`, [staffId, month]);
      const adjustments = await q('SELECT kind, amount, note FROM staff_adjustments WHERE staff_id = ? AND month = ? ORDER BY id', [staffId, month]);
      const cfg = (await q('SELECT restaurant_name, address, phone FROM settings WHERE id = 1'))[0] || {};
      const line = p
        ? { ...c, hours: r2(p.hours), ot_hours: r2(p.ot_hours), rate: r2(p.rate), ot_multiplier: Number(p.ot_multiplier), gross: r2(p.gross), bonus: r2(p.bonus),
            deductions: r2(p.deductions), advance_deduct: r2(p.advance_deducted), net: r2(p.net_pay) }
        : { ...c, net: r2(c.net_before_advance - c.advance_deduct) };
      res.json({ restaurant: cfg, staff: { id: staff.id, name: staff.name, role: staff.role, phone: staff.phone }, month, paid: !!p,
        paid_on: p ? p.paid_on : null, payment_mode: p ? p.payment_mode : null, line, adjustments,
        shifts: shifts.map(s => ({ date: s.work_date, in: s.in_local, out: s.out_local, hours: r2(s.hours) })) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register };
