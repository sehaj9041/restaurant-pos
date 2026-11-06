// One-time: registers the WhatsApp number with the Cloud API (fixes error 133010 "Account not registered").
// Run:  node scripts/register-whatsapp.js   (asks for token, phone number ID and a 6-digit PIN; nothing is stored)
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

(async () => {
  const token = await ask('Permanent token (paste karke Enter): ');
  const phoneId = (await ask('Phone number ID [1392683397265236]: ')) || '1392683397265236';
  const pin = await ask('Apna 6-digit PIN chuno (yaad rakhna): ');
  rl.close();
  if (!token || !/^\d{6}$/.test(pin)) { console.error('Token chahiye aur PIN 6 digit ka hona chahiye.'); process.exit(1); }
  const r = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/register`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin })
  });
  console.log('\nMeta ka jawab (' + r.status + '):', await r.text());
})();
