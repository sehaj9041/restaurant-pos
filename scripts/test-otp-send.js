// Sends ONE otp_login template message exactly like the server does, so you can see Meta's raw answer.
// Run:  node scripts/test-otp-send.js   (asks for token and the receiver number; nothing is stored)
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

(async () => {
  const token = await ask('Permanent token (paste karke Enter): ');
  const phoneId = (await ask('Phone number ID [1392683397265236]: ')) || '1392683397265236';
  const to = (await ask('Receiver ka 10 digit number (jisme WhatsApp chalu ho, WhatsApp Business wala nahi): ')).replace(/\D/g, '').slice(-10);
  const tpl = (await ask('Template naam [otp_login]: ')) || 'otp_login';
  rl.close();
  if (!token || to.length !== 10) { console.error('Token aur 10 digit number chahiye.'); process.exit(1); }
  const code = '123456';
  const r = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: '91' + to, type: 'template', template: { name: tpl, language: { code: 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] } })
  });
  console.log('\nMeta ka jawab (' + r.status + '):', await r.text());
})();
