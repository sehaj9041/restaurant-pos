const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { exec } = require('child_process');
const XLSX = require('xlsx');
const net = require('net');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

// Auto-migrate paid_amount column in orders table if not present
db.run("ALTER TABLE orders ADD COLUMN paid_amount REAL DEFAULT 0", (err) => {});

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

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, 'public/uploads');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });
const uploadExcel = multer({ dest: 'uploads/' });

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ imageUrl: '/uploads/' + req.file.filename });
});

// ================= EXCEL MENU IMPORT API =================
app.post('/api/menu/import-excel', uploadExcel.single('menuFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const workbook = XLSX.readFile(req.file.path);
    
    // 1. Categories Import
    const catSheet = workbook.Sheets['Categories'];
    const categories = catSheet ? XLSX.utils.sheet_to_json(catSheet) : [];
    for (const cat of categories) {
      const catName = cat['Category Name'] || cat['category'];
      if (!catName) continue;
      await new Promise(resolve => {
        db.run("INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING", [catName], () => resolve());
      });
    }

    // 2. Menu Items Import
    const itemSheet = workbook.Sheets['Menu Items'];
    const items = itemSheet ? XLSX.utils.sheet_to_json(itemSheet) : [];
    for (const item of items) {
      const itemName = item['Item Name'] || item['item_name'];
      const category = item['Category'] || 'General';
      const price = Number(item['Base Price (₹)'] || item['price']) || 0;
      const image = item['Image URL'] || item['image'] || '';
      const status = item['Availability'] || 'available';
      const stock = status === 'available' ? 50 : 0;

      if (!itemName) continue;
      
      await new Promise(resolve => {
        db.run(
          `INSERT INTO menu (name, category, price, stock, image) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET category = excluded.category, price = excluded.price, image = excluded.image, stock = excluded.stock`,
          [itemName, category, price, stock, image],
          () => resolve()
        );
      });
    }

    try { fs.unlinkSync(req.file.path); } catch(e) {}
    console.log(`[MENU IMPORT SUCCESS] Successfully imported ${items.length} items from Excel.`);
    res.json({ success: true, message: `Successfully imported ${items.length} menu items!` });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    console.error('Import error:', err.message);
    res.status(500).json({ success: false, error: err.message });
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
  db.all("SELECT * FROM categories ORDER BY id ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/categories', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  db.run("INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING", [name.trim()], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
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
  db.all("SELECT * FROM addon_groups ORDER BY id DESC", [], (err, rows) => {
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

app.delete('/api/addon-groups/:id', (req, res) => {
  db.run("DELETE FROM addon_groups WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 5. VARIATION SETS MASTER APIS
app.get('/api/variation-masters', (req, res) => {
  db.all("SELECT * FROM variation_masters ORDER BY id DESC", [], (err, rows) => {
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
  db.all("SELECT * FROM menu ORDER BY category, name", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/menu', (req, res) => {
  const { name, category, price, stock, image, variations, assigned_addon_groups, is_exempt } = req.body;
  db.all(
    `INSERT INTO menu (name, category, price, stock, image, variations, assigned_addon_groups, is_exempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [name, category || 'General', price, stock || 50, image || '', JSON.stringify(variations || []), JSON.stringify(assigned_addon_groups || []), is_exempt ? 1 : 0],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const id = result && result[0] ? result[0].id : null;
      res.json({ success: true, id });
    }
  );
});

app.put('/api/menu/:id', (req, res) => {
  const { name, category, price, stock, image, variations, assigned_addon_groups, is_exempt } = req.body;
  db.run(
    `UPDATE menu SET name = ?, category = ?, price = ?, stock = ?, image = ?, variations = ?, assigned_addon_groups = ?, is_exempt = ? WHERE id = ?`,
    [name, category, price, stock, image || '', JSON.stringify(variations || []), JSON.stringify(assigned_addon_groups || []), is_exempt ? 1 : 0, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/menu/:id', (req, res) => {
  db.run("DELETE FROM menu WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
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
    SELECT id, order_type, table_no, customer_name, customer_phone, total, subtotal, discount, gst, payment_mode, status, COALESCE(paid_amount, 0) as paid_amount, created_at
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
            db.all('SELECT id, name, qty, price, notes FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
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
  
  db.get("SELECT order_type FROM orders WHERE id = ?", [orderId], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });

    let type
