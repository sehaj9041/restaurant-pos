const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { exec } = require('child_process');
const XLSX = require('xlsx');
const menuImport = require('./menuImport');
const net = require('net');
const crypto = require('crypto');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Auto-migrate paid_amount column in orders table if not present
db.run("ALTER TABLE orders ADD COLUMN paid_amount REAL DEFAULT 0", (err) => {});

// Payment modes jinme koi amount receive nahi hota (paid_amount hamesha 0)
const UNPAID_PAYMENT_MODES = ['UNPAID', 'DUE', 'ONLINE_PENDING'];
// Payment modes jinme amount na bheja ho toh poora total paid maana jata hai
const FULL_PAYMENT_MODES = ['CASH', 'UPI', 'CARD', 'PAID'];

// Ngrok warning bypass & Customer ordering route
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

app.get('/pos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static directories setup for public and uploads
app.use(express.static(path.join(__dirname, 'public')));
app.get('/uploads/:name', (req, res, next) => {
  db.get("SELECT mime, data FROM uploaded_files WHERE name = ?", [req.params.name], (err, row) => {
    if (err || !row) return next(); // DB mein nahi hai toh purani committed files static se serve hongi
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(row.data);
  });
});
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Real-time Live Cart Storage for Customer Facing Display
let liveCustomerCart = {
  items: [],
  subtotal: 0,
  discount: 0,
  gst: 0,
  total: 0,
  orderType: 'Dine-In',
  tableNo: ''
};

// Images ko Postgres mein store karte hain (Render ka disk har deploy par wipe ho jata hai)
db.run("CREATE TABLE IF NOT EXISTS uploaded_files (name TEXT PRIMARY KEY, mime TEXT, data BYTEA)", (err) => {
  if (err) console.error('uploaded_files table error:', err.message);
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadExcel = multer({ dest: 'uploads/' });

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const name = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(req.file.originalname);
  db.run("INSERT INTO uploaded_files (name, mime, data) VALUES (?, ?, ?) RETURNING name", [name, req.file.mimetype, req.file.buffer], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ imageUrl: '/uploads/' + name });
  });
});

// ================= EXCEL MENU IMPORT API =================
app.post('/api/menu/import-excel', uploadExcel.single('menuFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const workbook = XLSX.readFile(req.file.path);
    const parsed = menuImport.parseWorkbook(workbook, XLSX);
    if (!parsed.items.length && !parsed.categories.length) {
      return res.status(400).json({ success: false, error: '"Categories" ya "Menu Items" sheet nahi mili ya khali hai' });
    }
    const replace = req.body && req.body.mode === 'replace';
    const summary = await menuImport.applyImport(db, parsed, { replace });
    console.log(`[MENU IMPORT SUCCESS] ${summary.items} items, ${summary.addonGroups} addon groups (${replace ? 'replace' : 'merge'}).`);
    res.json({
      success: true,
      message: `${summary.items} items, ${summary.categories} categories, ${summary.addonGroups} add-on groups import ho gaye`,
      summary,
      warnings: parsed.warnings
    });
  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
  }
});

// 1. CUSTOMER DISPLAY SYNC APIS
app.post('/api/display/sync', (req, res) => {
  liveCustomerCart = req.body;
  res.json({ success: true });
});

app.get('/api/display/current', (req, res) => {
  res.json(liveCustomerCart);
});

// 2. HARDWARE ZERO-PAPER CASH DRAWER PULSE
const triggerDrawerKick = (req, res) => {
  const psCommand = `powershell -NoProfile -Command "$bytes = [byte[]](0x1B,0x70,0x01,0x19,0xFA); $path = [System.IO.Path]::Combine($env:TEMP, 'kick.bin'); [System.IO.File]::WriteAllBytes($path, $bytes); Get-Content -Path $path -Encoding Byte -Raw | Out-Printer -Name 'Posiflex PP8803 Printerrr'; Remove-Item $path -ErrorAction SilentlyContinue"`;

  exec(psCommand, (error) => {
    if (error) {
      console.error('[DRAWER ERROR]:', error.message);
      return res.status(500).json({ success: false, message: 'Drawer trigger error', error: error.message });
    }
    console.log('[DRAWER SUCCESS]: Raw pulse sent to Posiflex PP8803 Printerrr');
    res.json({ success: true });
  });
};

app.post('/api/drawer/open', triggerDrawerKick);
app.post('/api/open-drawer', triggerDrawerKick);

// ================= CLOUD PRINT QUEUE FOR LOCAL POWERSHELL AGENT =================
let cloudPrintQueue = [];

app.post('/api/print-ip', (req, res) => {
  const { order_id, table, qty, item_name, addons, time } = req.body;
  
  const newJob = {
    id: Date.now(),
    order_id: order_id,
    table: table || 'Dine-In',
    qty: qty || 1,
    item_name: item_name || '',
    addons: addons || '',
    time: time || new Date().toLocaleTimeString()
  };

  cloudPrintQueue.push(newJob);
  console.log(`[PRINT QUEUE ADDED] Order #${order_id} - ${item_name} added for local agent.`);
  res.json({ success: true, message: 'Job added to queue' });
});

app.get('/api/print/pending-queue', (req, res) => {
  res.json({ success: true, jobs: cloudPrintQueue });
});

app.post('/api/print/acknowledge', (req, res) => {
  const { jobId } = req.body;
  cloudPrintQueue = cloudPrintQueue.filter(job => job.id !== jobId);
  res.json({ success: true });
});

// 3. INTERACTIVE FLOOR PLAN APIS
app.get('/api/floor-tables', (req, res) => {
  db.all("SELECT * FROM floor_tables ORDER BY id ASC", [], async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) {
      for (let i = 1; i <= 8; i++) {
        await new Promise((resolve) => {
          db.run(
            "INSERT INTO floor_tables (table_no, x, y, seats) VALUES (?, ?, ?, ?)",
            [`T-${i}`, ((i - 1) % 4) * 120 + 20, Math.floor((i - 1) / 4) * 100 + 20, 4],
            () => resolve()
          );
        });
      }
      db.all("SELECT * FROM floor_tables ORDER BY id ASC", [], (err2, rows2) => res.json(rows2 || []));
    } else {
      res.json(rows);
    }
  });
});

app.post('/api/floor-tables/save-positions', async (req, res) => {
  const { tables } = req.body;
  if (Array.isArray(tables)) {
    for (const t of tables) {
      await new Promise((resolve) => {
        db.run("UPDATE floor_tables SET x = ?, y = ? WHERE id = ?", [t.x, t.y, t.id], () => resolve());
      });
    }
  }
  res.json({ success: true });
});

app.post('/api/floor-tables', (req, res) => {
  const { table_no, seats, x, y } = req.body;
  db.all(
    "INSERT INTO floor_tables (table_no, seats, x, y) VALUES (?, ?, ?, ?) RETURNING id",
    [table_no, seats || 4, x || 20, y || 20],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const id = result && result[0] ? result[0].id : null;
      res.json({ success: true, id });
    }
  );
});

app.delete('/api/floor-tables/:id', (req, res) => {
  db.run("DELETE FROM floor_tables WHERE id = ?", [req.params.id], () => res.json({ success: true }));
});

// ================= CATEGORIES APIS =================
app.get('/api/categories', (req, res) => {
  db.all("SELECT * FROM categories ORDER BY COALESCE(sort_order, 0), id ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/categories', (req, res) => {
  const { name, image } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  db.run("INSERT INTO categories (name, image) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET image = COALESCE(NULLIF(excluded.image, ''), categories.image)", [name.trim(), image || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/categories/:id', (req, res) => {
  const b = req.body || {};
  const image = typeof b.image === 'string' ? b.image : null;
  const vis = b.is_visible === undefined ? null : (Number(b.is_visible) ? 1 : 0);
  const oos = b.out_of_stock === undefined ? null : (Number(b.out_of_stock) ? 1 : 0);
  db.run("UPDATE categories SET image = COALESCE(?, image), is_visible = COALESCE(?, is_visible), out_of_stock = COALESCE(?, out_of_stock) WHERE id = ?", [image, vis, oos, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/categories/:id', (req, res) => {
  db.run("DELETE FROM categories WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ================= GLOBAL ADD-ON GROUPS APIS (ROBUST & SAFE) =================
app.get('/api/addon-groups', (req, res) => {
  db.all("SELECT * FROM addon_groups ORDER BY COALESCE(sort_order, 0), id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/addon-groups', (req, res) => {
  const { name, min_selection, max_selection, is_mandatory, selection_type, items } = req.body;
  
  db.run(
    `INSERT INTO addon_groups (name, min_selection, max_selection, is_mandatory, items) VALUES (?, ?, ?, ?, ?)`,
    [
      name || 'New Group', 
      min_selection !== undefined ? min_selection : 0, 
      max_selection !== undefined ? max_selection : 5, 
      is_mandatory ? 1 : 0, 
      JSON.stringify(items || [])
    ],
    function (err) {
      if (err) {
        console.error('Addon group insert error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, id: this.lastID || 1 });
    }
  );
});

app.put('/api/addon-groups/:id', (req, res) => {
  const { name, min_selection, max_selection, is_mandatory, items } = req.body;
  db.run(
    `UPDATE addon_groups SET name = ?, min_selection = ?, max_selection = ?, is_mandatory = ?, items = ? WHERE id = ?`,
    [name || 'New Group', min_selection || 0, max_selection || 5, is_mandatory ? 1 : 0, JSON.stringify(items || []), req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/addon-groups/:id', (req, res) => {
  db.run("DELETE FROM addon_groups WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 5. VARIATION SETS MASTER APIS
app.get('/api/variation-masters', (req, res) => {
  db.all("SELECT * FROM variation_masters ORDER BY COALESCE(sort_order, 0), id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/variation-masters', (req, res) => {
  const { name, options } = req.body;
  db.all(
    "INSERT INTO variation_masters (name, options) VALUES (?, ?) RETURNING id",
    [name, JSON.stringify(options || [])],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const id = result && result[0] ? result[0].id : null;
      res.json({ success: true, id });
    }
  );
});

app.put('/api/variation-masters/:id', (req, res) => {
  const { name, options } = req.body;
  db.run(
    "UPDATE variation_masters SET name = ?, options = ? WHERE id = ?",
    [name, JSON.stringify(options || []), req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/variation-masters/:id', (req, res) => {
  db.run("DELETE FROM variation_masters WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/menu/assign-variations-category', (req, res) => {
  const { category, variations } = req.body;
  db.run(
    "UPDATE menu SET variations = ? WHERE category = ?",
    [JSON.stringify(variations || []), category],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// 6. MENU APIS
app.get('/api/menu', (req, res) => {
  db.all(`SELECT m.* FROM menu m LEFT JOIN categories c ON c.name = m.category
          ORDER BY COALESCE(c.sort_order, 9999), m.category, COALESCE(m.sort_order, 0), m.name`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // Inactive ("Off") variants are hidden from POS/kiosk/QR; admin asks for everything with ?admin=1.
    if (req.query.admin !== '1') {
      (rows || []).forEach(r => {
        try {
          const vars = JSON.parse(r.variations || '[]');
          if (vars.some(v => v.active === false)) r.variations = JSON.stringify(vars.filter(v => v.active !== false));
        } catch (e) {}
      });
    }
    res.json(rows || []);
  });
});

// food_type: 'veg' | 'nonveg' | 'egg' (anything else = not set, no icon shown)
function cleanFoodType(v) {
  const t = String(v || '').toLowerCase();
  return ['veg', 'nonveg', 'egg'].includes(t) ? t : null;
}

app.post('/api/menu', (req, res) => {
  const { name, category, price, stock, image, variations, assigned_addon_groups, is_exempt, is_visible, food_type } = req.body;
  db.all(
    `INSERT INTO menu (name, category, price, stock, image, variations, assigned_addon_groups, is_exempt, is_visible, food_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [name, category || 'General', price, stock || 50, image || '', JSON.stringify(variations || []), JSON.stringify(assigned_addon_groups || []), is_exempt ? 1 : 0, is_visible === undefined ? 1 : (is_visible ? 1 : 0), cleanFoodType(food_type)],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const id = result && result[0] ? result[0].id : null;
      res.json({ success: true, id });
    }
  );
});

app.put('/api/menu/:id', (req, res) => {
  const { name, category, price, stock, image, variations, assigned_addon_groups, is_exempt, is_visible,
          description, tags, allergens, is_featured, send_to_kds, status, food_type } = req.body;
  // Fields that are not sent stay as they are (the POS edit form only sends name/category/price/stock).
  const opt = v => (v === undefined ? null : v);
  const optJson = v => (v === undefined ? null : JSON.stringify(v || []));
  const optFlag = v => (v === undefined ? null : (v ? 1 : 0));
  db.run(
    `UPDATE menu SET name = COALESCE(?, name), category = COALESCE(?, category), price = COALESCE(?, price), stock = COALESCE(?, stock),
       image = COALESCE(?, image), variations = COALESCE(?, variations), assigned_addon_groups = COALESCE(?, assigned_addon_groups),
       is_exempt = COALESCE(?, is_exempt), is_visible = COALESCE(?, is_visible),
       description = COALESCE(?, description), tags = COALESCE(?, tags), allergens = COALESCE(?, allergens),
       is_featured = COALESCE(?, is_featured), send_to_kds = COALESCE(?, send_to_kds), status = COALESCE(?, status),
       food_type = CASE WHEN ? THEN ? ELSE food_type END,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [opt(name), opt(category), opt(price), opt(stock), opt(image), optJson(variations), optJson(assigned_addon_groups), optFlag(is_exempt), optFlag(is_visible),
     opt(description), optJson(tags), optJson(allergens), optFlag(is_featured), optFlag(send_to_kds), opt(status), food_type !== undefined, cleanFoodType(food_type), req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Sales stats for one menu item (matched by order_item name; variant names are stored as "Item (Variant)").
app.get('/api/menu/:id/performance', (req, res) => {
  db.all("SELECT name FROM menu WHERE id = ?", [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || !rows[0]) return res.status(404).json({ error: 'Item not found' });
    const name = rows[0].name;
    const stat = (since) => new Promise(resolve => {
      db.all(`SELECT COUNT(DISTINCT oi.order_id) AS orders, COALESCE(SUM(oi.qty), 0) AS qty, COALESCE(SUM(oi.qty * oi.price), 0) AS revenue
              FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE (oi.name = ? OR oi.name LIKE ?) AND o.created_at >= ${since} AND COALESCE(o.status, '') NOT IN ('CANCELLED', 'HOLD')`,
        [name, name + ' (%'], (e, r) => resolve(e || !r || !r[0] ? { orders: 0, qty: 0, revenue: 0 } : r[0]));
    });
    Promise.all([stat("date_trunc('week', CURRENT_TIMESTAMP)"), stat("date_trunc('month', CURRENT_TIMESTAMP)")])
      .then(([week, month]) => res.json({ week, month }));
  });
});

app.delete('/api/menu/:id', (req, res) => {
  db.run("DELETE FROM menu WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ================= REORDER (drag & drop / arrows) =================
// Body: { table, ids: [id, id, ...] } - sort_order becomes the position in ids (1-based).
const REORDERABLE = ['menu', 'categories', 'addon_groups', 'variation_masters', 'upsells'];
app.post('/api/reorder', async (req, res) => {
  const { table, ids } = req.body || {};
  if (!REORDERABLE.includes(table) || !Array.isArray(ids)) return res.status(400).json({ error: 'Invalid reorder request' });
  try {
    for (let i = 0; i < ids.length; i++) {
      await new Promise((resolve, reject) => db.run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [i + 1, Number(ids[i])], e => (e ? reject(e) : resolve())));
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================= UPSELLS =================
app.get('/api/upsells', (req, res) => {
  db.all("SELECT * FROM upsells ORDER BY sort_order, id", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/upsells', (req, res) => {
  const { item_name, upsell_type, suggested_item, suggested_category, label, sort_order, is_active } = req.body;
  const type = upsell_type === 'upgrade' ? 'upgrade' : 'cross_sell';
  if (!item_name) return res.status(400).json({ error: 'Item name zaroori hai' });
  if (!!suggested_item === !!suggested_category) return res.status(400).json({ error: 'Suggested item ya suggested category me se sirf ek do' });
  if (type === 'upgrade' && !suggested_item) return res.status(400).json({ error: 'Upgrade ke liye suggested item chahiye' });
  db.run(
    "INSERT INTO upsells (item_name, upsell_type, suggested_item, suggested_category, label, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [item_name, type, suggested_item || '', suggested_category || '', label || '', sort_order || 0, is_active === undefined ? 1 : (is_active ? 1 : 0)],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/upsells/:id', (req, res) => {
  const active = req.body.is_active === undefined ? null : (req.body.is_active ? 1 : 0);
  db.run("UPDATE upsells SET is_active = COALESCE(?, is_active) WHERE id = ?", [active, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/upsells/:id', (req, res) => {
  db.run("DELETE FROM upsells WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ================= INVENTORY & RECIPES (read-only, filled by Excel import) =================
const listTable = (path, sql) => app.get(path, (req, res) => {
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});
listTable('/api/inventory/ingredients', "SELECT * FROM ingredients ORDER BY name");
listTable('/api/inventory/units', "SELECT * FROM units ORDER BY name");
listTable('/api/inventory/suppliers', "SELECT * FROM suppliers ORDER BY name");

app.get('/api/inventory/recipes', (req, res) => {
  db.all("SELECT * FROM recipes ORDER BY item_name", [], (err, recipes) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all("SELECT * FROM recipe_ingredients ORDER BY item_name, line_order, id", [], (err2, lines) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const byItem = {};
      (lines || []).forEach(l => { (byItem[l.item_name] = byItem[l.item_name] || []).push(l); });
      res.json((recipes || []).map(r => Object.assign({}, r, { lines: byItem[r.item_name] || [] })));
    });
  });
});

// TODAY STATS API FOR POS DASHBOARD
app.get('/api/orders/today-stats', (req, res) => {
  const query = `
    SELECT 
      COUNT(*) AS total_orders,
      COALESCE(SUM(total), 0) AS total_sales,
      COALESCE(SUM(CASE WHEN UPPER(status) = 'COMPLETED' THEN 1 ELSE 0 END), 0) as completed_today,
      COALESCE(SUM(CASE WHEN UPPER(order_type) LIKE '%DELIVERY%' THEN 1 ELSE 0 END), 0) as delivery_count,
      COALESCE(SUM(CASE WHEN UPPER(status) LIKE '%VOID%' THEN 1 ELSE 0 END), 0) as void_count
    FROM orders 
    WHERE created_at::date = CURRENT_DATE OR DATE(created_at) = CURRENT_DATE
  `;

  db.get(query, [], (err, row) => {
    if (err) {
      console.error('Today stats error:', err.message);
      return res.json({ total_orders: 0, total_sales: 0, completed_today: 0, delivery_count: 0, void_count: 0 });
    }
    res.json(row || { total_orders: 0, total_sales: 0, completed_today: 0, delivery_count: 0, void_count: 0 });
  });
});

// ================= NEEDS APPROVAL (PENDING ORDERS) APIS =================
app.get('/api/orders/needs-approval', (req, res) => {
  const query = `
    SELECT id, token_no, order_type, table_no, customer_name, customer_phone, total, subtotal, discount, gst, payment_mode, status, COALESCE(paid_amount, 0) as paid_amount, created_at, delivery_address, delivery_lat, delivery_lng
    FROM orders 
    WHERE UPPER(status) = 'NEEDS_APPROVAL'
    ORDER BY id DESC
  `;

  db.all(query, [], async (err, orders) => {
    if (err) {
      console.error('Needs approval fetch error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    if (!orders || orders.length === 0) return res.json([]);

    try {
      const fullOrders = await Promise.all(
        orders.map(order => {
          return new Promise((resolve) => {
            db.all('SELECT id, name, qty, price, notes, user_note, pack_flip FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
              resolve({ ...order, items: items || [] });
            });
          });
        })
      );
      res.json(fullOrders);
    } catch (e) {
      res.json(orders.map(o => ({ ...o, items: [] })));
    }
  });
});

app.post('/api/orders/:id/approve', (req, res) => {
  const orderId = req.params.id;
  
  db.get("SELECT order_type, table_no FROM orders WHERE id = ?", [orderId], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });

    let type = (order.order_type || '').toLowerCase();
    let newTableNo = order.table_no || '';
    let newStatus = 'RUNNING_TABLE';

    if (type.includes('delivery')) {
      newTableNo = 'Delivery';
    } else if (type.includes('takeaway') || type.includes('pickup')) {
      newTableNo = 'Takeaway';
    } else {
      // Dine-in ke liye agar table pehle se nahi hai, toh khali chhod do taaki POS active queue / 'Needs Table' mein dikhe
      if (!newTableNo || newTableNo.toUpperCase() === 'KIOSK') {
        newTableNo = ''; 
      }
    }

    db.run(
      `UPDATE orders 
       SET status = ?, 
           table_no = ?,
           accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP)
       WHERE id = ?`, 
      [newStatus, newTableNo, orderId], 
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        console.log(`[ORDER APPROVED] Order #${orderId} accepted with table/queue '${newTableNo}'.`);
        res.json({ success: true });
      }
    );
  });
});
app.post('/api/orders/:id/reject', (req, res) => {
  const orderId = req.params.id;
  db.run("UPDATE orders SET status = 'VOID' WHERE id = ?", [orderId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    console.log(`[ORDER REJECTED] Order #${orderId} rejected.`);
    res.json({ success: true });
  });
});

// Table Assign API Route
app.post('/api/orders/:id/assign-table', (req, res) => {
  const orderId = req.params.id;
  const { table_no } = req.body;

  db.run(
    "UPDATE orders SET table_no = ?, status = 'RUNNING_TABLE' WHERE id = ?",
    [table_no || '', orderId],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      console.log(`[TABLE ASSIGNED] Order #${orderId} assigned to Table ${table_no} and moved to active queue.`);
      res.json({ success: true });
    }
  );
});

// 7. ACTIVE ORDERS
app.get('/api/orders/active', (req, res) => {
  const query = `
    SELECT id, token_no, order_type, table_no, customer_name, customer_phone, total, subtotal, discount, gst, payment_mode, status, COALESCE(paid_amount, 0) as paid_amount,
           GREATEST(0, total - COALESCE(paid_amount, 0)) as remaining_balance,
           -- Order timers: kitchen time = accepted (or placed) -> KDS done; still running while the kitchen works on it
           GREATEST(0, EXTRACT(EPOCH FROM ((CASE WHEN ready_at IS NOT NULL AND UPPER(status) = 'KOT_DONE' THEN ready_at ELSE NOW() END) - COALESCE(accepted_at, created_at)))) AS kitchen_sec,
           (ready_at IS NOT NULL AND UPPER(status) = 'KOT_DONE') AS kitchen_done
    FROM orders 
    WHERE (UPPER(status) = 'RUNNING_TABLE' OR UPPER(status) = 'KOT_DONE')
      AND status != 'COMPLETED'
      AND status != 'DISPATCHED'
      AND status != 'VOID'
    ORDER BY id DESC
  `;

  db.all(query, [], async (err, orders) => {
    if (err) {
      console.error('Active orders error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    
    if (!orders || orders.length === 0) {
      return res.json([]);
    }

    try {
      const fullOrders = await Promise.all(
        orders.map(order => {
          return new Promise((resolve) => {
            db.all('SELECT id, name, qty, price, notes, user_note, pack_flip FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
              let paid = Number(order.paid_amount) || 0;
              let tot = Number(order.total) || 0;
              let mode = (order.payment_mode || '').toUpperCase();
              
              let isPaid = (paid >= tot && tot > 0) || (mode === 'CASH' || mode === 'UPI' || mode === 'CARD' || mode === 'PAID');

              // FIX: 
              // 1. Agar paid hai, toh bahar tile ke liye effectiveTotal ko 0 rakho.
              // 2. Lekin agar koi frontend ya cart screen pure order object ko padhti hai, 
              //    toh hum asli totals (subtotal, gst, total) aur items ke prices bhej rahe hain taaki andar item list aur Grand Total zero na ho!
              let tileDisplayTotal = isPaid ? 0 : Number(order.remaining_balance);

              resolve({ 
                ...order, 
                subtotal: Number(order.subtotal),
                gst: Number(order.gst),
                total: tileDisplayTotal, // Bahar tile ke liye zero, par andar ke liye original total bhej sakte hain agar frontend `grand_total` ya alag field use kare
                actual_total: Number(order.total),
                items: items || [] 
              });
            });
          });
        })
      );
      res.json(fullOrders);
    } catch (e) {
      console.error('Items fetch error:', e.message);
      res.json(orders.map(o => {
        let paid = Number(o.paid_amount) || 0;
        let tot = Number(o.total) || 0;
        let mode = (o.payment_mode || '').toUpperCase();
        let isPaid = (paid >= tot && tot > 0) || (mode === 'CASH' || mode === 'UPI' || mode === 'CARD' || mode === 'PAID');

        return { 
          ...o, 
          subtotal: o.subtotal,
          gst: o.gst,
          total: isPaid ? 0 : o.remaining_balance, 
          actual_total: o.total,
          items: [] 
        };
      }));
    }
  });
});
// ================= DEDICATED DUE (KHATA) APIS =================

app.get('/api/due/orders', (req, res) => {
  // STRICT FIX: Due mein sirf wahi orders aayenge jinka payment_mode 'DUE' hai ya status 'DUE_PENDING' hai. 
  // RUNNING_TABLE ya naye UNPAID orders yahan kabhi nahi aayenge!
  const query = `
    SELECT 
      id, order_type, table_no, customer_name, customer_phone, 
      total, COALESCE(paid_amount, 0) as paid_amount,
      GREATEST(0, total - COALESCE(paid_amount, 0)) as due_amount,
      payment_mode, status, created_at
    FROM orders
    WHERE status != 'COMPLETED'
      AND status != 'DISPATCHED'
      AND status != 'VOID'
      AND (
        UPPER(payment_mode) = 'DUE' 
        OR status = 'DUE_PENDING'
        OR (UPPER(payment_mode) LIKE '%PARTIAL%' AND (total - COALESCE(paid_amount, 0)) > 0)
      )
    ORDER BY id DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Due orders fetch error:', err.message);
      return res.json([]);
    }
    const now = new Date();
    const formatted = (rows || []).map(r => {
      const orderDate = r.created_at ? new Date(r.created_at) : now;
      const diffMs = Math.max(0, now - orderDate);
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffHours / 24);
      const remainingDue = Math.max(0, Number(r.total) - Number(r.paid_amount || 0));

      return {
        ...r,
        due_days: diffDays,
        due_hours: diffHours,
        due_amount: remainingDue > 0 ? remainingDue : Number(r.total)
      };
    });
    res.json(formatted);
  });
});

app.get('/api/due/customers', (req, res) => {
  const query = `
    SELECT 
      COALESCE(NULLIF(customer_phone, ''), 'WALK-IN') as phone,
      COALESCE(NULLIF(MAX(customer_name), ''), 'Valued Guest') as name,
      SUM(GREATEST(0, total - COALESCE(paid_amount, 0))) as total_due,
      COUNT(id) as total_orders,
      STRING_AGG(id::text, ',') as order_ids,
      MIN(created_at) as oldest_order_date
    FROM orders
    WHERE status != 'COMPLETED'
      AND status != 'DISPATCHED'
      AND status != 'VOID'
      AND (
        UPPER(payment_mode) = 'DUE' 
        OR status = 'DUE_PENDING'
        OR (UPPER(payment_mode) LIKE '%PARTIAL%' AND (total - COALESCE(paid_amount, 0)) > 0)
      )
    GROUP BY COALESCE(NULLIF(customer_phone, ''), 'WALK-IN')
    HAVING SUM(GREATEST(0, total - COALESCE(paid_amount, 0))) > 0
    ORDER BY total_due DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err, rows) {
      // safe fallback if err
    }
    if (err) {
      console.error('Due customers fetch error:', err.message);
      return res.json([]);
    }
    const now = new Date();
    const formatted = (rows || []).map(r => {
      const oldestDate = r.oldest_order_date ? new Date(r.oldest_order_date) : now;
      const diffDays = Math.floor(Math.max(0, now - oldestDate) / (1000 * 60 * 60 * 24));

      return {
        phone: r.phone,
        name: r.name,
        total_orders: Number(r.total_orders) || 1,
        total_due: Number(r.total_due) || 0,
        oldest_days: diffDays,
        order_ids: r.order_ids ? r.order_ids.split(',').map(s => s.trim()) : []
      };
    });
    res.json(formatted);
  });
});

app.post('/api/due/settle-customer', (req, res) => {
  const { phone, payment_mode } = req.body;
  if (!phone) return res.status(400).json({ error: 'Customer phone required' });

  const mode = (payment_mode || 'CASH').toUpperCase();

  db.run(
    `UPDATE orders 
     SET status = 'COMPLETED', payment_mode = ?, paid_amount = total 
     WHERE customer_phone = ? 
       AND status != 'COMPLETED'`,
    [mode, phone],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      console.log(`[FULL SETTLEMENT SUCCESS] Customer ${phone} bills cleared via ${mode}`);
      res.json({ success: true, message: `All bills cleared successfully via ${mode}` });
    }
  );
});

app.get('/api/orders/history', (req, res) => {
  const { date } = req.query;
  const filterDate = date ? date : new Date().toISOString().slice(0, 10);

  const query = `
    SELECT id, token_no, order_type, table_no, customer_name, customer_phone, payment_mode, status, subtotal, discount, gst, total, COALESCE(paid_amount, total) as paid_amount, created_at
    FROM orders 
    WHERE status = 'COMPLETED' 
       OR status = 'VOID'
       OR UPPER(payment_mode) IN ('CASH', 'UPI', 'CARD', 'PAID')
       OR COALESCE(paid_amount, 0) >= total
    ORDER BY id DESC
    LIMIT 200
  `;

  db.all(query, [], async (err, orders) => {
    if (err) {
      console.error('Order history query error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    if (!orders || orders.length === 0) return res.json([]);

    try {
      const fullOrders = await Promise.all(
        orders.map(order => {
          return new Promise((resolve) => {
            db.all('SELECT name, qty, price FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
              resolve({ ...order, items: items || [] });
            });
          });
        })
      );
      res.json(fullOrders);
    } catch (e) {
      res.json(orders.map(o => ({ ...o, items: [] })));
    }
  });
});

app.put('/api/orders/:id', (req, res) => {
  const orderId = req.params.id;
  const { order_type, table_no, customer_name, customer_phone, items, subtotal, discount, gst, total, payment_mode, paid_amount } = req.body;

  db.get("SELECT total, paid_amount, payment_mode, status FROM orders WHERE id = ?", [orderId], (errGet, currentOrder) => {
   db.all("SELECT name, qty FROM order_items WHERE order_id = ?", [orderId], (errItems, existingItems) => {
    let incomingPaid = Number(paid_amount) || 0;
    let finalTotal = Number(total) || (currentOrder ? Number(currentOrder.total) : 0);
    
    const requestedMode = String(payment_mode || '').trim().toUpperCase();
    const hasPaymentSelected = requestedMode !== '' && requestedMode !== 'PAY_COUNTER' && !UNPAID_PAYMENT_MODES.includes(requestedMode);

    let finalPaid = 0;
    if (hasPaymentSelected) {
      finalPaid = incomingPaid > 0 ? incomingPaid : (FULL_PAYMENT_MODES.includes(requestedMode) ? finalTotal : 0);
    }
    let finalRemaining = Math.max(0, finalTotal - finalPaid);
    let finalMode = payment_mode || (currentOrder ? currentOrder.payment_mode : 'UNPAID');

    // Naye items ya badhi hui qty kitchen ko phir se bhejni hai
    const existingQty = {};
    (existingItems || []).forEach(i => { existingQty[i.name] = (existingQty[i.name] || 0) + (Number(i.qty) || 0); });
    const incomingQty = {};
    (Array.isArray(items) ? items : []).forEach(i => { incomingQty[i.name] = (incomingQty[i.name] || 0) + (Number(i.qty) || 0); });
    const hasNewItems = Object.keys(incomingQty).some(name => incomingQty[name] > (existingQty[name] || 0));

    // Payment se kitchen status nahi badalta: jab tak KDS se KOT done na ho, order RUNNING_TABLE (active + KDS par) rahega.
    // Kitchen done ho chuka ho (aur naye items na hon) tabhi final status do.
    const prevStatus = String(currentOrder ? currentOrder.status : '').toUpperCase();
    const kitchenDone = ['KOT_DONE', 'DISPATCHED', 'DUE_PENDING'].includes(prevStatus) && !hasNewItems;

    let status = 'RUNNING_TABLE';
    if (kitchenDone) {
      if (requestedMode === 'DUE') {
        status = 'DUE_PENDING';
      } else if (finalPaid >= finalTotal && finalTotal > 0) {
        status = 'DISPATCHED';
      } else {
        status = 'KOT_DONE'; // Kitchen done par payment baaki: active list me rahega, KDS par nahi
      }
    }

    db.run(
      `UPDATE orders SET order_type = ?, table_no = ?, customer_name = ?, customer_phone = ?, subtotal = ?, discount = ?, gst = ?, total = ?, payment_mode = ?, status = ?, paid_amount = ? WHERE id = ?`,
      [order_type, table_no || '', customer_name || '', customer_phone || '', subtotal, discount || 0, gst || 0, finalTotal, finalMode, status, finalPaid, orderId],
      async (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.run("DELETE FROM order_items WHERE order_id = ?", [orderId], async () => {
          if (Array.isArray(items) && items.length > 0) {
            for (const item of items) {
              await new Promise((resolve) => {
                db.run(
                  "INSERT INTO order_items (order_id, name, qty, price, notes, user_note, pack_flip) VALUES (?, ?, ?, ?, ?, ?, ?)",
                  [orderId, item.name, item.qty, item.price, item.notes || '', String(item.user_note || '').slice(0, 300), item.pack_flip ? 1 : 0],
                  () => resolve()
                );
              });
            }
          }
          db.all('SELECT token_no FROM orders WHERE id = ?', [orderId], (eT, rT) => {
            res.json({ success: true, orderId, token_no: (rT && rT[0]) ? rT[0].token_no : null, paid_amount: finalPaid, payable_now: finalRemaining, status });
          });
        });
      }
    );
   });
  });
});
// ---------- Server-side price validation (online orders) ----------
// The customer page is public, so prices/totals coming from it cannot be trusted. Every line is rebuilt
// from the menu table: base/variant price + add-on prices, all read from the DB.
const dbAllAsync = (sql, params) => new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r || []))));
const parseJsonSafe = (v, d) => { try { const x = JSON.parse(v || ''); return x == null ? d : x; } catch (e) { return d; } };

async function validateOnlineItems(items) {
  if (!Array.isArray(items) || !items.length) return { error: 'Cart khali hai' };
  if (items.length > 60) return { error: 'Too many items' };
  const groups = await dbAllAsync('SELECT * FROM addon_groups', []);
  const out = [];
  const qtyById = {};
  let subtotal = 0;
  for (const line of items) {
    const qty = Number(line && line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) return { error: 'Invalid quantity' };
    const rows = await dbAllAsync('SELECT * FROM menu WHERE id = ?', [Number(line.id)]);
    const m = rows[0];
    if (!m) return { error: 'Item available nahi hai: ' + (line.name || '') };
    const catRow = (await dbAllAsync('SELECT is_visible, out_of_stock FROM categories WHERE name = ?', [m.category]))[0];
    // Hidden item/category menu se gayab hai, par agar wo kisi active upsell ka suggestion hai toh order ho sakta hai
    if (Number(m.is_visible) === 0 || (catRow && Number(catRow.is_visible) === 0)) {
      const ups = await dbAllAsync('SELECT 1 FROM upsells WHERE COALESCE(is_active, 1) = 1 AND (suggested_item = ? OR suggested_category = ?) LIMIT 1', [m.name, m.category]);
      if (!ups.length) return { error: 'Item available nahi hai: ' + m.name };
    }
    if (catRow && Number(catRow.out_of_stock)) return { error: 'Item available nahi hai: ' + m.name };
    if (m.status === 'Out of Stock' || m.status === 'unavailable') return { error: m.name + ' sold out hai' };
    qtyById[m.id] = (qtyById[m.id] || 0) + qty;
    if ((Number(m.stock) || 0) < qtyById[m.id]) return { error: m.name + ' ka itna stock available nahi hai' };

    let name = m.name;
    let price = Number(m.price) || 0;
    let groupIds = parseJsonSafe(m.assigned_addon_groups, []);
    const variations = parseJsonSafe(m.variations, []).filter(v => v && v.active !== false);
    if (variations.length) {
      const v = variations.find(x => x.name === line.variant);
      if (!v) return { error: m.name + ': size select karein' };
      name += ` (${v.name})`;
      price = Number(v.price) || 0;
      if (Array.isArray(v.addon_groups) && v.addon_groups.length) groupIds = v.addon_groups;
    }

    const allowed = {};
    (Array.isArray(groupIds) ? groupIds : []).map(Number).forEach(gid => {
      const g = groups.find(x => Number(x.id) === gid);
      if (g) parseJsonSafe(g.items, []).forEach(a => { if (a && a.available !== false && allowed[a.name] === undefined) allowed[a.name] = Number(a.price) || 0; });
    });
    const addons = [];
    for (const a of (Array.isArray(line.addons) ? line.addons : [])) {
      if (!a || allowed[a.name] === undefined) return { error: m.name + ': add-on "' + (a && a.name) + '" valid nahi hai' };
      addons.push({ name: a.name, price: allowed[a.name] });
      price += allowed[a.name];
    }
    if (addons.length) name += ` (${addons.map(a => a.name).join(', ')})`;

    subtotal += price * qty;
    out.push({ id: m.id, name, price, qty, addons, notes: String(line.notes || '').slice(0, 300) });
  }
  return { items: out, subtotal };
}

// ---------- Customer profile + order tracking ----------
// Profile = phone + secret token (created on the customer's first online order, kept in their browser).
function shapeTrackOrder(o, items) {
  const st = String(o.status || '').toUpperCase();
  let step = 0, state = 'active';
  if (st === 'NEEDS_APPROVAL') step = 0;
  else if (st === 'RUNNING_TABLE') step = 1;
  else if (st === 'KOT_DONE') step = 2;
  else if (['DISPATCHED', 'COMPLETED', 'DUE_PENDING'].includes(st)) { step = 3; state = 'done'; }
  else if (['VOID', 'CANCELLED'].includes(st)) { state = 'rejected'; }
  return {
    id: o.id, order_type: o.order_type, state, step,
    subtotal: o.subtotal, gst: o.gst, total: o.total, created_at: o.created_at,
    delivery_address: o.delivery_address || '', items: items || []
  };
}
const ORDER_TRACK_COLS = 'id, order_type, table_no, status, subtotal, gst, total, created_at, delivery_address, customer_phone';

// One order: needs order id + the phone number used while ordering.
app.get('/api/track/:id', (req, res) => {
  const id = Number(req.params.id);
  const phone = String(req.query.phone || '');
  if (!Number.isInteger(id) || !/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Invalid request' });
  db.all(`SELECT ${ORDER_TRACK_COLS} FROM orders WHERE id = ?`, [id], (err, rows) => {
    const o = rows && rows[0];
    if (err || !o || o.customer_phone !== phone) return res.status(404).json({ error: 'Order nahi mila' });
    db.all('SELECT name, qty, price FROM order_items WHERE order_id = ? ORDER BY id', [id], (e2, items) => res.json(shapeTrackOrder(o, items)));
  });
});

// POS bill: delivery address of an order (address + landmark as typed by the customer).
app.get('/api/orders/:id/delivery-address', (req, res) => {
  db.all('SELECT delivery_address FROM orders WHERE id = ?', [Number(req.params.id)], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ delivery_address: (rows && rows[0] && rows[0].delivery_address) || '' });
  });
});

// Recent orders of a profile: needs phone + profile token.
app.get('/api/my-orders', (req, res) => {
  const phone = String(req.query.phone || '');
  const token = String(req.query.token || '');
  if (!/^\d{10}$/.test(phone) || !token) return res.status(400).json({ error: 'Invalid request' });
  db.all('SELECT token FROM customer_profiles WHERE phone = ?', [phone], (err, prof) => {
    if (err || !prof || !prof[0] || prof[0].token !== token) return res.status(401).json({ error: 'Profile verify nahi hui' });
    db.all(`SELECT ${ORDER_TRACK_COLS} FROM orders WHERE customer_phone = ? AND COALESCE(status, '') <> 'HOLD' ORDER BY id DESC LIMIT 30`, [phone], async (e2, orders) => {
      if (e2) return res.status(500).json({ error: 'Orders load nahi hue' });
      try {
        const out = [];
        for (const o of (orders || [])) {
          const items = await dbAllAsync('SELECT name, qty, price FROM order_items WHERE order_id = ? ORDER BY id', [o.id]);
          out.push(shapeTrackOrder(o, items));
        }
        res.json(out);
      } catch (e3) { res.status(500).json({ error: 'Orders load nahi hue' }); }
    });
  });
});

// ---------- Operating hours (Settings > Operating Hours) ----------
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function istNow() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return { day: DAY_KEYS.indexOf(get('weekday').toLowerCase().slice(0, 3)), min: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}
const toMin = hhmm => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fmt12 = hhmm => { const m = toMin(hhmm); const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0'); return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`; };
function storeStatus(cfg) {
  const hours = cfg && cfg.hours;
  if (!hours) return { open: true, configured: false };               // never saved -> do not block anyone
  const now = istNow();
  const ent = d => hours[DAY_KEYS[(d + 7) % 7]] || {};
  const t = ent(now.day), prev = ent(now.day - 1);
  const f = toMin(t.from), e = toMin(t.to), pf = toMin(prev.from), pe = toMin(prev.to);
  let open = false;
  if (t.open && f != null && e != null) open = e > f ? (now.min >= f && now.min < e) : now.min >= f;            // overnight: open till midnight...
  if (!open && prev.open && pf != null && pe != null && pe <= pf) open = now.min < pe;                          // ...and until "to" next morning
  if (open) return { open: true, configured: true };
  for (let i = 0; i < 8; i++) {
    const d = ent(now.day + i), df = toMin(d.from);
    if (d.open && df != null && (i > 0 || now.min < df)) {
      const label = i === 0 ? 'aaj' : i === 1 ? 'kal' : ['Ravi', 'Som', 'Mangal', 'Budh', 'Guru', 'Shukra', 'Shani'][(now.day + i) % 7];
      return { open: false, configured: true, message: `Abhi restaurant band hai. ${label} ${fmt12(d.from)} se order kar sakte hain.` };
    }
  }
  return { open: false, configured: true, message: 'Abhi restaurant band hai.' };
}
app.get('/api/store-status', async (req, res) => res.json(storeStatus(await getSettingsConfig())));

// ---------- Delivery charges (Settings > Delivery Charges) ----------
function distKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function deliveryChargeFor(cfg, subtotal, km) {
  const d = (cfg && cfg.delivery_charges) || {}, model = d.model || 'free';
  const n = v => Math.max(0, Number(v) || 0);
  if (model === 'flat') return { charge: n(d.flat_fee) };
  if (model === 'free_above_min') return { charge: subtotal >= n(d.free_min) ? 0 : n(d.fee_below_min) };
  if (model === 'zone') {
    const zones = (d.zones || []).map(z => ({ up: Number(z.up_to_km), fee: n(z.fee) })).filter(z => z.up > 0).sort((a, b) => a.up - b.up);
    if (!zones.length) return { charge: 0 };
    if (km == null) return { charge: null, needLocation: true };
    const z = zones.find(x => km <= x.up);
    return z ? { charge: z.fee } : { charge: null, outside: true, maxKm: zones[zones.length - 1].up };
  }
  if (model === 'tier') {
    const tiers = (d.tiers || []).map(t => ({ min: n(t.min_amount), fee: n(t.fee) })).sort((a, b) => a.min - b.min);
    if (!tiers.length) return { charge: 0 };
    let fee = tiers[0].fee;
    tiers.forEach(t => { if (subtotal >= t.min) fee = t.fee; });
    return { charge: fee };
  }
  return { charge: 0 };
}
// Quote for the customer page (before placing the order). The order endpoint recomputes everything itself.
app.post('/api/delivery-charge', async (req, res) => {
  const cfg = await getSettingsConfig();
  const sub = Math.max(0, Number(req.body.subtotal) || 0);
  const rl = cfg.location;
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  const km = rl && rl.lat != null && req.body.lat != null && req.body.lat !== '' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? distKm(rl, { lat, lng }) : null;
  const r = deliveryChargeFor(cfg, sub, km);
  const out = { charge: r.charge, km: km == null ? null : Math.round(km * 10) / 10 };
  if (r.needLocation) out.message = 'Location allow karne par delivery charge dikhega';
  if (r.outside) out.message = `Aap hamare delivery area (${r.maxKm} km) se bahar hain`;
  res.json(out);
});

const createOrderHandler = async (req, res) => {
  console.log('[DEBUG ORDER PAYLOAD]:', req.body);
  let { order_type, table_no, customer_name, customer_phone, items, payment_mode, subtotal, discount, is_hold, paid_amount, is_kiosk } = req.body;
  let deliveryAddress = null, deliveryLat = null, deliveryLng = null;

  // Public online orders: never trust client prices/discount/payment, rebuild everything from the DB.
  const isOnlineOrder = /ONLINE/i.test(String(order_type || ''));
  if (isOnlineOrder) {
    if (!/^[6-9]\d{9}$/.test(String(customer_phone || ''))) return res.status(400).json({ error: 'Valid 10-digit mobile number daalein' });
    const open = storeStatus(await getSettingsConfig());
    if (!open.open) return res.status(400).json({ error: open.message });
    try {
      const v = await validateOnlineItems(items);
      if (v.error) return res.status(400).json({ error: v.error });
      items = v.items;
      subtotal = v.subtotal;
      // Settings > Storefront > Ordering rules > Minimum order value
      const minOrder = Number(((await getSettingsConfig()).ordering_rules || {}).min_order_value) || 0;
      if (minOrder > 0 && subtotal < minOrder) return res.status(400).json({ error: `Minimum order ₹${minOrder} hai (aapka cart ₹${subtotal})` });
    } catch (e) {
      console.error('Online order validation error:', e.message);
      return res.status(500).json({ error: 'Order validate nahi ho paaya' });
    }
    discount = 0;
    paid_amount = 0;
    payment_mode = 'ONLINE_PENDING';
    is_hold = false;

    if (!/DELIVERY|TAKEAWAY|PICKUP/i.test(String(order_type))) return res.status(400).json({ error: 'Online ordering sirf Delivery ya Takeaway ke liye hai' });
    if (/DELIVERY/i.test(String(order_type))) {
      deliveryAddress = String(req.body.delivery_address || '').trim().slice(0, 500);
      if (deliveryAddress.length < 8) return res.status(400).json({ error: 'Poora delivery address likhein' });
      const lat = Number(req.body.delivery_lat), lng = Number(req.body.delivery_lng);
      if (req.body.delivery_lat != null && req.body.delivery_lat !== '' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) { deliveryLat = lat; deliveryLng = lng; }

      // Settings > General > Max Delivery Distance, and Settings > Delivery Charges
      const cfg = await getSettingsConfig();
      const maxKm = Number(cfg.max_delivery_km) || 0;
      const rl = cfg.location;
      const hasRest = rl && rl.lat != null && rl.lng != null;
      const km = hasRest && deliveryLat != null ? distKm(rl, { lat: deliveryLat, lng: deliveryLng }) : null;
      if (maxKm > 0 && hasRest) {
        if (km == null) return res.status(400).json({ error: 'Delivery ke liye apni location allow karna zaroori hai' });
        if (km > maxKm) return res.status(400).json({ error: `Aap hamare delivery area se bahar hain (${km.toFixed(1)} km door, max ${maxKm} km)` });
      }
      const dc = deliveryChargeFor(cfg, subtotal, km);
      if (dc.needLocation) return res.status(400).json({ error: 'Delivery charge ke liye apni location allow karna zaroori hai' });
      if (dc.outside) return res.status(400).json({ error: `Aap hamare delivery area (${dc.maxKm} km) se bahar hain` });
      if (dc.charge > 0) {
        items = items.concat([{ name: 'Delivery Charge', price: dc.charge, qty: 1, addons: [], notes: '' }]);
        subtotal += dc.charge;
      }
    }
  }

  let rawType = (order_type || 'Kiosk').trim();
  let upperType = rawType.toUpperCase();
  let normalizedOrderType = rawType;
  let finalTableNo = table_no || '';

  if (upperType.includes('DELIVERY')) {
    normalizedOrderType = 'Delivery';
    finalTableNo = 'Delivery';
  } else if (upperType.includes('TAKEAWAY') || upperType.includes('PICKUP')) {
    normalizedOrderType = 'Takeaway';
    finalTableNo = 'Takeaway';
  } else if (upperType.includes('DINE') || upperType.includes('EAT') || upperType.includes('KIOSK')) {
    normalizedOrderType = 'Dine-In';
    if (!table_no || table_no.trim() === '' || table_no.toUpperCase() === 'KIOSK') {
      finalTableNo = ''; 
    }
  }

  let calculatedSubtotal = Number(subtotal) || 0;
  if (calculatedSubtotal === 0 && Array.isArray(items)) {
    calculatedSubtotal = items.reduce((sum, i) => sum + (Number(i.price) * Number(i.qty)), 0);
  }

  let calculatedGst = Math.round((calculatedSubtotal * 5) / 100);
  let calculatedTotal = Math.round(calculatedSubtotal + calculatedGst - (Number(discount) || 0));

  // SAFE & FOOLPROOF PAYMENT LOGIC:
  let finalPaymentMode = 'UNPAID';
  let initialPaid = Number(paid_amount) || 0;

  const requestedMode = String(payment_mode || '').trim().toUpperCase();

  if (requestedMode && requestedMode !== 'PAY_COUNTER') {
    finalPaymentMode = requestedMode;
    if (UNPAID_PAYMENT_MODES.includes(requestedMode)) {
      // UNPAID / DUE / ONLINE_PENDING: koi payment receive nahi hui
      initialPaid = 0;
    } else if (initialPaid <= 0 && FULL_PAYMENT_MODES.includes(requestedMode)) {
      // Cash/UPI/Card select hai lekin paid_amount nahi bheja, toh poora total paid man lo
      initialPaid = calculatedTotal;
    }
  } else if (initialPaid > 0) {
    // Agar paid_amount bhej diya hai par payment_mode nahi bheja, toh default CASH maan lo
    finalPaymentMode = 'CASH';
  }

  let status = 'RUNNING_TABLE';
  const isKioskOrOnline = is_kiosk || upperType.includes('KIOSK') || upperType.includes('ONLINE') || upperType.includes('SWIGGY') || upperType.includes('ZOMATO');
  
  if (isOnlineOrder && req.body.pay_online) {
    status = 'HOLD'; // hidden until Razorpay payment is verified (see razorpayPay.js)
  } else if (isKioskOrOnline && !is_hold) {
    status = 'NEEDS_APPROVAL';
  } else {
    status = 'RUNNING_TABLE';
  }

  const insertOrderQuery = `
    INSERT INTO orders (order_type, table_no, customer_name, customer_phone, status, payment_mode, subtotal, discount, gst, total, paid_amount, delivery_address, delivery_lat, delivery_lng, token_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(token_no) FROM orders WHERE created_at::date = CURRENT_DATE), 0) + 1)
    RETURNING id, token_no
  `;

  const orderValues = [
    normalizedOrderType,
    finalTableNo,
    customer_name || '',
    customer_phone || '',
    status,
    finalPaymentMode,
    calculatedSubtotal,
    discount || 0,
    calculatedGst,
    calculatedTotal,
    initialPaid,
    deliveryAddress,
    deliveryLat,
    deliveryLng
  ];

  db.all(insertOrderQuery, orderValues, async (err, result) => {
    if (err) {
      console.error('Order creation error:', err.message);
      return res.status(500).json({ error: err.message });
    }

    const orderId = (result && result[0]) ? result[0].id : null;
    const tokenNo = (result && result[0]) ? result[0].token_no : null;
    if (!orderId) {
      return res.status(500).json({ error: 'Failed to retrieve order id' });
    }

    try {
      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          await new Promise((resolve) => {
            db.run(
              'INSERT INTO order_items (order_id, name, qty, price, notes, user_note, pack_flip) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [orderId, item.name, item.qty, item.price, item.notes || '', String(item.user_note || '').slice(0, 300), item.pack_flip ? 1 : 0],
              () => resolve()
            );
          });

          if (item.id || item.menu_id) {
            await new Promise((resolve) => {
              db.run(
                'UPDATE menu SET stock = GREATEST(0, stock - ?) WHERE id = ?',
                [item.qty, item.id || item.menu_id],
                () => resolve()
              );
            });
          }
        }
      }

      console.log(`[ORDER CREATED] Order #${orderId} placed with status ${status}, mode ${finalPaymentMode}, and paid amount ${initialPaid}.`);
      // First online order of this phone creates the customer profile; the token is only handed out once.
      let profileToken = null;
      if (isOnlineOrder) {
        try {
          const existing = await dbAllAsync('SELECT phone FROM customer_profiles WHERE phone = ?', [customer_phone]);
          if (!existing.length) {
            profileToken = crypto.randomBytes(16).toString('hex');
            await dbAllAsync('INSERT INTO customer_profiles (phone, name, token) VALUES (?, ?, ?) RETURNING phone', [customer_phone, customer_name || '', profileToken]);
          }
        } catch (pe) { console.error('Profile create error:', pe.message); profileToken = null; }
      }
      res.json({ success: true, orderId: orderId, token_no: tokenNo, paid_amount: initialPaid, profile_token: profileToken });
    } catch (itemErr) {
      console.error('Order items insert error:', itemErr.message);
      res.json({ success: true, orderId: orderId, token_no: tokenNo });
    }
  });
};
app.post('/api/orders', createOrderHandler);
// ================= FULL TABLE SETTLEMENT ROUTE (FOOLPROOF FIX) =================
// ================= FULL TABLE SETTLEMENT ROUTE (FOOLPROOF FIX) =================
app.post('/api/tables/:id/settle', (req, res) => {
  const { payment_mode } = req.body;
  const targetId = req.params.id;
  const mode = (payment_mode || 'Cash').toUpperCase();

  db.get("SELECT table_no FROM floor_tables WHERE id = ? OR table_no = ?", [targetId, targetId], (err, tableRow) => {
    const actualTableNo = tableRow ? tableRow.table_no : targetId;

    // FULLPROOF FIX: 
    // 1. paid_amount = total kar diya taaki table par koi payable amount (balance) na bache!
    // 2. payment_mode update ho gaya.
    // 3. table_no ko khali ('') kar diya taaki table green (free) ho jaye.
    // 4. Kitchen pending (RUNNING_TABLE) ho toh status nahi chhuda, KOT KDS par bani rahe.
    //    Kitchen done (KOT_DONE) ho toh ab order active list se hata do.
    db.run(
      `UPDATE orders 
       SET payment_mode = ?, 
           paid_amount = total,
           table_no = '',
           status = CASE WHEN UPPER(status) = 'KOT_DONE'
                         THEN (CASE WHEN ? = 'DUE' THEN 'DUE_PENDING' ELSE 'DISPATCHED' END)
                         ELSE status END
       WHERE (table_no = ? OR id = ?) 
         AND status != 'COMPLETED' 
         AND status != 'VOID'`,
      [mode, mode, actualTableNo, targetId],
      function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        console.log(`[SETTLE SUCCESS] Table ${actualTableNo} settled via ${mode}. Paid amount updated to total. KDS KOT intact.`);
        res.json({ success: true, changes: this.changes });
      }
    );
  });
});
// ================= KDS API ROUTE (STRICT FILTER) =================
app.get('/api/kot', (req, res) => {
  const query = `
    SELECT o.id, o.token_no, o.order_type, o.table_no, o.status, o.created_at, TO_CHAR(o.created_at, 'HH12:MI AM') as time 
    FROM orders o 
    WHERE UPPER(o.status) = 'RUNNING_TABLE'
    ORDER BY o.id ASC
  `;

  db.all(query, [], async (err, orders) => {
    if (err) {
      console.error('KOT fetch error:', err.message);
      return res.json([]);
    }

    if (!orders || orders.length === 0) {
      return res.json([]);
    }

    try {
      const fullOrders = await Promise.all(
        orders.map(order => {
          return new Promise((resolve) => {
            db.all("SELECT id, name, qty, notes, user_note, pack_flip FROM order_items WHERE order_id = ? AND name <> 'Delivery Charge' ORDER BY id ASC", [order.id], (err2, items) => {
              resolve({ ...order, items: items || [] });
            });
          });
        })
      );
      res.json(fullOrders);
    } catch (e) {
      res.json(orders.map(o => ({ ...o, items: [] })));
    }
  });
});
app.post('/api/kot/:id/complete', (req, res) => {
  const orderId = req.params.id;

  // AUTO-DISPATCH REMOVED: Status sirf 'KOT_DONE' set hoga, 'COMPLETED' nahi.
  db.run("UPDATE orders SET status = 'KOT_DONE', ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP) WHERE id = ?", [orderId], (err2) => {
    if (err2) {
      console.error('[KDS COMPLETE ERROR]:', err2.message);
      return res.status(500).json({ error: err2.message });
    }
    console.log(`[KDS COMPLETE] Order #${orderId} marked KOT_DONE.`);
    res.json({ success: true });
  });
});

app.post('/api/kot/:id/dispatch', (req, res) => {
  const orderId = req.params.id;

  // KDS done: order KDS se hat jayega.
  // - DUE (khata) -> DUE_PENDING taaki Due list me rahe
  // - Payment baaki -> KOT_DONE taaki active list me rahe jab tak payment na ho
  // - Poora paid -> DISPATCHED
  db.run(`UPDATE orders
          SET status = CASE
            WHEN UPPER(COALESCE(payment_mode, '')) = 'DUE' THEN 'DUE_PENDING'
            WHEN UPPER(COALESCE(payment_mode, '')) IN ('', 'UNPAID', 'PAY_COUNTER', 'ONLINE_PENDING')
              OR COALESCE(paid_amount, 0) < total THEN 'KOT_DONE'
            ELSE 'DISPATCHED'
          END,
          ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP)
          WHERE id = ?`, [orderId], (err) => {
    if (err) {
      console.error('[KDS DISPATCH ERROR]:', err.message);
      return res.status(500).json({ error: err.message });
    }
    console.log(`[KDS DISPATCH] Order #${orderId} manually dispatched.`);
    res.json({ success: true });
  });
});
app.get('/api/customers/:phone', (req, res) => {
  db.get("SELECT * FROM customers WHERE phone = ?", [req.params.phone], (err, row) => res.json(row || null));
});

app.get('/api/customers', (req, res) => {
  db.all("SELECT * FROM customers ORDER BY due_balance DESC, total_spent DESC LIMIT 100", [], (err, rows) => res.json(rows || []));
});

app.get('/api/expenses/today', (req, res) => {
  db.all("SELECT id, title, amount, payment_mode, TO_CHAR(created_at, 'HH12:MI AM') as time FROM expenses WHERE created_at::date = CURRENT_DATE ORDER BY id DESC", [], (err, rows) => res.json(rows || []));
});

app.post('/api/expenses', (req, res) => {
  const { title, amount, payment_mode } = req.body;
  db.all(
    "INSERT INTO expenses (title, amount, payment_mode) VALUES (?, ?, ?) RETURNING id",
    [title, amount, payment_mode || 'CASH'],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const id = result && result[0] ? result[0].id : null;
      res.json({ success: true, id });
    }
  );
});

app.get('/api/reports/analytics', (req, res) => {
  const { startDate, endDate } = req.query;
  const start = startDate ? startDate : new Date().toISOString().slice(0, 10);
  const end = endDate ? endDate : new Date().toISOString().slice(0, 10);

  const summaryQuery = `
    SELECT 
      COUNT(*) AS total_orders,
      COALESCE(SUM(total), 0) AS total_sales,
      COALESCE(SUM(subtotal), 0) AS subtotal_sales,
      COALESCE(SUM(discount), 0) AS total_discount,
      COALESCE(SUM(gst), 0) AS total_gst,
      COALESCE(SUM(CASE WHEN payment_mode = 'CASH' AND status != 'DUE_PENDING' THEN total ELSE 0 END), 0) AS cash_sales,
      COALESCE(SUM(CASE WHEN payment_mode = 'UPI' AND status != 'DUE_PENDING' THEN total ELSE 0 END), 0) AS upi_sales,
      COALESCE(SUM(CASE WHEN payment_mode = 'DUE' OR status = 'DUE_PENDING' THEN total ELSE 0 END), 0) AS due_sales
    FROM orders 
    WHERE (created_at::date BETWEEN ?::date AND ?::date OR DATE(created_at) BETWEEN DATE(?) AND DATE(?))
      AND status = 'COMPLETED'
  `;

  const expenseQuery = `
    SELECT 
      COALESCE(SUM(amount), 0) as total_expense,
      COALESCE(SUM(CASE WHEN payment_mode = 'CASH' THEN amount ELSE 0 END), 0) as cash_expense
    FROM expenses 
    WHERE (created_at::date BETWEEN ?::date AND ?::date OR DATE(created_at) BETWEEN DATE(?) AND DATE(?))
  `;

  const topItemsQuery = `
    SELECT oi.name, SUM(oi.qty) as total_qty, SUM(oi.price * oi.qty) as total_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE (o.created_at::date BETWEEN ?::date AND ?::date OR DATE(o.created_at) BETWEEN DATE(?) AND DATE(?))
      AND o.status = 'COMPLETED'
    GROUP BY oi.name
    ORDER BY total_qty DESC
    LIMIT 10
  `;

  const ordersListQuery = `
    SELECT id, token_no, order_type, table_no, customer_name, customer_phone, payment_mode, status, subtotal, discount, gst, total, COALESCE(paid_amount, total) as paid_amount, created_at
    FROM orders 
    WHERE (created_at::date BETWEEN ?::date AND ?::date OR DATE(created_at) BETWEEN DATE(?) AND DATE(?))
      AND status = 'COMPLETED'
    ORDER BY id DESC
  `;

  db.get(summaryQuery, [start, end, start, end], (err, summary) => {
    if (err) return res.status(500).json({ error: err.image });
    db.get(expenseQuery, [start, end, start, end], (err2, exp) => {
      const summaryData = summary || {};
      summaryData.total_expense = exp ? exp.total_expense : 0;
      summaryData.cash_expense = exp ? exp.cash_expense : 0;
      summaryData.net_cash_in_hand = (summaryData.cash_sales || 0) - (summaryData.cash_expense || 0);

      db.all(topItemsQuery, [start, end, start, end], (err3, topItems) => {
        db.all(ordersListQuery, [start, end, start, end], async (err4, ordersList) => {
          let fullOrdersList = [];
          if (ordersList && ordersList.length > 0) {
            fullOrdersList = await Promise.all(
              ordersList.map(ord => {
                return new Promise(resolve => {
                  db.all("SELECT name, qty, price FROM order_items WHERE order_id = ?", [ord.id], (errIt, items) => {
                    resolve({ ...ord, items: items || [] });
                  });
                });
              })
            );
          }

          res.json({
            summary: summaryData,
            topItems: topItems || [],
            orders: fullOrdersList,
            range: {start, end}
          });
        });
      });
    });
  });
});

app.post('/api/verify-pin', (req, res) => {
  db.get("SELECT admin_pin FROM settings WHERE id = 1", [], (err, row) => {
    res.json({ valid: req.body.pin === ((row && row.admin_pin) ? row.admin_pin : '1234') });
  });
});

// Never expose the owner PIN or the JSON config (gateway secrets live there) through this public endpoint.
app.get('/api/settings', (req, res) => db.get("SELECT * FROM settings WHERE id = 1", [], (err, row) => {
  const out = Object.assign({}, row || {});
  delete out.admin_pin;
  delete out.config;
  res.json(out);
}));

app.post('/api/settings', (req, res) => {
  const { restaurant_name, tagline, address, phone, gstin, default_gst, admin_pin } = req.body;
  db.run(`
    INSERT INTO settings (id, restaurant_name, tagline, address, phone, gstin, default_gst, admin_pin)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      restaurant_name = excluded.restaurant_name, tagline = excluded.tagline, address = excluded.address,
      phone = excluded.phone, gstin = excluded.gstin, default_gst = excluded.default_gst, admin_pin = COALESCE(excluded.admin_pin, settings.admin_pin)
  `, [restaurant_name, tagline, address, phone, gstin, default_gst || 5, admin_pin || null], () => res.json({ success: true }));
});

// Extra settings (map location, delivery distance, table/order automation, phone rules...) live in settings.config (JSON).
// PUT merges the given top-level keys, so each settings card can save only its own section.
async function getSettingsConfig() {
  try {
    const rows = await dbAllAsync('SELECT config FROM settings WHERE id = 1', []);
    return parseJsonSafe(rows[0] && rows[0].config, {}) || {};
  } catch (e) { return {}; }
}
// Settings > Order Timers: the restaurant's own last-30-day numbers (minutes). Kitchen time = KDS done - accepted
// (orders that never needed approval count from order creation); awaiting = accepted - placed.
app.get('/api/order-timer-stats', async (req, res) => {
  try {
    const typeOf = t => (/delivery/i.test(t) ? 'delivery' : /takeaway|pickup/i.test(t) ? 'takeaway' : 'dine_in');
    const counts = await dbAllAsync(`SELECT order_type, COUNT(*) AS n FROM orders WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days' AND COALESCE(status, '') NOT IN ('VOID', 'CANCELLED', 'HOLD') GROUP BY order_type`, []);
    const kitchen = await dbAllAsync(`SELECT order_type, COUNT(*) AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY m) AS med, percentile_cont(0.9) WITHIN GROUP (ORDER BY m) AS p90
      FROM (SELECT order_type, EXTRACT(EPOCH FROM (ready_at - COALESCE(accepted_at, created_at))) / 60 AS m FROM orders
            WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days' AND ready_at IS NOT NULL AND ready_at >= COALESCE(accepted_at, created_at)) t
      GROUP BY order_type`, []);
    const awaiting = await dbAllAsync(`SELECT COUNT(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY m) AS med, percentile_cont(0.9) WITHIN GROUP (ORDER BY m) AS p90
      FROM (SELECT EXTRACT(EPOCH FROM (accepted_at - created_at)) / 60 AS m FROM orders
            WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days' AND accepted_at IS NOT NULL AND accepted_at >= created_at) t`, []);
    const stages = { dine_in: { n: 0 }, takeaway: { n: 0 }, delivery: { n: 0 }, rider: { n: 0 }, awaiting: { n: 0 }, ready_no_rider: { n: 0 } };
    counts.forEach(r => { stages[typeOf(r.order_type)].n += Number(r.n); });
    const acc = {};
    kitchen.forEach(r => {
      const k = typeOf(r.order_type), a = acc[k] || (acc[k] = { w: 0, med: 0, p90: 0 }), w = Number(r.n);
      a.w += w; a.med += Number(r.med) * w; a.p90 += Number(r.p90) * w;   // merge order_type variants, weighted by count
    });
    Object.keys(acc).forEach(k => { stages[k].usual = acc[k].med / acc[k].w; stages[k].slow = acc[k].p90 / acc[k].w; });
    const aw = awaiting[0];
    if (aw && Number(aw.n) > 0) { stages.awaiting = { n: Number(aw.n), usual: Number(aw.med), slow: Number(aw.p90) }; }
    const to = new Date(), from = new Date(Date.now() - 30 * 86400000);
    res.json({ from: from.toISOString(), to: to.toISOString(), stages });
  } catch (e) {
    console.error('Timer stats error:', e.message);
    res.status(500).json({ error: 'stats unavailable' });
  }
});

// Gateway secrets (payments_secrets) are write-only: never returned, only "is it set" flags.
function publicConfig(cfg) {
  const out = Object.assign({}, cfg);
  const sec = out.payments_secrets || {};
  delete out.payments_secrets;
  out.secrets_set = { key_secret: !!sec.key_secret, webhook_secret: !!sec.webhook_secret };
  return out;
}
app.get('/api/settings/config', async (req, res) => res.json(publicConfig(await getSettingsConfig())));
app.put('/api/settings/config', async (req, res) => {
  const patch = req.body;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'Invalid settings' });
  const current = await getSettingsConfig();
  const next = Object.assign({}, patch);
  delete next.secrets_set;
  if (next.payments_secrets) {
    // empty value = keep the stored secret
    const merged = Object.assign({}, current.payments_secrets || {});
    ['key_secret', 'webhook_secret'].forEach(k => { if (typeof next.payments_secrets[k] === 'string' && next.payments_secrets[k].trim()) merged[k] = next.payments_secrets[k].trim(); });
    next.payments_secrets = merged;
  }
  const cfg = Object.assign(current, next);
  db.run(`INSERT INTO settings (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config`, [JSON.stringify(cfg)],
    (err) => (err ? res.status(500).json({ error: err.message }) : res.json({ success: true, config: publicConfig(cfg) })));
});


app.get('/api/system/backup', (req, res) => res.download(path.join(__dirname, 'restaurant.db'), `POS_Backup_${new Date().toISOString().slice(0, 10)}.db`));

app.post('/api/system/reset-orders', (req, res) => {
  db.run(`DELETE FROM order_items WHERE order_id IN (
    SELECT id FROM orders WHERE status = 'COMPLETED' AND payment_mode != 'DUE'
  )`, [], () => {
    db.run(`DELETE FROM orders WHERE status = 'COMPLETED' AND payment_mode != 'DUE'`, [], () => {
      db.run("DELETE FROM expenses", [], () => {
        db.run("DELETE FROM customers WHERE due_balance <= 0", [], () => {
          console.log("[SAFE RESET] Sales reset completed. Due orders preserved.");
          res.json({ success: { status: true }, message: "Settled sales deleted. All Due orders preserved." });
        });
      });
    });
  });
});

// ================= WHATSAPP INTEGRATION APIS =================
app.get('/api/whatsapp/status', (req, res) => {
  res.json({ connected: false, status: 'disconnected', qr: null });
});

app.post('/api/whatsapp/connect', (req, res) => {
  res.json({ success: true, message: 'WhatsApp connection initiated' });
});

app.post('/api/whatsapp/disconnect', (req, res) => {
  res.json({ success: true, message: 'Disconnected successfully' });
});

require('./paytmUpi').register(app, { dbAllAsync, createOrderHandler }); require('./razorpayPay').register(app, { dbAllAsync, createOrderHandler });
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server par port ${PORT} par chal raha hai.`);
});
