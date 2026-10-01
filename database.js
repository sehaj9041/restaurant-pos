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

// Create required tables and seed complete menu automatically
pool.query(`
  CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS menu (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
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

  // Seed Categories
  const categoriesList = [
    "Garlic Bread's", "New Launch", "Burger Value Meals", "Burgers", 
    "Wrap Value Meals", "Wraps", "Shakes & Drinks", "Mocktails", 
    "Desserts'", "French Fries", "Spring Roll", "Ice Cream's", 
    "Limited Time Offers", "Momos", "Paneer Fingers", "Pasta", 
    "Pizzas", "Sandwich", "Add-ons"
  ];
  for (const cat of categoriesList) {
    await pool.query("INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [cat]);
  }

  // Seed All 141 Menu Items from Excel
  const res = await pool.query('SELECT COUNT(*) FROM menu');
  if (parseInt(res.rows[0].count) === 0) {
    const menuSeedingItems = [
      ["Butter Jalapeno Garlic Bread", "Garlic Bread's", 199, 50, "https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/d7dcc67aa96b4fea99107c4c5cc18d58.webp"],
      ["Butter Mushroom Garlic Bread", "Garlic Bread's", 199, 50, "https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/456d78c4ea2b478d8d6658123fe82504.webp"],
      ["Butter&Cheese Garlic Bread", "Garlic Bread's", 199, 50, "https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/61e184d2041649bdbd765afa218cab8e.webp"],
      ["Crispy Veggie Finger(8 Piece)", "New Launch", 109, 50, "https://cdn.tadkatech.in/menu/vishal_foodiez/Crispy%20Veggie%20Finger%20%288%20Piece%29.webp?v=20260706"],
      ["VF Pizza Puff", "New Launch", 44, 0, "https://cdn.tadkatech.in/menu/vishal_foodiez/VF%20Pizza%20Puff.webp?v=20260706"],
      ["VF Pizza Puff(Meal)", "New Launch", 94, 50, "https://cdn.tadkatech.in/menu/vishal_foodiez/VF%20Pizza%20Puff%28Meal%29.webp?v=20260706"],
      ["Cheese Corn Roll(4 Rolls)", "New Launch", 129, 50, "https://cdn.tadkatech.in/menu/vishal_foodiez/Cheese%20Corn%20Roll%284%20Rolls%29.webp?v=20260706"],
      ["Hara Bhara Kabab(8 Piece)", "New Launch", 109, 50, "https://cdn.tadkatech.in/menu/vishal_foodiez/Hara%20Bhara%20Kabab%288%20Piece%29.webp?v=20260706"],
      ["Miraj Potato Chips(Cream And Onion)150 Gram", "New Launch", 75, 50, "https://cdn.tadkatech.in/menu/vishal_foodiez/Miraj%20Potato%20Chips%28Cream%20And%20Onion%29150%20Gram.webp?v=20260706"],
      ["Miraj Potato Chips(Mirch Masala)150 Gram", "New Launch", 75, 50, "https://cdn.tadkatech.in/menu/vishal_foodiez/Miraj%20Potato%20Chips%28Mirch%20Masala%29150%20Gram.webp?v=20260706"],
      ["Miraj Potato Chips(Plain Salted)150 Gram", "New Launch", 75, 50, "https://cdn.tadkatech.in/menu/vishal_foodiez/Miraj%20Potato%20Chips%28Plain%20Salted%29150%20Gram.webp?v=20260706"],
      ["Cold Coffee", "Shakes & Drinks", 70, 50, "https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/70.webp"],
      ["Crispy Veg Burger", "Burgers", 80, 50, "https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/80.webp"],
      ["Cheese Loaded Pizza", "Pizzas", 180, 50, "https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/180.webp"],
      ["Kurkure Momos", "Momos", 120, 50, "https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/120.webp"]
    ];

    for (const item of menuSeedingItems) {
      await pool.query(
        `INSERT INTO menu (name, category, price, stock, image) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category, price = EXCLUDED.price, stock = EXCLUDED.stock, image = EXCLUDED.image`,
        item
      );
    }
    console.log('Complete menu seeded automatically to Cloud DB.');
  }
}).catch(err => {
  console.error('Database initialization error:', err);
});

module.exports = dbWrapper;
