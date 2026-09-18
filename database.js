const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./restaurant.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT,
    price REAL NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_type TEXT DEFAULT 'Dine-In',
    status TEXT DEFAULT 'COMPLETED',
    payment_mode TEXT,
    total REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    name TEXT,
    qty INTEGER,
    price REAL,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  )`);
  db.run(`ALTER TABLE menu ADD COLUMN is_exempt INTEGER DEFAULT 0`, (err) => {
    // Agar column pehle se maujood hai toh error silently ignore ho jayega
  });

  db.get("SELECT COUNT(*) AS count FROM menu", (err, row) => {
    if (row && row.count === 0) {
      const stmt = db.prepare("INSERT INTO menu (name, category, price) VALUES (?, ?, ?)");
      stmt.run("Crispy Veg Burger", "Burgers", 80);
      stmt.run("Cheese Loaded Pizza", "Pizza", 180);
      stmt.run("Kurkure Momos", "Snacks", 120);
      stmt.run("Cold Coffee", "Beverages", 70);
      stmt.finalize();
    }
  });
});

module.exports = db;
