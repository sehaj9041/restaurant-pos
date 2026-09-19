const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

let dbWrapper;

if (process.env.DATABASE_URL) {
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
      status TEXT DEFAULT 'COMPLETED',
      payment_mode TEXT,
      total NUMERIC,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER,
      name TEXT,
      qty INTEGER,
      price NUMERIC
    );
  `).then(async () => {
    console.log('Postgres Cloud DB tables ready.');
    // Check if menu is empty, then seed initial items
    const res = await pool.query('SELECT COUNT(*) FROM menu');
    if (parseInt(res.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO menu (name, category, price, stock, is_exempt) VALUES
        ('Cold Coffee', 'Beverages', 70, 50, 0),
        ('Crispy Veg Burger', 'Burgers', 80, 50, 0),
        ('Cheese Loaded Pizza', 'Pizza', 180, 50, 0),
        ('Kurkure Momos', 'Snacks', 120, 50, 0);
      `);
      console.log('Initial menu seeded to Cloud DB.');
    }
  }).catch(err => {
    console.error('Database initialization error:', err);
  });

} else {
  // Local SQLite fallback
  const db = new sqlite3.Database(path.join(__dirname, 'restaurant.db'));
  dbWrapper = db;
}

module.exports = dbWrapper;
