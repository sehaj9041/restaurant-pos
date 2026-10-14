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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

let liveCustomerCart = {
  items: [],
  subtotal: 0,
  discount: 0,
  gst: 0,
  total: 0,
  orderType: 'Dine-In',
  tableNo: ''
};

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
    
    const catSheet = workbook.Sheets['Categories'];
    const categories = catSheet ? XLSX.utils.sheet_to_json(catSheet) : [];
    for (const cat of categories) {
      const catName = cat['Category Name'] || cat['category'];
      if (!catName) continue;
      await new Promise(resolve => {
        db.run("INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING", [catName], () => resolve());
      });
    }

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
    res.json({ success: true, message: `Successfully imported ${items.length} menu items!` });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/display/sync', (req, res) => {
  liveCustomerCart = req.body;
  res.json({ success: true });
});

app.get('/api/display/current', (req, res) => {
  res.json(liveCustomerCart);
});

const triggerDrawerKick = (req, res) => {
  const psCommand = `powershell -NoProfile -Command "$bytes = [byte[]](0x1B,0x70,0x01,0x19,0xFA); $path = [System.IO.Path]::Combine($env:TEMP, 'kick.bin'); [System.IO.File]::WriteAllBytes($path, $bytes); Get-Content -Path $path -Encoding Byte -Raw | Out-Printer -Name 'Posiflex PP8803 Printerrr'; Remove-Item $path -ErrorAction SilentlyContinue"`;

  exec(psCommand, (error) => {
    if (error) {
      return res.status(500).json({ success: false, message: 'Drawer trigger error', error: error.message });
    }
    res.json({ success: true });
  });
};

app.post('/api/drawer/open', triggerDrawerKick);
app.post('/api/open-drawer', triggerDrawerKick);

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
    [name || 'New Group', min_selection !== undefined ? min_selection : 0, max_selection !== undefined ? max_selection : 5, is_mandatory ? 1 : 0, JSON.stringify(items || [])],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
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
    if (err) return res.json({ total_orders: 0, total_sales: 0, completed_today: 0, delivery_count: 0, void_count: 0 });
    res.json(row || { total_orders: 0, total_sales: 0, completed_today: 0, delivery_count: 0, void_count: 0 });
  });
});

app.get('/api/orders/needs-approval', (req, res) => {
  const query = `
    SELECT id, order_type, table_no, customer_name, customer_phone, total, subtotal, discount, gst, payment_mode, status, COALESCE(paid_amount, 0) as paid_amount, created_at
    FROM orders 
    WHERE UPPER(status) = 'NEES_APPROVAL' OR UPPER(status) = 'NEEDS_APPROVAL'
    ORDER BY id DESC
  `;

  db.all(query, [], async (err, orders) => {
    if (err || !orders) return res.json([]);
    const fullOrders = await Promise.all(
      orders.map(order => new Promise(resolve => {
        db.all('SELECT id, name, qty, price, notes FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
          resolve({ ...order, items: items || [] });
        });
      }))
    );
    res.json(fullOrders);
  });
});

app.post('/api/orders/:id/approve', (req, res) => {
  const orderId = req.params.id;
  db.get("SELECT order_type FROM orders WHERE id = ?", [orderId], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });
    let type = (order.order_type || '').toLowerCase();
    let newTableNo = type.includes('delivery') ? 'Delivery' : (type.includes('takeaway') ? 'Takeaway' : '');
    db.run("UPDATE orders SET status = 'RUNNING_TABLE', table_no = ? WHERE id = ?", [newTableNo, orderId], () => {
      res.json({ success: true });
    });
  });
});

app.post('/api/orders/:id/reject', (req, res) => {
  db.run("UPDATE orders SET status = 'VOID' WHERE id = ?", [req.params.id], () => res.json({ success: true }));
});

app.post('/api/orders/:id/assign-table', (req, res) => {
  const { table_no } = req.body;
  db.run("UPDATE orders SET table_no = ?, status = 'RUNNING_TABLE' WHERE id = ?", [(table_no || '').trim().toUpperCase(), req.params.id], () => {
    res.json({ success: true });
  });
});

app.get('/api/orders/active', (req, res) => {
  const query = `
    SELECT id, order_type, table_no, customer_name, customer_phone, total, subtotal, discount, gst, payment_mode, status, COALESCE(paid_amount, 0) as paid_amount
    FROM orders 
    WHERE UPPER(status) NOT IN ('COMPLETED', 'NEEDS_APPROVAL', 'VOID', 'DUE_PENDING')
       OR UPPER(status) = 'RUNNING_TABLE'
       OR UPPER(status) = 'RUNNING'
       OR UPPER(status) = 'KOT_READY'
    ORDER BY id DESC
  `;

  db.all(query, [], async (err, orders) => {
    if (err || !orders) return res.json([]);
    const fullOrders = await Promise.all(
      orders.map(order => new Promise(resolve => {
        db.all('SELECT id, name, qty, price, notes FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
          resolve({ ...order, items: items || [] });
        });
      }))
    );
    res.json(fullOrders);
  });
});

// ================= DEDICATED DUE (KHATA) APIS =================

app.get('/api/due/orders', (req, res) => {
  const query = `
    SELECT 
      id, order_type, table_no, customer_name, customer_phone, 
      total, COALESCE(paid_amount, 0) as paid_amount,
      GREATEST(0, total - COALESCE(paid_amount, 0)) as due_amount,
      payment_mode, status, created_at
    FROM orders
    WHERE status != 'COMPLETED' 
      AND status != 'VOID'
      AND (
        UPPER(payment_mode) LIKE '%DUE%' 
        OR UPPER(payment_mode) LIKE '%KHATA%'
        OR status = 'DUE_PENDING'
        OR (total - COALESCE(paid_amount, 0)) > 0
      )
    ORDER BY id DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err || !rows) return res.json([]);
    const now = new Date();
    const formatted = rows.map(r => {
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
      AND status != 'VOID'
      AND (
        UPPER(payment_mode) LIKE '%DUE%' 
        OR UPPER(payment_mode) LIKE '%KHATA%'
        OR status = 'DUE_PENDING'
        OR (total - COALESCE(paid_amount, 0)) > 0
      )
    GROUP BY COALESCE(NULLIF(customer_phone, ''), 'WALK-IN')
    HAVING SUM(GREATEST(0, total - COALESCE(paid_amount, 0))) > 0
    ORDER BY total_due DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err || !rows) return res.json([]);
    const now = new Date();
    const formatted = rows.map(r => {
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
  db.run("UPDATE orders SET status = 'COMPLETED', payment_mode = ?, paid_amount = total WHERE customer_phone = ? AND status != 'COMPLETED'", [mode, phone], () => {
    res.json({ success: true, message: 'All bills cleared successfully' });
  });
});

app.get('/api/orders/history', (req, res) => {
  const query = `
    SELECT id, order_type, table_no, customer_name, customer_phone, payment_mode, status, subtotal, discount, gst, total, COALESCE(paid_amount, total) as paid_amount, created_at
    FROM orders 
    WHERE status = 'COMPLETED'
      AND UPPER(payment_mode) NOT LIKE '%DUE%'
      AND UPPER(payment_mode) NOT LIKE '%KHATA%'
      AND (total - COALESCE(paid_amount, 0)) <= 0
    ORDER BY id DESC
    LIMIT 200
  `;

  db.all(query, [], async (err, orders) => {
    if (err || !orders) return res.json([]);
    const fullOrders = await Promise.all(
      orders.map(order => new Promise(resolve => {
        db.all('SELECT name, qty, price FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
          resolve({ ...order, items: items || [] });
        });
      }))
    );
    res.json(fullOrders);
  });
});

app.post('/api/orders', async (req, res) => {
  const { order_type, table_no, customer_name, customer_phone, items, payment_mode, subtotal, discount, is_hold, paid_amount, is_kiosk } = req.body;

  let rawType = (order_type || 'Kiosk').trim();
  let upperType = rawType.toUpperCase();
  let normalizedOrderType = rawType;
  if (upperType.includes('DELIVERY')) normalizedOrderType = 'Delivery';
  else if (upperType.includes('TAKEAWAY') || upperType.includes('PICKUP')) normalizedOrderType = 'Takeaway';
  else if (upperType.includes('DINE') || upperType.includes('EAT') || upperType.includes('KIOSK')) normalizedOrderType = 'Dine-In';

  let calculatedSubtotal = Number(subtotal) || 0;
  if (calculatedSubtotal === 0 && Array.isArray(items)) {
    calculatedSubtotal = items.reduce((sum, i) => sum + (Number(i.price) * Number(i.qty)), 0);
  }

  let calculatedGst = Math.round((calculatedSubtotal * 5) / 100);
  let calculatedTotal = Math.round(calculatedSubtotal + calculatedGst - (Number(discount) || 0));

  let initialPaid = 0;
  const isDueMode = payment_mode === 'DUE' || (payment_mode && payment_mode.toUpperCase().includes('DUE'));
  if (payment_mode && payment_mode !== 'UNPAID' && !isDueMode) {
    initialPaid = Number(paid_amount) || calculatedTotal || 0;
  } else {
    initialPaid = 0;
  }

  let status = 'RUNNING_TABLE';
  if (is_hold) status = 'RUNNING_TABLE';
  else if (is_kiosk || upperType.includes('ONLINE') || upperType.includes('SELF')) status = 'NEEDS_APPROVAL';
  else if (isDueMode || payment_mode === 'UNPAID') status = 'DUE_PENDING';

  db.all(
    `INSERT INTO orders (order_type, table_no, customer_name, customer_phone, status, payment_mode, subtotal, discount, gst, total, paid_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [normalizedOrderType, table_no || '', customer_name || '', customer_phone || '', status, payment_mode || 'Cash', calculatedSubtotal, discount || 0, calculatedGst, calculatedTotal, initialPaid],
    async (err, result) => {
      if (err || !result || !result[0]) return res.status(500).json({ error: err ? err.message : 'Failed' });
      const orderId = result[0].id;

      if (Array.isArray(items)) {
        for (const item of items) {
          await new Promise(resolve => {
            db.run('INSERT INTO order_items (order_id, name, qty, price, notes) VALUES (?, ?, ?, ?, ?)', [orderId, item.name, item.qty, item.price, item.notes || ''], () => resolve());
          });
        }
      }
      res.json({ success: true, orderId: orderId, paid_amount: initialPaid });
    }
  );
});

app.post('/api/tables/:id/settle', (req, res) => {
  const { payment_mode } = req.body;
  const orderId = req.params.id;
  const mode = (payment_mode || 'Cash').toUpperCase();

  db.get("SELECT table_no FROM orders WHERE id = ?", [orderId], (err, targetOrder) => {
    if (err || !targetOrder) return res.status(404).json({ error: 'Order not found' });
    const tblNo = targetOrder.table_no ? targetOrder.table_no.trim() : '';
    let updateQuery = tblNo !== '' ? "UPDATE orders SET status = 'COMPLETED', payment_mode = ?, paid_amount = total WHERE UPPER(table_no) = ? AND status != 'COMPLETED'" : "UPDATE orders SET status = 'COMPLETED', payment_mode = ?, paid_amount = total WHERE id = ?";
    let queryParams = tblNo !== '' ? [mode, tblNo.toUpperCase()] : [mode, orderId];

    db.run(updateQuery, queryParams, () => res.json({ success: true }));
  });
});

app.post('/api/orders/:id/mark-due', (req, res) => {
  db.run("UPDATE orders SET status = 'DUE_PENDING', payment_mode = 'DUE', paid_amount = 0 WHERE id = ?", [req.params.id], () => res.json({ success: true }));
});

app.get('/api/kot', (req, res) => {
  db.all(`SELECT o.id, o.order_type, o.table_no, o.created_at, TO_CHAR(o.created_at, 'HH12:MI AM') as time, o.customer_name FROM orders o WHERE o.status IN ('RUNNING_TABLE', 'DUE_PENDING', 'RUNNING', 'KOT_READY') ORDER BY o.id ASC`, [], async (err, orders) => {
    if (err || !orders) return res.json([]);
    const fullOrders = await Promise.all(orders.map(ord => new Promise(resolve => {
      db.all('SELECT id, name, qty, notes FROM order_items WHERE order_id = ? ORDER BY id ASC', [ord.id], (err2, items) => {
        resolve({ ...ord, all_merged_ids: ord.id.toString(), display_id_label: `#${ord.id}`, items: items || [] });
      });
    })));
    res.json(fullOrders);
  });
});

app.post('/api/kot/:id/complete', (req, res) => {
  db.run("UPDATE orders SET status = 'COMPLETED' WHERE id = ?", [req.params.id], () => res.json({ success: true }));
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
  db.all("INSERT INTO expenses (title, amount, payment_mode) VALUES (?, ?, ?) RETURNING id", [title, amount, payment_mode || 'CASH'], (err, result) => {
    res.json({ success: true, id: result && result[0] ? result[0].id : 1 });
  });
});

app.post('/api/verify-pin', (req, res) => {
  db.get("SELECT admin_pin FROM settings WHERE id = 1", [], (err, row) => {
    res.json({ valid: req.body.pin === ((row && row.admin_pin) ? row.admin_pin : '1234') });
  });
});

app.get('/api/settings', (req, res) => db.get("SELECT * FROM settings WHERE id = 1", [], (err, row) => res.json(row || {})));

app.post('/api/settings', (req, res) => {
  const { restaurant_name, tagline, address, phone, gstin, default_gst, admin_pin } = req.body;
  db.run(`INSERT INTO settings (id, restaurant_name, tagline, address, phone, gstin, default_gst, admin_pin) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET restaurant_name = excluded.restaurant_name, tagline = excluded.tagline, address = excluded.address, phone = excluded.phone, gstin = excluded.gstin, default_gst = excluded.default_gst, admin_pin = COALESCE(excluded.admin_pin, settings.admin_pin)`, [restaurant_name, tagline, address, phone, gstin, default_gst || 5, admin_pin || '1234'], () => res.json({ success: true }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server par port ${PORT} par chal raha hai.`);
});
