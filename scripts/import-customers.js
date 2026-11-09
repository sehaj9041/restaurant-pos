// One-time: purane software ki customer list (naam, phone) customers table mein daalta hai.
// Dry-run (kuch save nahi hota):  node --env-file=.env scripts/import-customers.js ~/Downloads/customers.csv
// Asli import:                    node --env-file=.env scripts/import-customers.js ~/Downloads/customers.csv --apply
// Jo phone pehle se customers table mein hai uska naam/due/spent nahi badalta (sirf khaali naam bharta hai).
const fs = require('fs');
const { Pool } = require('pg');

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!file || file.startsWith('--')) { console.error('CSV ka path do: node --env-file=.env scripts/import-customers.js <customers.csv> [--apply]'); process.exit(1); }

// name,phone,email — naam quotes mein ho sakta hai (comma ya " ke saath)
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing (node --env-file=.env use karein)'); process.exit(1); }
  const [head, ...data] = parseCsv(fs.readFileSync(file, 'utf8'));
  const iN = head.indexOf('name'), iP = head.indexOf('phone');
  if (iN < 0 || iP < 0) { console.error('CSV mein name aur phone columns chahiye'); process.exit(1); }

  const seen = new Set(), list = [], bad = [];
  for (const r of data) {
    const phone = String(r[iP] || '').replace(/\D/g, '').slice(-10);
    const name = String(r[iN] || '').trim();
    if (!/^[6-9]\d{9}$/.test(phone)) { bad.push(r.join(',')); continue; }
    if (seen.has(phone)) continue;
    seen.add(phone); list.push([name, phone]);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    const existing = new Set((await client.query('SELECT phone FROM customers')).rows.map(r => r.phone));
    const fresh = list.filter(([, p]) => !existing.has(p));
    console.log(`CSV rows: ${data.length}, valid unique: ${list.length}, galat phone: ${bad.length}`);
    console.log(`Pehle se DB mein: ${list.length - fresh.length}, nayi add hongi: ${fresh.length}`);
    if (bad.length) console.log('Galat phone wali rows:', bad.slice(0, 10));
    if (!APPLY) { console.log('\nDRY-RUN (kuch save nahi hua). Sahi lage to --apply ke saath chalayein.'); return; }

    await client.query('BEGIN');
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const vals = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(',');
      await client.query(
        `INSERT INTO customers (name, phone) VALUES ${vals}
         ON CONFLICT (phone) DO UPDATE SET name = COALESCE(NULLIF(customers.name, ''), EXCLUDED.name)`,
        chunk.flat());
    }
    await client.query('COMMIT');
    console.log(`IMPORTED: ${fresh.length} nayi customers add hui, baaki pehle se thi.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED, kuch save nahi hua:', e.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
})();
