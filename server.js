const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

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

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ imageUrl: '/uploads/' + req.file.filename });
});

// 1. CUSTOMER DISPLAY SYNC APIS
app.post('/api/display/sync', (req, res) => {
  liveCustomerCart = req.body;
  res.json({ success: true });
});

app.get('/api/display/current', (req, res) => {
  res.json(liveCustomerCart);
});

// 2. CASH DRAWER KICK PULSE
app.post('/api/drawer/open', (req, res) => {
  res.json({ success: true, pulse: "\x1b\x70\x00\x19\xfa" });
});

// 3. INTERACTIVE FLOOR PLAN APIS
app.get('/api/floor-tables', (req, res) => {
  db.all("SELECT * FROM floor_tables ORDER BY id ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows || rows.length === 0) {
      const stmt = db.prepare("INSERT INTO floor_tables (table_no, x, y, seats) VALUES (?, ?, ?, ?)");
      for (let i = 1; i <= 8; i++) {
        stmt.run(`T-${i}`, ((i - 1) % 4) * 120 + 20, Math.floor((i - 1) / 4) * 100 + 20, 4);
      }
      stmt.finalize(() => {
        db.all("SELECT * FROM floor_tables ORDER BY id ASC", [], (err2, rows2) => res.json(rows2));
      });
    } else {
      res.json(rows);
    }
  });
});

app.post('/api/floor-tables/save-positions', (req, res) => {
  const { tables } = req.body;
  const stmt = db.prepare("UPDATE floor_tables SET x = ?, y = ? WHERE id = ?");
  tables.forEach(t => stmt.run(t.x, t.y, t.id));
  stmt.finalize(() => res.json({ success: true }));
});

app.post('/api/floor-tables', (req, res) => {
  const { table_no, seats, x, y } = req.body;
  db.run("INSERT INTO floor_tables (table_no, seats, x, y) VALUES (?, ?, ?, ?)",
    [table_no, seats || 4, x || 20, y || 20],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.delete('/api/floor-tables/:id', (req, res) => {
  db.run("DELETE FROM floor_tables WHERE id = ?", [req.params.id], () => res.json({ success: true }));
});

// 4. GLOBAL ADD-ON GROUPS APIS
app.get('/api/addon-groups', (req, res) => {
  db.all("SELECT * FROM addon_groups ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/addon-groups', (req, res) => {
  const { name, min_selection, max_selection, is_mandatory, items } = req.body;
  db.run(
    `INSERT INTO addon_groups (name, min_selection, max_selection, is_mandatory, items) VALUES (?, ?, ?, ?, ?)`,
    [name, min_selection || 0, max_selection || 5, is_mandatory ? 1 : 0, JSON.stringify(items || [])],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
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
    res.json(rows);
  });
});

app.post('/api/variation-masters', (req, res) => {
  const { name, options } = req.body;
  db.run(
    "INSERT INTO variation_masters (name, options) VALUES (?, ?)",
    [name, JSON.stringify(options || [])],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
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
      res.json({ success: true, updated: this.changes });
    }
  );
});

// 6. MENU APIS
app.get('/api/menu', (req, res) => {
  db.all("SELECT * FROM menu ORDER BY category, name", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/menu', (req, res) => {
  const { name, category, price, stock, image, variations, assigned_addon_groups, is_exempt } = req.body;
 db.run(
    `INSERT INTO menu (name, category, price, stock, image, variations, assigned_addon_groups, is_exempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, category || 'General', price, stock || 50, image || '', JSON.stringify(variations || []), JSON.stringify(assigned_addon_groups || []), is_exempt ? 1 : 0],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/menu/:id', (req, res) => {
  const { name, category, price, stock, image, variations, assigned_addon_groups, is_exempt } = req.body;
  db.run(
    `UPDATE menu SET name = ?, category = ?, price = ?, stock = ?, image = ?, variations = ?, assigned_addon_groups = ?, is_exampt = ? WHERE id = ?`,
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

// 7.// ACTIVE ORDERS (RUNNING_TABLE, PENDING, DUE_PENDING)
app.get('/api/orders/active', (req, res) => {
  const query = `
    SELECT id, order_type, table_no, customer_name, customer_phone, total, subtotal, discount, gst, payment_mode, status
    FROM orders 
    WHERE status IN ('RUNNING_TABLE', 'PENDING', 'DUE_PENDING', 'RUNNING') 
       OR order_type = 'Online' 
       OR payment_mode = 'Due'
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
            db.all('SELECT id, name, qty, price, notes FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
              resolve({ ...order, items: items || [] });
            });
          });
        })
      );
      res.json(fullOrders);
    } catch (e) {
      console.error('Items fetch error:', e.message);
      res.json(orders.map(o => ({ ...o, items: [] })));
    }
});
// Update Existing Order In-Place
app.put('/api/orders/:id', (req, res) => {
  const orderId = req.params.id;
  const { order_type, table_no, customer_name, customer_phone, items, subtotal, discount, gst, total, payment_mode } = req.body;
  const status = (payment_mode === 'DUE') ? 'DUE_PENDING' : 'RUNNING_TABLE';

  db.run(
    `UPDATE orders SET order_type = ?, table_no = ?, customer_name = ?, customer_phone = ?, subtotal = ?, discount = ?, gst = ?, total = ?, payment_mode = ?, status = ? WHERE id = ?`,
    [order_type, table_no || '', customer_name || '', customer_phone || '', subtotal, discount || 0, gst || 0, total, payment_mode, status, orderId],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      db.run("DELETE FROM order_items WHERE order_id = ?", [orderId], () => {
        const stmt = db.prepare("INSERT INTO order_items (order_id, name, qty, price, notes) VALUES (?, ?, ?, ?, ?)");
        items.forEach(i => stmt.run(orderId, i.name, i.qty, i.price, i.notes || ''));
        stmt.finalize(() => res.json({ success: true, orderId }));
      });
    }
  );
});

// Punch Order: DUE orders remain strictly in 'DUE_PENDING' status
app.post('/api/orders', (req, res) => {
  const { order_type, table_no, customer_name, customer_phone, items, payment_mode, subtotal, discount, gst, total, is_hold } = req.body;
  
  let status = 'COMPLETED';
  if (is_hold) {
    status = 'RUNNING_TABLE';
  } else if (payment_mode === 'DUE') {
    status = 'DUE_PENDING';
  }

  db.run(
    `INSERT INTO orders (order_type, table_no, customer_name, customer_phone, status, payment_mode, subtotal, discount, gst, total) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order_type, table_no || '', customer_name || '', customer_phone || '', status, payment_mode || 'PENDING', subtotal, discount || 0, gst || 0, total],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      const orderId = this.lastID;

      const stmt = db.prepare(`INSERT INTO order_items (order_id, name, qty, price, notes) VALUES (?, ?, ?, ?, ?)`);
      const stockStmt = db.prepare(`UPDATE menu SET stock = MAX(0, stock - ?) WHERE id = ?`);

      items.forEach(i => {
        stmt.run(orderId, i.name, i.qty, i.price, i.notes || '');
        if (i.menu_id) stockStmt.run(i.qty, i.menu_id);
      });
      stmt.finalize();
      stockStmt.finalize();

      if (customer_phone && customer_phone.trim().length >= 10 && !is_hold) {
        const dueIncrement = (payment_mode === 'DUE') ? total : 0;
        db.run(
          `INSERT INTO customers (phone, name, total_spent, due_balance, orders_count, last_visit)
           VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
           ON CONFLICT(phone) DO UPDATE SET
             name = COALESCE(excluded.name, customers.name),
             total_spent = customers.total_spent + excluded.total_spent,
             due_balance = customers.due_balance + ?,
             orders_count = customers.orders_count + 1,
             last_visit = CURRENT_TIMESTAMP`,
          [customer_phone, customer_name || 'Valued Guest', total, dueIncrement, dueIncrement]
        );
      }

      res.json({ success: true, orderId, total });
    }
  );
});

// Settle Order API
app.post('/api/tables/:id/settle', (req, res) => {
  const { payment_mode } = req.body;
  db.get("SELECT * FROM orders WHERE id = ?", [req.params.id], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });
    
    if (payment_mode === 'DUE') {
      if (order.customer_phone && order.customer_phone.length >= 10) {
        db.run("UPDATE customers SET due_balance = due_balance + ? WHERE phone = ?", [order.total, order.customer_phone]);
      }
      db.run("UPDATE orders SET status = 'DUE_PENDING', payment_mode = 'DUE' WHERE id = ?", [req.params.id], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ success: true, duePending: true });
      });
    } else {
      db.run("UPDATE orders SET status = 'COMPLETED', payment_mode = ? WHERE id = ?", [payment_mode, req.params.id], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ success: true });
      });
    }
  });
});

// Clear Customer Due from Directory
app.post('/api/customers/:phone/clear-due', (req, res) => {
  const { amount_paid, payment_mode } = req.body;
  const phone = req.params.phone;

  db.get("SELECT due_balance, name FROM customers WHERE phone = ?", [phone], (err, cust) => {
    if (err || !cust) return res.status(404).json({ error: 'Customer not found' });

    const payAmt = Number(amount_paid) || cust.due_balance;
    const newDue = Math.max(0, cust.due_balance - payAmt);

    db.run("UPDATE customers SET due_balance = ? WHERE phone = ?", [newDue, phone], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });

      if (newDue === 0) {
        db.run("UPDATE orders SET status = 'COMPLETED' WHERE customer_phone = ? AND status = 'DUE_PENDING'", [phone]);
      }
      console.log(`[KHATA CLEAR] Customer ${cust.name} paid Rs ${payAmt} via ${payment_mode || 'CASH'}. Remaining Due: Rs ${newDue}`);
      res.json({ success: true, remainingDue: newDue });
    });
  });
});

// 8. ROBUST THERMAL PRINTER AUTOMATION & VIRTUAL SIMULATOR
let ThermalPrinterClass = null;
let PrinterTypesObj = null;

try {
  const NTP = require("node-thermal-printer");
  ThermalPrinterClass = NTP.ThermalPrinter || NTP.thermalPrinter;
  PrinterTypesObj = NTP.PrinterTypes || NTP.types;
} catch (e) {
  console.log("Thermal library note: using built-in simulator engine.");
}

app.post('/api/printer/print-bill', async (req, res) => {
  const { orderId, orderType, tableNo, customerName, items, subtotal, discount, gst, total, mode } = req.body;

  try {
    if (ThermalPrinterClass && PrinterTypesObj) {
      const printer = new ThermalPrinterClass({
        type: PrinterTypesObj.EPSON,
        interface: '//localhost/ThermalPrinter',
        characterSet: 'SLOVENIA'
      });

      printer.alignCenter();
      printer.println("VISHAL FOODIEZ");
      printer.println("Budhlada, Punjab");
      printer.drawLine();
      printer.alignLeft();
      printer.println(`Order: #${orderId} | ${orderType}`);
      if (tableNo) printer.println(`Table: ${tableNo}`);
      if (customerName) printer.println(`Guest: ${customerName}`);
      printer.drawLine();

      items.forEach(item => {
        printer.println(`${item.name} x${item.qty} = Rs ${item.price * item.qty}`);
      });

      printer.drawLine();
      printer.println(`Total: Rs ${total}`);
      printer.println(`Payment Mode: ${mode}`);
      printer.cut();
      await printer.execute().catch(() => null);
    }
    console.log(`[PRINTER PIPELINE] Bill #${orderId} (Total: Rs ${total}) successfully processed.`);
    res.json({ success: true });
  } catch (error) {
    console.log(`[PRINTER SIMULATOR] Bill #${orderId} buffer created silently.`);
    res.json({ success: true, simulated: true });
  }
});

app.post('/api/printer/print-kot', async (req, res) => {
  const { orderId, orderType, tableNo, items } = req.body;
  try {
    if (ThermalPrinterClass && PrinterTypesObj) {
      const kotPrinter = new ThermalPrinterClass({
        type: PrinterTypesObj.EPSON,
        interface: '//localhost/KOTPrinter',
        characterSet: 'SLOVENIA'
      });
      kotPrinter.alignCenter();
      kotPrinter.println("*** KITCHEN TICKET (KOT) ***");
      kotPrinter.println(`Order: #${orderId} | ${orderType} | ${tableNo || ''}`);
      kotPrinter.drawLine();
      items.forEach(i => kotPrinter.println(`[ ] ${i.name} x${i.qty}`));
      kotPrinter.cut();
      await kotPrinter.execute().catch(() => null);
    }
    console.log(`[KOT PIPELINE] Kitchen Ticket #${orderId} processed.`);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true, simulated: true });
  }
});

// Daily Summary Silent Thermal Slip API
app.post('/api/printer/print-daily-summary', async (req, res) => {
  const { summary, dateRange } = req.body;
  try {
    if (ThermalPrinterClass && PrinterTypesObj) {
      const printer = new ThermalPrinterClass({
        type: PrinterTypesObj.EPSON,
        interface: '//localhost/ThermalPrinter',
        characterSet: 'SLOVENIA'
      });
      printer.alignCenter();
      printer.setTextDoubleHeight();
      printer.println("VISHAL FOODIEZ");
      printer.setTextNormal();
      printer.println("DAILY SETTLEMENT REPORT");
      printer.println(`Range: ${dateRange}`);
      printer.drawLine();
      printer.alignLeft();
      printer.println(`Total Orders: ${summary.total_orders}`);
      printer.println(`Gross Turnover: Rs ${summary.total_sales}`);
      printer.println(`Cash Inflow: Rs ${summary.cash_sales}`);
      printer.println(`UPI / Digital: Rs ${summary.upi_sales}`);
      printer.println(`Unpaid Khata (Due): Rs ${summary.due_sales}`);
      printer.println(`Total Expenses: Rs ${summary.total_expense}`);
      printer.drawLine();
      printer.bold(true);
      printer.println(`NET CASH IN HAND: Rs ${summary.net_cash_in_hand}`);
      printer.bold(false);
      printer.drawLine();
      printer.cut();
      await printer.execute().catch(() => null);
    }
    res.json({ success: true });
  } catch(e) {
    res.json({ success: true, simulated: true });
  }
});

// 9. KITCHEN KOT, DIRECTORY & EXPENSES
app.get('/api/kot', (req, res) => {
  db.all(
    `SELECT o.id, o.order_type, o.table_no, TIME(o.created_at, 'localtime') as time 
     FROM orders o WHERE o.status IN ('PENDING', 'RUNNING_TABLE', 'DUE_PENDING') ORDER BY o.id ASC`,
    [],
    async (err, orders) => {
      if (err) return res.status(500).json({ error: err.message });
      const fullOrders = await Promise.all(
        orders.map(order => {
          return new Promise((resolve) => {
            db.all(`SELECT name, qty, notes FROM order_items WHERE order_id = ?`, [order.id], (err2, items) => {
              resolve({ ...order, items: items || [] });
            });
          });
        })
      );
      res.json(fullOrders);
    }
  );
});

app.post('/api/kot/:id/complete', (req, res) => {
  db.get("SELECT payment_mode FROM orders WHERE id = ?", [req.params.id], (err, row) => {
    if (row && row.payment_mode === 'DUE') {
      db.run("UPDATE orders SET status = 'DUE_PENDING' WHERE id = ?", [req.params.id], () => res.json({ success: true }));
    } else {
      db.run("UPDATE orders SET status = 'COMPLETED' WHERE id = ?", [req.params.id], () => res.json({ success: true }));
    }
  });
});

app.get('/api/customers/:phone', (req, res) => {
  db.get("SELECT * FROM customers WHERE phone = ?", [req.params.phone], (err, row) => res.json(row || null));
});

app.get('/api/customers', (req, res) => {
  db.all("SELECT * FROM customers ORDER BY due_balance DESC, total_spent DESC LIMIT 100", [], (err, rows) => res.json(rows || []));
});

app.get('/api/expenses/today', (req, res) => {
  db.all("SELECT id, title, amount, payment_mode, TIME(created_at, 'localtime') as time FROM expenses WHERE DATE(created_at, 'localtime') = DATE('now', 'localtime') ORDER BY id DESC", [], (err, rows) => res.json(rows || []));
});

app.post('/api/expenses', (req, res) => {
  const { title, amount, payment_mode } = req.body;
  db.run("INSERT INTO expenses (title, amount, payment_mode) VALUES (?, ?, ?)", [title, amount, payment_mode || 'CASH'], function () {
    res.json({ success: true, id: this.lastID });
  });
});

// ================= 10. ADVANCED MULTI-DIMENSIONAL REPORTS API =================
app.get('/api/reports/analytics', (req, res) => {
  const { startDate, endDate } = req.query;
  const start = startDate ? startDate : new Date().toISOString().slice(0, 10);
  const end = endDate ? endDate : new Date().toISOString().slice(0, 10);

  // 1. Overall Financial Summary
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
    WHERE DATE(created_at, 'localtime') BETWEEN DATE(?) AND DATE(?) 
      AND status != 'RUNNING_TABLE'
  `;

  // 2. Expenses Query
  const expenseQuery = `
    SELECT 
      COALESCE(SUM(amount), 0) as total_expense,
      COALESCE(SUM(CASE WHEN payment_mode = 'CASH' THEN amount ELSE 0 END), 0) as cash_expense
    FROM expenses 
    WHERE DATE(created_at, 'localtime') BETWEEN DATE(?) AND DATE(?)
  `;

  // 3. Top Selling Items Analytics
  const topItemsQuery = `
    SELECT oi.name, SUM(oi.qty) as total_qty, SUM(oi.price * oi.qty) as total_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE DATE(o.created_at, 'localtime') BETWEEN DATE(?) AND DATE(?) 
      AND o.status != 'RUNNING_TABLE'
    GROUP BY oi.name
    ORDER BY total_qty DESC
    LIMIT 10
  `;

  // 4. Detailed Orders History
  const ordersListQuery = `
    SELECT id, order_type, table_no, customer_name, customer_phone, payment_mode, status, subtotal, discount, gst, total, created_at
    FROM orders 
    WHERE DATE(created_at, 'localtime') BETWEEN DATE(?) AND DATE(?) 
      AND status != 'RUNNING_TABLE'
    ORDER BY id DESC
  `;

  db.get(summaryQuery, [start, end], (err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get(expenseQuery, [start, end], (err2, exp) => {
      summary.total_expense = exp ? exp.total_expense : 0;
      summary.cash_expense = exp ? exp.cash_expense : 0;
      summary.net_cash_in_hand = summary.cash_sales - summary.cash_expense;

      db.all(topItemsQuery, [start, end], (err3, topItems) => {
        db.all(ordersListQuery, [start, end], (err4, ordersList) => {
          res.json({
            summary,
            topItems: topItems || [],
            orders: ordersList || [],
            range: { start, end }
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

app.get('/api/settings', (req, res) => db.get("SELECT * FROM settings WHERE id = 1", [], (err, row) => res.json(row || {})));

app.post('/api/settings', (req, res) => {
  const { restaurant_name, tagline, address, phone, gstin, default_gst, admin_pin } = req.body;
  db.run(`
    INSERT INTO settings (id, restaurant_name, tagline, address, phone, gstin, default_gst, admin_pin)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      restaurant_name = excluded.restaurant_name, tagline = excluded.tagline, address = excluded.address,
      phone = excluded.phone, gstin = excluded.gstin, default_gst = excluded.default_gst, admin_pin = COALESCE(excluded.admin_pin, settings.admin_pin)
  `, [restaurant_name, tagline, address, phone, gstin, default_gst || 5, admin_pin || '1234'], () => res.json({ success: true }));
});

app.get('/api/system/backup', (req, res) => res.download(path.join(__dirname, 'restaurant.db'), `POS_Backup_${new Date().toISOString().slice(0, 10)}.db`));

// Reset daily sales: Due orders and active due balances are preserved
app.post('/api/system/reset-orders', (req, res) => {
  db.serialize(() => {
    db.run(`DELETE FROM order_items WHERE order_id IN (
      SELECT id FROM orders WHERE status = 'COMPLETED' AND payment_mode != 'DUE'
    )`);
    db.run(`DELETE FROM orders WHERE status = 'COMPLETED' AND payment_mode != 'DUE'`);
    db.run("DELETE FROM expenses");
    db.run("DELETE FROM customers WHERE due_balance <= 0");

    console.log("[SAFE RESET] Sales reset completed. Due orders preserved.");
    res.json({ success: true, message: "Settled sales deleted. All Due orders preserved." });
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
