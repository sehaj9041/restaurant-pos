const { Pool } = require('pg');
const path = require('path');

let dbWrapper;

if (!process.env.DATABASE_URL) {
  console.error('[FATAL ERROR]: DATABASE_URL environment variable is missing! Please configure PostgreSQL on Render.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Convert SQLite ? syntax to PostgreSQL $1, $2, ...
function convertSql(sql) {
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

dbWrapper = {
  all: (sql, params, cb) => {
    if (typeof params === 'function') { cb = params; params = []; }
    pool.query(convertSql(sql), params || [])
      .then(res => cb && cb(null, res.rows))
      .catch(err => cb && cb(err));
  },
  get: (sql, params, cb) => {
    if (typeof params === 'function') { cb = params; params = []; }
    pool.query(convertSql(sql), params || [])
      .then(res => cb && cb(null, res.rows[0]))
      .catch(err => cb && cb(err));
  },
  run: function (sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    const isInsert = /insert\s+into/i.test(sql);
    let querySql = convertSql(sql);
    if (isInsert && !/returning/i.test(querySql)) {
      querySql += ' RETURNING id';
    }
    pool.query(querySql, params || [])
      .then(res => {
        const context = {
          lastID: res.rows && res.rows[0] ? res.rows[0].id : null,
          changes: res.rowCount
        };
        if (cb) cb.call(context, null);
      })
      .catch(err => cb && cb(err));
  },
  serialize: (cb) => {
    if (cb) cb();
  }
};

// Create required tables if they don't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS menu (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    price NUMERIC,
    stock INTEGER DEFAULT 50,
    image TEXT,
    variations TEXT,
    assigned_addon_groups TEXT,
    is_exempt INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    order_type TEXT DEFAULT 'Dine-In',
    table_no TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    status TEXT DEFAULT 'COMPLETED',
    payment_mode TEXT,
    subtotal NUMERIC,
    discount NUMERIC DEFAULT 0,
    gst NUMERIC DEFAULT 0,
    total NUMERIC,
    paid_amount NUMERIC DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER,
    name TEXT,
    qty INTEGER,
    price NUMERIC,
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS floor_tables (
    id SERIAL PRIMARY KEY,
    table_no TEXT,
    seats INTEGER,
    x INTEGER,
    y INTEGER
  );
  CREATE TABLE IF NOT EXISTS addon_groups (
    id SERIAL PRIMARY KEY,
    name TEXT,
    min_selection INTEGER,
    max_selection INTEGER,
    is_mandatory INTEGER,
    items TEXT
  );
  CREATE TABLE IF NOT EXISTS variation_masters (
    id SERIAL PRIMARY KEY,
    name TEXT,
    options TEXT
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    title TEXT,
    amount NUMERIC,
    payment_mode TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name TEXT,
    phone TEXT UNIQUE,
    due_balance NUMERIC DEFAULT 0,
    total_spent NUMERIC DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY,
    restaurant_name TEXT,
    tagline TEXT,
    address TEXT,
    phone TEXT,
    gstin TEXT,
    default_gst NUMERIC,
    admin_pin TEXT
  );
`).then(async () => {
  console.log('Postgres Cloud DB tables ready.');
  const res = await pool.query('SELECT COUNT(*) FROM menu');
  if (parseInt(res.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO menu (name, category, price, stock, is_exempt) VALUES
      ('Cold Coffee', 'Beverages', 70, 50, 0),
      ('Crispy Veg Burger', 'Burgers', 80, 50, 0),
      ('Cheese Loaded Pizza', 'Pizzas', 180, 50, 0),
      ('Kurkure Momos', 'Momos', 120, 50, 0);
    `);
    console.log('Initial menu seeded to Cloud DB.');
  }
}).catch(err => {
  console.error('Database initialization error:', err);
});

module.exports = dbWrapper;
