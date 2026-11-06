// One-time: subscribes this Meta app to the WhatsApp Business Account so the app may send messages for it (fixes error code 10 / subcode 2593181).
// Run:  node scripts/subscribe-whatsapp.js   (asks for the token; nothing is stored)
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

(async () => {
  const token = await ask('Permanent token (paste karke Enter): ');
  const waba = (await ask('WhatsApp account ID [845846921552925]: ')) || '845846921552925';
  rl.close();
  if (!token) { console.error('Token chahiye.'); process.exit(1); }
  const url = `https://graph.facebook.com/v25.0/${waba}/subscribed_apps`;
  const h = { Authorization: 'Bearer ' + token };
  const r = await fetch(url, { method: 'POST', headers: h });
  console.log('\nSubscribe ka jawab (' + r.status + '):', await r.text());
  const l = await fetch(url, { headers: h });
  console.log('Ab subscribed apps (' + l.status + '):', await l.text());
})();
