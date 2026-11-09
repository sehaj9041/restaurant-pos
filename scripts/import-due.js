// One-time: purane software (TadkaTech) ka customer-wise due yahan opening-balance DUE order ke roop mein daalta hai.
// Dry-run (kuch save nahi hota):  node --env-file=.env scripts/import-due.js
// Asli import:                    node --env-file=.env scripts/import-due.js --apply
// Dobara chalane par jo customers pehle import ho chuke hain wo skip ho jaate hain.
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const ITEM_NAME = 'Opening Balance (purana software)';

// [naam, phone, due ₹, oldest (din), orders]. Source: purane software ke Due → By customer ke screenshots.
const DUES = [
  ['gautam nannu', '6280434690', 1504, 113, 11],
  ['golu', '8526480000', 678, 101, 5],
  ['vishal pappu ala', '8000002966', 939, 100, 2],
  ['7986322899', '7986322899', 6, 95, 1],
  ['Deepika', '6280806061', 3, 89, 1],
  ['7009463248', '7009463248', 16, 87, 1],
  ['amit dhingra', '7770000701', 250, 87, 1],
  ['Kushika Sardana', '8360952849', 3, 79, 1],
  ['mohit sharma electrician', '8699297113', 716, 78, 2],
  ['goldy garments', '9815517133', 3, 73, 1],
  ['darpan', '9815101940', 394, 72, 2],
  ['sinni', '9646707185', 560, 59, 1],
  ['7347460159', '7347460159', 10, 55, 2],
  ['kamal electronics', '9872596345', 1104, 55, 3],
  ['Rohit', '9781193139', 16, 43, 1],
  ['popy', '8000001955', 434, 41, 1],
  ['happy dhingra', '9501609996', 208, 34, 1],
  ['Gurpeet singh', '9700230008', 7, 31, 1],
  ['Tarunveer singh', '7986471041', 4, 30, 1],
  ['neetu ji', '9417462084', 229, 10, 1],
  ['9807941000', '9807941000', 18, 9, 1],
  ['ashu', '9501636246', 678, 8, 1],
  ['Shilu Khan', '9056225314', 771, 8, 2],
  ['akash shop', '7743057459', 407, 7, 2],
  ['gagan shop', '6283815989', 441, 2, 2],
  ['krishna', '8872622982', 322, 0, 1]
];

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing (node --env-file=.env use karein)'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let created = 0, skipped = 0, total = 0;
  try {
    await client.query("SET TIME ZONE 'Asia/Kolkata'");
    await client.query('BEGIN');
    for (const [name, phone, due, days, orders] of DUES) {
      const dup = await client.query(
        `SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE o.customer_phone = $1 AND oi.name = $2 LIMIT 1`, [phone, ITEM_NAME]);
      if (dup.rows.length) { skipped++; console.log(`SKIP  ${name} (${phone}) - pehle se import hai (order #${dup.rows[0].id})`); continue; }
      // 0 din = aaj ka (krishna, screenshot mein "Oldest · 8h"), baaki din ke hisaab se purane
      const ago = days === 0 ? '8 hours' : `${days} days`;
      console.log(`${APPLY ? 'ADD ' : 'WOULD'}  ${name.padEnd(26)} ${phone}  ₹${String(due).padStart(5)}  ${ago} purana`);
      created++; total += due;
      if (!APPLY) continue;
      const ins = await client.query(
        `INSERT INTO orders (order_type, customer_name, customer_phone, status, payment_mode, subtotal, discount, gst, total, paid_amount, source, created_at, token_no)
         VALUES ('Takeaway', $1, $2, 'DUE_PENDING', 'DUE', $3, 0, 0, $3, 0, 'DUE_IMPORT', NOW() - $4::interval,
           COALESCE((SELECT MAX(token_no) FROM orders WHERE created_at::date = (NOW() - $4::interval)::date), 0) + 1)
         RETURNING id`, [name, phone, due, ago]);
      await client.query(`INSERT INTO order_items (order_id, name, qty, price, notes) VALUES ($1, $2, 1, $3, $4)`,
        [ins.rows[0].id, ITEM_NAME, due, `Purane software ke ${orders} order(s) ka baaki due`]);
    }
    if (APPLY) { await client.query('COMMIT'); } else { await client.query('ROLLBACK'); }
    console.log(`\n${APPLY ? 'IMPORTED' : 'DRY-RUN (kuch save nahi hua)'}: ${created} customers, total ₹${total}, ${skipped} skip`);
    if (!APPLY) console.log('Sahi lage to --apply ke saath chalayein.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED, kuch save nahi hua:', e.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
})();
