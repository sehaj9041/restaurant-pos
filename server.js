const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { exec } = require('child_process');
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

// 2. HARDWARE ZERO-PAPER CASH DRAWER PULSE
const triggerDrawerKick = (req, res) => {
  const psCommand = `powershell -NoProfile -Command "$bytes = [byte[]](0x1B,0x70,0x00,0x19,0xFA); $path = [System.IO.Path]::Combine($env:TEMP, 'kick.bin'); [System.IO.File]::WriteAllBytes($path, $bytes); Get-Content -Path $path -Encoding Byte -Raw | Out-Printer -Name 'Posiflex PP8803 Printer'; Remove-Item $path -ErrorAction SilentlyContinue"`;

  exec(psCommand, (error) => {
    if (error) {
      console.error('[DRAWER ERROR]:', error.message);
      return res.status(500).json({ success: false, message: 'Drawer trigger error', error: error.message });
    }
    console.log('[DRAWER SUCCESS]: Raw pulse sent to Posiflex PP8803 (Zero paper feed)');
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

// 4. GLOBAL ADD-ON GROUPS APIS
app.get('/api/addon-groups', (req, res) => {
  db.all("SELECT * FROM addon_groups ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/addon-groups', (req, res) => {
  const { name, min_selection, max_selection, is_mandatory, items } = req.body;
  db.all(
    `INSERT INTO addon_groups (name, min_selection, max_selection, is_mandatory, items) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [name, min_selection || 0, max_selection || 5, is_mandatory ? 1 : 0, JSON.stringify(items || [])],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const id = result && result[0] ? result[0].id : null;
      res.json({ success: true, id });
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

// 7. ACTIVE ORDERS (RETAINS ALL NON-COMPLETED ORDERS ACROSS WORKFLOW STATES)
app.get('/api/orders/active', (req, res) => {
  const query = `
    SELECT id, order_type, table_no, customer_name, customer_phone, total, subtotal, discount, gst, payment_mode, status, COALESCE(paid_amount, 0) as paid_amount
    FROM orders 
    WHERE status != 'COMPLETED'
       OR order_type = 'Online'
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
});

// ================= DEDICATED DUE (KHATA) APIS FOR DUAL-VIEW =================

// A. Due Orders ("By order" View)
app.get('/api/due/orders', (req, res) => {
  const query = `
    SELECT 
      id, order_type, table_no, customer_name, customer_phone, 
      total, COALESCE(paid_amount, 0) as paid_amount,
      MAX(0, total - COALESCE(paid_amount, 0)) as due_amount,
      payment_mode, status, created_at
    FROM orders
    WHERE status != 'COMPLETED'
      AND (
        UPPER(payment_mode) = 'DUE' 
        OR status = 'DUE_PENDING'
        OR (status = 'KOT_READY' AND UPPER(payment_mode) = 'DUE')
        OR (UPPER(payment_mode) LIKE '%PARTIAL%' AND (total - COALESCE(paid_amount, 0)) > 0)
        OR (UPPER(payment_mode) = 'UNPAID' AND (total - COALESCE(paid_amount, 0)) > 0)
      )
    ORDER BY id DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
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

// B. Due Customers Aggregated ("By customer" View - Direct Synced from customers table)
app.get('/api/due/customers', (req, res) => {
  const query = `
    SELECT 
      COALESCE(NULLIF(c.phone, ''), 'WALK-IN') as phone,
      COALESCE(NULLIF(c.name, ''), 'Valued Guest') as name,
      c.due_balance as total_due,
      COUNT(o.id) as total_orders,
      GROUP_CONCAT(o.id) as order_ids,
      MIN(o.created_at) as oldest_order_date
    FROM customers c
    LEFT JOIN orders o ON o.customer_phone = c.phone AND o.status != 'COMPLETED'
    WHERE c.due_balance > 0
    GROUP BY c.phone
    ORDER BY c.due_balance DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Due customers fetch error:', err.message);
      return res.status(500).json({ error: err.message });
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

// C. One-Click Customer Full Settlement (Settles all pending bills for a single customer)
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
      
      db.run("UPDATE customers SET due_balance = 0 WHERE phone = ?", [phone], () => {
        console.log(`[FULL SETTLEMENT SUCCESS] Customer ${phone} balance cleared via ${mode}`);
        res.json({ success: true, message: `All bills cleared successfully via ${mode}` });
      });
    }
  );
});

// DEDICATED SETTLED ORDER HISTORY API (FOOLPROOF: RELAXED FILTER)
app.get('/api/orders/history', (req, res) => {
  const { date } = req.query;
  const filterDate = date ? date : new Date().toISOString().slice(0, 10);

  const query = `
    SELECT id, order_type, table_no, customer_name, customer_phone, payment_mode, status, subtotal, discount, gst, total, COALESCE(paid_amount, total) as paid_amount, created_at
    FROM orders 
    WHERE status = 'COMPLETED' 
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

// Update Existing Order In-Place
app.put('/api/orders/:id', (req, res) => {
  const orderId = req.params.id;
  const { order_type, table_no, customer_name, customer_phone, items, subtotal, discount, gst, total, payment_mode, paid_amount } = req.body;

  db.get("SELECT total, paid_amount, payment_mode, status FROM orders WHERE id = ?", [orderId], (errGet, currentOrder) => {
    let prevPaid = 0;
    let prevStatus = currentOrder ? currentOrder.status : 'RUNNING_TABLE';

    if (currentOrder) {
      prevPaid = Number(currentOrder.paid_amount) || 0;
      if (prevPaid === 0 && currentOrder.payment_mode && currentOrder.payment_mode !== 'UNPAID' && currentOrder.payment_mode !== 'DUE' && !currentOrder.payment_mode.includes('PARTIAL')) {
        prevPaid = Number(currentOrder.total) || 0;
      }
    }

    let incomingPaid = Number(paid_amount) || 0;
    let finalPaid = Math.max(prevPaid, incomingPaid);
    let finalRemaining = Math.max(0, Number(total) - finalPaid);

    let status = 'RUNNING_TABLE';
    let finalMode = payment_mode;

    if (finalRemaining === 0 && finalPaid > 0) {
      status = 'COMPLETED';
    } else if (finalPaid > 0) {
      status = (prevStatus === 'KOT_READY') ? 'KOT_READY' : 'RUNNING_TABLE';
      finalMode = `PARTIAL (Paid: ₹${finalPaid}, Due: ₹${finalRemaining})`;
    } else if (payment_mode === 'DUE') {
      status = (prevStatus === 'KOT_READY') ? 'KOT_READY' : 'DUE_PENDING';
    }

    db.run(
      `UPDATE orders SET order_type = ?, table_no = ?, customer_name = ?, customer_phone = ?, subtotal = ?, discount = ?, gst = ?, total = ?, payment_mode = ?, status = ?, paid_amount = ? WHERE id = ?`,
      [order_type, table_no || '', customer_name || '', customer_phone || '', subtotal, discount || 0, gst || 0, total, finalMode, status, finalPaid, orderId],
      async (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.run("DELETE FROM order_items WHERE order_id = ?", [orderId], async () => {
          if (Array.isArray(items) && items.length > 0) {
            for (const item of items) {
              await new Promise((resolve) => {
                db.run(
                  "INSERT INTO order_items (order_id, name, qty, price, notes) VALUES (?, ?, ?, ?, ?)",
                  [orderId, item.name, item.qty, item.price, item.notes || ''],
                  () => resolve()
                );
              });
            }
          }
          res.json({ success: true, orderId, paid_amount: finalPaid, payable_now: finalRemaining });
        });
      }
    );
  });
});

// Punch Order: Starts in 'PENDING' so it actively shows on KDS
app.post('/api/orders', async (req, res) => {
  const { order_type, table_no, customer_name, customer_phone, items, payment_mode, subtotal, discount, gst, total, is_hold, paid_amount } = req.body;

  let initialPaid = 0;
  if (payment_mode && payment_mode !== 'UNPAID' && payment_mode !== 'DUE') {
    initialPaid = Number(paid_amount) || Number(total) || 0;
  }

  let status = 'PENDING';
  if (is_hold) {
    status = 'RUNNING_TABLE';
  } else if (payment_mode === 'DUE') {
    status = 'DUE_PENDING';
  }

  const insertOrderQuery = `
    INSERT INTO orders (order_type, table_no, customer_name, customer_phone, status, payment_mode, subtotal, discount, gst, total, paid_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `;

  const orderValues = [
    order_type,
    table_no || '',
    customer_name || '',
    customer_phone || '',
    status,
    payment_mode || 'Cash',
    subtotal || 0,
    discount || 0,
    gst || 0,
    total || 0,
    initialPaid
  ];

  db.all(insertOrderQuery, orderValues, async (err, result) => {
    if (err) {
      console.error('Order creation error:', err.message);
      return res.status(500).json({ error: err.message });
    }

    const orderId = (result && result[0]) ? result[0].id : null;
    if (!orderId) {
      return res.status(500).json({ error: 'Failed to retrieve order id' });
    }

    try {
      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          await new Promise((resolve) => {
            db.run(
              'INSERT INTO order_items (order_id, name, qty, price, notes) VALUES (?, ?, ?, ?, ?)',
              [orderId, item.name, item.qty, item.price, item.notes || ''],
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

      if (customer_phone) {
        const dueIncrement = (payment_mode === 'DUE') ? total : 0;
        await new Promise((resolve) => {
          db.run(
            `INSERT INTO customers (phone, name, total_spent, due_balance, orders_count, last_visit)
             VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (phone) DO UPDATE SET
               name = COALESCE(EXCLUDED.name, customers.name),
               total_spent = customers.total_spent + EXCLUDED.total_spent,
               due_balance = customers.due_balance + ?,
               orders_count = customers.orders_count + 1,
               last_visit = CURRENT_TIMESTAMP`,
            [customer_phone, customer_name || 'Valued Guest', total, dueIncrement, dueIncrement],
            () => resolve()
          );
        });
      }

      res.json({ success: true, orderId: orderId, paid_amount: initialPaid });
    } catch (itemErr) {
      console.error('Order items insert error:', itemErr.message);
      res.json({ success: true, orderId: orderId });
    }
  });
});

// SETTLE ORDER API: FOOLPROOF SETTLEMENT LOGIC
app.post('/api/tables/:id/settle', (req, res) => {
  const { payment_mode } = req.body;
  const orderId = req.params.id;
  const mode = (payment_mode || 'Cash').toUpperCase();

  db.get("SELECT * FROM orders WHERE id = ?", [orderId], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });
    
    const total = Number(order.total) || 0;

    if (order.customer_phone && order.customer_phone.length >= 10) {
      db.run("UPDATE customers SET due_balance = MAX(0, due_balance - ?), total_spent = total_spent + ? WHERE phone = ?", [total, total, order.customer_phone]);
    }

    db.run(
      "UPDATE orders SET status = 'COMPLETED', payment_mode = ?, paid_amount = ? WHERE id = ?",
      [mode, total, orderId],
      (err2) => {
        if (err2) {
          console.error('[SETTLE ERROR]:', err2.message);
          return res.status(500).json({ error: err2.message });
        }
        console.log(`[SUCCESSFULLY SETTLED] Order #${orderId} marked COMPLETED via ${mode}.`);
        res.json({ success: true });
      }
    );
  });
});

// Explicit Mark-Due route for manual queue shifts
app.post('/api/orders/:id/mark-due', (req, res) => {
  const orderId = req.params.id;
  db.get("SELECT total, customer_phone FROM orders WHERE id = ?", [orderId], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });

    if (order.customer_phone && order.customer_phone.length >= 10) {
      db.run("UPDATE customers SET due_balance = due_balance + ? WHERE phone = ?", [order.total, order.customer_phone]);
    }

    db.run(
      "UPDATE orders SET status = 'DUE_PENDING', payment_mode = 'DUE' WHERE id = ?",
      [orderId],
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ success: true });
      }
    );
  });
});

// Clear Customer Due from Directory
app.post('/api/customers/:phone/clear-due', (req, res) => {
  const { amount_paid, payment_mode } = req.body;
  const phone = req.params.phone;
  const mode = (payment_mode || 'CASH').toUpperCase();

  db.get("SELECT due_balance, name FROM customers WHERE phone = ?", [phone], (err, cust) => {
    if (err || !cust) return res.status(404).json({ error: 'Customer not found' });

    const payAmt = Number(amount_paid) || cust.due_balance;
    const newDue = Math.max(0, cust.due_balance - payAmt);

    db.run("UPDATE customers SET due_balance = ? WHERE phone = ?", [newDue, phone], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });

      db.run(
        "UPDATE orders SET status = 'COMPLETED', payment_mode = ?, paid_amount = total WHERE customer_phone = ? AND status != 'COMPLETED'",
        [mode, phone],
        (errOrd) => {
          if (errOrd) console.error('Bulk order complete error:', errOrd.message);
        }
      );

      console.log(`[KHATA CLEAR] Customer ${cust.name} paid Rs ${payAmt} via ${mode}. Remaining Due: Rs ${newDue}`);
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
  const { orderId, orderType, tableNo, customerName, items, total, mode } = req.body;

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

      if (Array.isArray(items)) {
        items.forEach(item => {
          printer.println(`${item.name} x${item.qty} = Rs ${item.price * item.qty}`);
        });
      }

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
      if (Array.isArray(items)) {
        items.forEach(i => kotPrinter.println(`[ ] ${i.name} x${i.qty}`));
      }
      kotPrinter.cut();
      await kotPrinter.execute().catch(() => null);
    }
    console.log(`[KOT PIPELINE] Kitchen Ticket #${orderId} processed.`);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true, simulated: true });
  }
});

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

// 9. KITCHEN KOT API
app.get('/api/kot', (req, res) => {
  db.all(
    `SELECT o.id, o.order_type, o.table_no, o.created_at, TO_CHAR(o.created_at, 'HH12:MI AM') as time 
     FROM orders o 
     WHERE o.status IN ('PENDING', 'RUNNING_TABLE', 'DUE_PENDING', 'RUNNING') 
     ORDER BY o.id ASC`,
    [],
    async (err, orders) => {
      if (err) {
        console.error('KOT error:', err.message);
        return res.json([]);
      }
      if (!orders || orders.length === 0) {
        return res.json([]);
      }
      try {
        const fullOrders = await Promise.all(
          orders.map(order => {
            return new Promise((resolve) => {
              db.all('SELECT id, name, qty, notes FROM order_items WHERE order_id = ? ORDER BY id ASC', [order.id], (err2, items) => {
                resolve({ ...order, items: items || [] });
              });
            });
          })
        );
        res.json(fullOrders);
      } catch (e) {
        res.json(orders.map(o => ({ ...o, items: [] })));
      }
    }
  );
});

// KDS COMPLETE: DISPATCH CLEARS KDS DISPLAY WITHOUT LOSING UNPAID/DUE STATUS!
app.post('/api/kot/:id/complete', (req, res) => {
  const orderId = req.params.id;
  db.get("SELECT total, COALESCE(paid_amount, 0) as paid_amount, payment_mode, status FROM orders WHERE id = ?", [orderId], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });

    const total = Number(order.total) || 0;
    const paid = Number(order.paid_amount) || 0;
    const isFullyPaid = (paid >= total && total > 0);

    if (isFullyPaid) {
      db.run("UPDATE orders SET status = 'COMPLETED' WHERE id = ?", [orderId], () => res.json({ success: true }));
    } else {
      db.run("UPDATE orders SET status = 'KOT_READY' WHERE id = ?", [orderId], () => res.json({ success: true }));
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

// 10. REPORTS ANALYTICS
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
      AND status NOT IN ('RUNNING_TABLE', 'KOT_READY')
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
      AND o.status NOT IN ('RUNNING_TABLE', 'KOT_READY')
    GROUP BY oi.name
    ORDER BY total_qty DESC
    LIMIT 10
  `;

  const ordersListQuery = `
    SELECT id, order_type, table_no, customer_name, customer_phone, payment_mode, status, subtotal, discount, gst, total, COALESCE(paid_amount, total) as paid_amount, created_at
    FROM orders 
    WHERE (created_at::date BETWEEN ?::date AND ?::date OR DATE(created_at) BETWEEN DATE(?) AND DATE(?))
      AND status NOT IN ('RUNNING_TABLE', 'KOT_READY')
    ORDER BY id DESC
  `;

  db.get(summaryQuery, [start, end, start, end], (err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
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

app.post('/api/system/reset-orders', (req, res) => {
  db.run(`DELETE FROM order_items WHERE order_id IN (
    SELECT id FROM orders WHERE status = 'COMPLETED' AND payment_mode != 'DUE'
  )`, [], () => {
    db.run(`DELETE FROM orders WHERE status = 'COMPLETED' AND payment_mode != 'DUE'`, [], () => {
      db.run("DELETE FROM expenses", [], () => {
        db.run("DELETE FROM customers WHERE due_balance <= 0", [], () => {
          console.log("[SAFE RESET] Sales reset completed. Due orders preserved.");
          res.json({ success: true, message: "Settled sales deleted. All Due orders preserved." });
        });
      });
    });
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
