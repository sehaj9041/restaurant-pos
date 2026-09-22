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

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ imageUrl: '/uploads/' + req.file.filename });
});

app.post('/api/display/sync', (req, res) => {
  liveCustomerCart = req.body;
  res.json({ success: true });
});

app.get('/api/display/current', (req, res) => {
  res.json(liveCustomerCart);
});

const triggerDrawerKick = (req, res) => {
  const psCommand = `powershell -NoProfile -Command "$bytes = [byte[]](0x1B,0x70,0x00,0x19,0xFA); $path = [System.IO.Path]::Combine($env:TEMP, 'kick.bin'); [System.IO.File]::WriteAllBytes($path, $bytes); Get-Content -Path $path -Encoding Byte -Raw | Out-Printer -Name 'Posiflex PP8803 Printer'; Remove-Item $path -ErrorAction SilentlyContinue"`;

  exec(psCommand, (error) => {
    if (error) {
      console.error('[DRAWER ERROR]:', error.message);
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

app.get('/api/menu', (req, res) => {
  db.all("SELECT * FROM menu ORDER BY category, name", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/orders/active', (req, res) => {
  const query = `
    SELECT id, order_type, table_no, customer_name, customer_phone, total, subtotal, discount, gst, payment_mode, status, COALESCE(paid_amount, 0) as paid_amount
    FROM orders 
    WHERE status IN ('RUNNING_TABLE', 'PENDING', 'DUE_PENDING', 'RUNNING', 'KITCHEN_ACTIVE') 
       OR order_type = 'Online' 
       OR payment_mode = 'Due'
    ORDER BY id DESC
  `;

  db.all(query, [], async (err, orders) => {
    if (err) return res.status(500).json({ error: err.message });
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

app.put('/api/orders/:id', (req, res) => {
  const orderId = req.params.id;
  const { order_type, table_no, customer_name, customer_phone, items, subtotal, discount, gst, total, payment_mode, paid_amount } = req.body;

  db.get("SELECT total, paid_amount, payment_mode FROM orders WHERE id = ?", [orderId], (errGet, currentOrder) => {
    let prevPaid = 0;
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
      status = 'KITCHEN_ACTIVE';
    } else if (finalPaid > 0) {
      status = 'RUNNING_TABLE';
      finalMode = `PARTIAL (Paid: ₹${finalPaid}, Due: ₹${finalRemaining})`;
    } else if (payment_mode === 'DUE') {
      status = 'DUE_PENDING';
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
  } else if (initialPaid >= Number(total) && Number(total) > 0) {
    status = 'KITCHEN_ACTIVE';
  }

  const insertOrderQuery = `
    INSERT INTO orders (order_type, table_no, customer_name, customer_phone, status, payment_mode, subtotal, discount, gst, total, paid_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `;

  db.all(insertOrderQuery, [order_type, table_no || '', customer_name || '', customer_phone || '', status, payment_mode || 'Cash', subtotal || 0, discount || 0, gst || 0, total || 0, initialPaid], async (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    const orderId = (result && result[0]) ? result[0].id : null;

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
        }
      }
      res.json({ success: true, orderId: orderId, paid_amount: initialPaid });
    } catch (itemErr) {
      res.json({ success: true, orderId: orderId });
    }
  });
});

app.post('/api/tables/:id/settle', (req, res) => {
  const { payment_mode } = req.body;
  db.get("SELECT * FROM orders WHERE id = ?", [req.params.id], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });
    
    if (payment_mode === 'DUE') {
      db.run("UPDATE orders SET status = 'DUE_PENDING', payment_mode = 'DUE' WHERE id = ?", [req.params.id], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ success: true, duePending: true });
      });
    } else {
      db.run("UPDATE orders SET status = 'KITCHEN_ACTIVE', payment_mode = ?, paid_amount = total WHERE id = ?", [payment_mode, req.params.id], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ success: true });
      });
    }
  });
});

app.get('/api/kot', (req, res) => {
  db.all(
    `SELECT o.id, o.order_type, o.table_no, time(o.created_at, 'localtime') as time 
     FROM orders o 
     WHERE o.status IN ('PENDING', 'RUNNING_TABLE', 'DUE_PENDING', 'RUNNING', 'KITCHEN_ACTIVE') 
     ORDER BY o.id ASC`,
    [],
    async (err, orders) => {
      if (err) return res.json([]);
      if (!orders || orders.length === 0) return res.json([]);
      try {
        const fullOrders = await Promise.all(
          orders.map(order => {
            return new Promise((resolve) => {
              db.all('SELECT name, qty, notes FROM order_items WHERE order_id = ?', [order.id], (err2, items) => {
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

app.post('/api/kot/:id/complete', (req, res) => {
  db.get("SELECT payment_mode, status FROM orders WHERE id = ?", [req.params.id], (err, row) => {
    if (row && (row.payment_mode === 'DUE' || row.status === 'DUE_PENDING')) {
      db.run("UPDATE orders SET status = 'DUE_PENDING' WHERE id = ?", [req.params.id], () => res.json({ success: true }));
    } else {
      db.run("UPDATE orders SET status = 'COMPLETED' WHERE id = ?", [req.params.id], () => res.json({ success: true }));
    }
  });
});

app.get('/api/customers/:phone', (req, res) => {
  db.get("SELECT * FROM customers WHERE phone = ?", [req.params.phone], (err, row) => res.json(row || null));
});

app.get('/api/expenses/today', (req, res) => {
  db.all("SELECT id, title, amount, payment_mode, time(created_at, 'localtime') as time FROM expenses WHERE date(created_at) = date('now') ORDER BY id DESC", [], (err, rows) => res.json(rows || []));
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

// ENHANCED ANALYTICS & HISTORY API WITH FULL ITEMS EMBEDDED
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
    WHERE date(created_at) BETWEEN date(?) AND date(?) 
      AND status != 'RUNNING_TABLE'
  `;

  const expenseQuery = `
    SELECT 
      COALESCE(SUM(amount), 0) as total_expense,
      COALESCE(SUM(CASE WHEN payment_mode = 'CASH' THEN amount ELSE 0 END), 0) as cash_expense
    FROM expenses 
    WHERE date(created_at) BETWEEN date(?) AND date(?)
  `;

  const topItemsQuery = `
    SELECT oi.name, SUM(oi.qty) as total_qty, SUM(oi.price * oi.qty) as total_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE date(o.created_at) BETWEEN date(?) AND date(?) 
      AND o.status != 'RUNNING_TABLE'
    GROUP BY oi.name
    ORDER BY total_qty DESC
    LIMIT 10
  `;

  const ordersListQuery = `
    SELECT id, order_type, table_no, customer_name, customer_phone, payment_mode, status, subtotal, discount, gst, total, paid_amount, created_at
    FROM orders 
    WHERE date(created_at) BETWEEN date(?) AND date(?) 
      AND status != 'RUNNING_TABLE'
    ORDER BY id DESC
  `;

  db.get(summaryQuery, [start, end], (err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get(expenseQuery, [start, end], (err2, exp) => {
      const summaryData = summary || {};
      summaryData.total_expense = exp ? exp.total_expense : 0;
      summaryData.cash_expense = exp ? exp.cash_expense : 0;
      summaryData.net_cash_in_hand = (summaryData.cash_sales || 0) - (summaryData.cash_expense || 0);

      db.all(topItemsQuery, [start, end], async (err3, topItems) => {
        db.all(ordersListQuery, [start, end], async (err4, ordersList) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
