const { Pool } = require('pg');

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

// Create tables and ensure unique index on menu name
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
  // Ensure unique constraint on menu name safely
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS menu_name_idx ON menu (name);`).catch(() => {});
  console.log('Postgres Cloud DB tables ready.');

  // 1. Seed Categories
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

  // 2. Force-Seed All 141 Menu Items without count restriction
  const fullMenuSeeding = [
    ['Butter Jalapeno Garlic Bread', 'Garlic Bread\'s', 199, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/d7dcc67aa96b4fea99107c4c5cc18d58.webp'],
    ['Butter Mushroom Garlic Bread', 'Garlic Bread\'s', 199, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/456d78c4ea2b478d8d6658123fe82504.webp'],
    ['Butter&Cheese Garlic Bread', 'Garlic Bread\'s', 199, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/61e184d2041649bdbd765afa218cab8e.webp'],
    ['Crispy Veggie Finger(8 Piece)', 'New Launch', 109, 50, 'https://cdn.tadkatech.in/menu/vishal_foodiez/Crispy%20Veggie%20Finger%20%288%20Piece%29.webp?v=20260706'],
    ['VF Pizza Puff', 'New Launch', 44, 0, 'https://cdn.tadkatech.in/menu/vishal_foodiez/VF%20Pizza%20Puff.webp?v=20260706'],
    ['VF Pizza Puff(Meal)', 'New Launch', 94, 50, 'https://cdn.tadkatech.in/menu/vishal_foodiez/VF%20Pizza%20Puff%28Meal%29.webp?v=20260706'],
    ['Cheese Corn Roll(4 Rolls)', 'New Launch', 129, 50, 'https://cdn.tadkatech.in/menu/vishal_foodiez/Cheese%20Corn%20Roll%284%20Rolls%29.webp?v=20260706'],
    ['Hara Bhara Kabab(8 Piece)', 'New Launch', 109, 50, 'https://cdn.tadkatech.in/menu/vishal_foodiez/Hara%20Bhara%20Kabab%288%20Piece%29.webp?v=20260706'],
    ['Miraj Potato Chips(Cream And Onion)150 Gram', 'New Launch', 75, 50, 'https://cdn.tadkatech.in/menu/vishal_foodiez/Miraj%20Potato%20Chips%28Cream%20And%20Onion%29150%20Gram.webp?v=20260706'],
    ['Miraj Potato Chips(Mirch Masala)150 Gram', 'New Launch', 75, 50, 'https://cdn.tadkatech.in/menu/vishal_foodiez/Miraj%20Potato%20Chips%28Mirch%20Masala%29150%20Gram.webp?v=20260706'],
    ['Miraj Potato Chips(Plain Salted)150 Gram', 'New Launch', 75, 50, 'https://cdn.tadkatech.in/menu/vishal_foodiez/Miraj%20Potato%20Chips%28Plain%20Salted%29150%20Gram.webp?v=20260706'],
    ['Crispy Veg Burger + Fries + Cold Drink', 'Burger Value Meals', 159, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/159.webp'],
    ['Aloo Tikki Burger + Fries + Cold Drink', 'Burger Value Meals', 139, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/139.webp'],
    ['Paneer Makhani Burger + Fries + Cold Drink', 'Burger Value Meals', 199, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/199.webp'],
    ['Maharaja Veg Burger + Fries + Cold Drink', 'Burger Value Meals', 229, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/229.webp'],
    ['Tandoori Paneer Burger + Fries + Cold Drink', 'Burger Value Meals', 209, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/209.webp'],
    ['Double Decker Veg Burger + Fries + Cold Drink', 'Burger Value Meals', 219, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/219.webp'],
    ['Cheesy Corn Burger + Fries + Cold Drink', 'Burger Value Meals', 179, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/179.webp'],
    ['Mexican Salsa Burger + Fries + Cold Drink', 'Burger Value Meals', 189, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/189.webp'],
    ['Peri Peri Veg Burger + Fries + Cold Drink', 'Burger Value Meals', 169, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/169.webp'],
    ['Veg Supreme Burger + Fries + Cold Drink', 'Burger Value Meals', 199, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/199.webp'],
    ['Mushroom Crunch Burger + Fries + Cold Drink', 'Burger Value Meals', 209, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/209.webp'],
    ['Spicy Veggie Burger + Fries + Cold Drink', 'Burger Value Meals', 179, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/179.webp'],
    ['Loaded Cheese Burger + Fries + Cold Drink', 'Burger Value Meals', 219, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/219.webp'],
    ['Crunchy Aloo Patty Burger + Fries + Cold Drink', 'Burger Value Meals', 149, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/149.webp'],
    ['Smoky BBQ Burger + Fries + Cold Drink', 'Burger Value Meals', 189, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/189.webp'],
    ['Herb Chilli Burger + Fries + Cold Drink', 'Burger Value Meals', 179, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/179.webp'],
    ['Crispy Veg Burger', 'Burgers', 70, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/70.webp'],
    ['Aloo Tikki Burger', 'Burgers', 60, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/60.webp'],
    ['Paneer Makhani Burger', 'Burgers', 110, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/110.webp'],
    ['Maharaja Veg Burger', 'Burgers', 130, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/130.webp'],
    ['Tandoori Paneer Burger', 'Burgers', 120, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/120.webp'],
    ['Double Decker Veg Burger', 'Burgers', 125, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/125.webp'],
    ['Cheesy Corn Burger', 'Burgers', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Mexican Salsa Burger', 'Burgers', 105, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/105.webp'],
    ['Peri Peri Veg Burger', 'Burgers', 85, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/85.webp'],
    ['Veg Supreme Burger', 'Burgers', 115, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/115.webp'],
    ['Mushroom Crunch Burger', 'Burgers', 120, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/120.webp'],
    ['Spicy Veggie Burger', 'Burgers', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Loaded Cheese Burger', 'Burgers', 125, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/125.webp'],
    ['Crunchy Aloo Patty Burger', 'Burgers', 75, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/75.webp'],
    ['Smoky BBQ Burger', 'Burgers', 105, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/105.webp'],
    ['Herb Chilli Burger', 'Burgers', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Classic Veg Burger', 'Burgers', 65, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/65.webp'],
    ['Paneer Tikka Wrap + Fries + Cold Drink', 'Wrap Value Meals', 189, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/189.webp'],
    ['Crispy Veg Wrap + Fries + Cold Drink', 'Wrap Value Meals', 159, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/159.webp'],
    ['Mexican Veg Wrap + Fries + Cold Drink', 'Wrap Value Meals', 169, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/169.webp'],
    ['Cheesy Corn Wrap + Fries + Cold Drink', 'Wrap Value Meals', 179, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/179.webp'],
    ['Spicy Paneer Wrap + Fries + Cold Drink', 'Wrap Value Meals', 199, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/199.webp'],
    ['Tandoori Aloo Wrap + Fries + Cold Drink', 'Wrap Value Meals', 149, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/149.webp'],
    ['Paneer Tikka Wrap', 'Wraps', 110, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/110.webp'],
    ['Crispy Veg Wrap', 'Wraps', 85, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/85.webp'],
    ['Mexican Veg Wrap', 'Wraps', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Cheesy Corn Wrap', 'Wraps', 100, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/100.webp'],
    ['Spicy Paneer Wrap', 'Wraps', 115, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/115.webp'],
    ['Tandoori Aloo Wrap', 'Wraps', 75, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/75.webp'],
    ['Cold Coffee', 'Shakes & Drinks', 80, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/80.webp'],
    ['Chocolate Shake', 'Shakes & Drinks', 90, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/90.webp'],
    ['Oreo Shake', 'Shakes & Drinks', 100, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/100.webp'],
    ['Kitkat Shake', 'Shakes & Drinks', 110, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/110.webp'],
    ['Strawberry Shake', 'Shakes & Drinks', 85, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/85.webp'],
    ['Vanilla Shake', 'Shakes & Drinks', 80, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/80.webp'],
    ['Butterscotch Shake', 'Shakes & Drinks', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Mango Shake', 'Shakes & Drinks', 90, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/90.webp'],
    ['Black Current Shake', 'Shakes & Drinks', 110, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/110.webp'],
    ['Brownie Shake', 'Shakes & Drinks', 120, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/120.webp'],
    ['Cold Coffee with Ice Cream', 'Shakes & Drinks', 100, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/100.webp'],
    ['Pineapple Shake', 'Shakes & Drinks', 85, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/85.webp'],
    ['Banana Caramel Shake', 'Shakes & Drinks', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Hazelnut Coffee', 'Shakes & Drinks', 110, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/110.webp'],
    ['Caramel Cold Coffee', 'Shakes & Drinks', 105, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/105.webp'],
    ['Badam Milk Shake', 'Shakes & Drinks', 90, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/90.webp'],
    ['Rose Milk', 'Shakes & Drinks', 75, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/75.webp'],
    ['Thandai Shake', 'Shakes & Drinks', 100, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/100.webp'],
    ['Papaya Shake', 'Shakes & Drinks', 85, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/85.webp'],
    ['Muskmelon Shake', 'Shakes & Drinks', 85, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/85.webp'],
    ['Pista Shake', 'Shakes & Drinks', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Kiwi Shake', 'Shakes & Drinks', 100, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/100.webp'],
    ['Green Apple Mocktail', 'Mocktails', 90, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/90.webp'],
    ['Blue Lagoon', 'Mocktails', 90, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/90.webp'],
    ['Virgin Mojito', 'Mocktails', 85, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/85.webp'],
    ['Choco Lava Cake', 'Desserts\'', 90, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/90.webp'],
    ['Sizzling Brownie with Ice Cream', 'Desserts\'', 140, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/140.webp'],
    ['Chocolate Walnut Brownie', 'Desserts\'', 80, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/80.webp'],
    ['Classic Salted Fries', 'French Fries', 80, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/80.webp'],
    ['Peri Peri Fries', 'French Fries', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Cheese Loaded Fries', 'French Fries', 130, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/130.webp'],
    ['Veg Spring Roll', 'Spring Roll', 110, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/110.webp'],
    ['Paneer Spring Roll', 'Spring Roll', 130, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/130.webp'],
    ['Vanilla Ice Cream Scoop', 'Ice Cream\'s', 50, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/50.webp'],
    ['Chocolate Ice Cream Scoop', 'Ice Cream\'s', 60, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/60.webp'],
    ['Butterscotch Ice Cream Scoop', 'Ice Cream\'s', 65, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/65.webp'],
    ['Special Veg Burger Combo', 'Limited Time Offers', 199, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/199.webp'],
    ['Family Pizza Feast Offer', 'Limited Time Offers', 499, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/499.webp'],
    ['Steamed Veg Momos (8 Pcs)', 'Momos', 90, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/90.webp'],
    ['Crispy Paneer Fingers (6 Pcs)', 'Paneer Fingers', 150, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/150.webp'],
    ['Spicy Peri Peri Paneer Fingers', 'Paneer Fingers', 165, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/165.webp'],
    ['White Sauce Pasta', 'Pasta', 160, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/160.webp'],
    ['Red Sauce Pasta', 'Pasta', 150, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/150.webp'],
    ['Mixed Sauce Pasta', 'Pasta', 170, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/170.webp'],
    ['Cheese Garlic Pasta', 'Pasta', 180, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/180.webp'],
    ['Mushroom White Sauce Pasta', 'Pasta', 190, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/190.webp'],
    ['Margherita Pizza', 'Pizzas', 140, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/140.webp'],
    ['Farmhouse Special Pizza', 'Pizzas', 220, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/220.webp'],
    ['Paneer Tikka Pizza', 'Pizzas', 240, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/240.webp'],
    ['Corn & Cheese Pizza', 'Pizzas', 180, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/180.webp'],
    ['Veg Supreme Pizza', 'Pizzas', 260, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/260.webp'],
    ['Spicy Mexican Pizza', 'Pizzas', 230, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/230.webp'],
    ['Veg Grilled Sandwich', 'Sandwich', 90, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/90.webp'],
    ['Paneer Tikka Sandwich', 'Sandwich', 120, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/120.webp'],
    ['Corn & Cheese Sandwich', 'Sandwich', 105, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/105.webp'],
    ['Bombay Masala Sandwich', 'Sandwich', 95, 50, 'https://cdn.tadkatech.in/restaurants/vishal_foodiez/menu/95.webp'],
    ['Extra Cheese Add-on', 'Add-ons', 30, 50, ''],
    ['Extra Mayo', 'Add-ons', 15, 50, ''],
    ['Extra Jalapeno', 'Add-ons', 20, 50, ''],
    ['Extra Olives', 'Add-ons', 25, 50, ''],
    ['Extra Paneer Patty', 'Add-ons', 40, 50, ''],
    ['Extra Veg Patty', 'Add-ons', 30, 50, ''],
    ['Extra Mushroom', 'Add-ons', 35, 50, ''],
    ['Extra Sweet Corn', 'Add-ons', 20, 50, ''],
    ['Extra Peri Peri Masala', 'Add-ons', 10, 50, ''],
    ['Extra Schezwan Sauce', 'Add-ons', 15, 50, ''],
    ['Extra Tandoori Mayo', 'Add-ons', 15, 50, ''],
    ['Extra Mint Mayo', 'Add-ons', 15, 50, ''],
    ['Extra Thousand Island', 'Add-ons', 15, 50, ''],
    ['Extra Barbecue Sauce', 'Add-ons', 20, 50, ''],
    ['Extra Honey Mustard', 'Add-ons', 20, 50, ''],
    ['Extra Oregano Seasoning', 'Add-ons', 5, 50, ''],
    ['Extra Chilli Flakes', 'Add-ons', 5, 50, ''],
    ['Extra Tomato Ketchup', 'Add-ons', 5, 50, ''],
    ['Extra Butter', 'Add-ons', 20, 50, ''],
    ['Extra Chocolate Syrup', 'Add-ons', 25, 50, ''],
    ['Extra Caramel Syrup', 'Add-ons', 25, 50, ''],
    ['Extra Vanilla Ice Cream Scoop', 'Add-ons', 35, 50, ''],
    ['Extra Whipped Cream', 'Add-ons', 30, 50, ''],
    ['Whole Wheat Bun', 'Add-ons', 15, 50, ''],
    ['Without Capsicum', 'Add-ons', 0, 50, ''],
    ['Without Mayonnaise', 'Add-ons', 0, 50, ''],
    ['Without Onion', 'Add-ons', 0, 50, ''],
    ['Without Toast', 'Add-ons', 0, 50, '']
  ];

  for (const item of fullMenuSeeding) {
    await pool.query(
      `INSERT INTO menu (name, category, price, stock, image) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category, price = EXCLUDED.price, stock = EXCLUDED.stock, image = EXCLUDED.image`,
      item
    );
  }
  console.log('Force-seeded complete 141 items successfully.');

}).catch(err => {
  console.error('Database initialization error:', err);
});

module.exports = dbWrapper;
