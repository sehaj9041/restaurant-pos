// Shared staff login (username + password) for the POS, kitchen display, kiosk, punch page and every staff/admin page + API.
// Customers (website, table QR, rider links, payment webhooks) stay open: see PUBLIC_API below.
// - First time (no credentials yet): /login shows a setup form that needs the Owner PIN. Env STAFF_USERNAME + STAFF_PASSWORD can seed it instead.
// - Browser/tablet logs in once; a signed HttpOnly cookie stays (renewed on use) until someone logs out. HTTP Basic auth also works for non-browser clients.
// - Changing the password (Owner PIN needed) rotates the signing secret, so every device has to log in again.
const crypto = require('crypto');

const COOKIE = 'pos_auth';
const SESSION_MS = 400 * 24 * 60 * 60 * 1000; // max cookie lifetime browsers allow; renewed on use, so a device stays logged in until someone logs out

// Pages that need the staff login (everything else in public/ is customer-facing or a harmless asset)
const PROTECTED_PAGES = /^\/(pos|index\.html|kitchen\.html|kiosk\.html|punch\.html|staff\.html|admin\.html|settings\.html|customers\.html|engagement\.html|table-qrs\.html|customer\.html|settings,html\.txt|index\.html\/customer)$/i;

// /api routes that must work without a login (customer ordering, rider links, payment callbacks, login itself). Matched on req.path under /api.
const PUBLIC_API = [
  ['GET', /^\/(menu|categories|addon-groups|upsells|kiosk-suggestions|store-status|settings\/config|loyalty-info|my-orders)$/],
  ['GET', /^\/track\/[^/]+$/],
  ['GET', /^\/feedback\/(qr|order)\/[^/]+$/],
  ['GET', /^\/app\/qr$/],            // bill QR: app download link
  ['POST', /^\/(delivery-charge|orders|coupons\/validate|loyalty\/my|loyalty\/code|otp\/send|otp\/verify|feedback)$/],
  ['ALL', /^\/razorpay\//],
  ['ALL', /^\/table-qr\//],            // table-qr-admin is a different prefix and stays protected
  ['ALL', /^\/rider\/[^/]+\//],        // rider links carry their own token
  ['ALL', /^\/(upi\/(collect|status\/[^/]+|cancel|rider-paid|web-config|web-create)|paytm\/callback)$/],
  ['ALL', /^\/print\/(pending-queue|acknowledge)$/], // printer agent on the kitchen PC has no login (add one later if needed)
  ['ALL', /^\/staff-auth\//]
];

function register(app, { db, checkOwnerPin }) {
  const dbAll = (sql, params) => new Promise((resolve, reject) => db.all(sql, params || [], (e, r) => (e ? reject(e) : resolve(r || []))));

  let cfgPromise = null;
  const loadCfg = () => (cfgPromise = cfgPromise || (async () => {
    await dbAll(`CREATE TABLE IF NOT EXISTS staff_auth (id INTEGER PRIMARY KEY, username TEXT, pass_hash TEXT, salt TEXT, secret TEXT)`);
    let row = (await dbAll('SELECT * FROM staff_auth WHERE id = 1'))[0];
    if (!row && process.env.STAFF_USERNAME && process.env.STAFF_PASSWORD) {
      row = await saveCreds(process.env.STAFF_USERNAME, process.env.STAFF_PASSWORD);
      console.log('[AUTH] Staff login STAFF_USERNAME / STAFF_PASSWORD env se set hua.');
    }
    if (!row) console.warn('[AUTH] Staff login abhi set nahi hai. /login kholkar Owner PIN se username/password set karein (jab tak set nahi, staff pages band rahenge).');
    return row || null;
  })().catch((e) => { cfgPromise = null; throw e; }));

  const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
  async function saveCreds(username, password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const row = { username: String(username).trim(), pass_hash: hashPw(password, salt), salt, secret: crypto.randomBytes(32).toString('hex') };
    await dbAll(
      `INSERT INTO staff_auth (id, username, pass_hash, salt, secret) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, pass_hash = excluded.pass_hash, salt = excluded.salt, secret = excluded.secret RETURNING id`,
      [row.username, row.pass_hash, row.salt, row.secret]);
    cfgPromise = Promise.resolve(row);
    return row;
  }
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const passwordOk = (cfg, user, pw) => !!cfg && safeEq(String(user || '').trim().toLowerCase(), cfg.username.toLowerCase()) && safeEq(hashPw(pw || '', cfg.salt), cfg.pass_hash);

  const sign = (cfg, exp) => `${exp}.${crypto.createHmac('sha256', cfg.secret).update(String(exp)).digest('hex')}`;
  const tokenOk = (cfg, tok) => {
    const [exp, mac] = String(tok || '').split('.');
    return !!cfg && /^\d+$/.test(exp || '') && Number(exp) > Date.now() && !!mac && safeEq(tok, sign(cfg, exp));
  };
  const getCookie = (req, name) => { const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '=')); return m ? decodeURIComponent(m.slice(name.length + 1)) : ''; };
  const isHttps = (req) => req.secure || /https/i.test(req.get('x-forwarded-proto') || '');
  const setSession = (req, res, cfg) => {
    const exp = Date.now() + SESSION_MS;
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(cfg, exp))}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
  };

  // sliding session: re-issue the cookie once it has less than ~300 days left
  async function renew(req, res) {
    const cfg = await loadCfg(), tok = getCookie(req, COOKIE);
    if (tokenOk(cfg, tok) && Number(tok.split('.')[0]) - Date.now() < SESSION_MS * 0.75) setSession(req, res, cfg);
  }

  async function isAuthed(req) {
    const cfg = await loadCfg();
    if (!cfg) return false;
    if (tokenOk(cfg, getCookie(req, COOKIE))) return true;
    const m = /^Basic\s+(.+)$/i.exec(req.get('authorization') || '');
    if (m) {
      const s = Buffer.from(m[1], 'base64').toString('utf8'), i = s.indexOf(':');
      if (i > 0 && !blocked(req)) { const ok = passwordOk(cfg, s.slice(0, i), s.slice(i + 1)); if (!ok) failed(req); return ok; }
    }
    return false;
  }

  // brute-force guard (per IP)
  const fails = new Map(); const MAX = 10, WINDOW = 15 * 60 * 1000;
  const ipOf = (req) => { const x = (req.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean); return x.length ? x[x.length - 1] : req.socket.remoteAddress; };
  const blocked = (req) => { const f = fails.get(ipOf(req)); return !!f && f.n >= MAX && Date.now() - f.t < WINDOW; };
  const failed = (req) => { const ip = ipOf(req), f = fails.get(ip); fails.set(ip, (!f || Date.now() - f.t >= WINDOW) ? { n: 1, t: Date.now() } : { n: f.n + 1, t: f.t }); };
  setInterval(() => { const now = Date.now(); fails.forEach((f, ip) => { if (now - f.t >= WINDOW) fails.delete(ip); }); }, WINDOW).unref();

  const safeNext = (n) => (typeof n === 'string' && /^\/[A-Za-z0-9_\-./,]*(\?[A-Za-z0-9_\-.,=&%]*)?$/.test(n) && !n.startsWith('//') && !/^\/(login|logout)/.test(n)) ? n : '/pos';

  // ---- gate (installed before static files and all routes) ----
  app.use(async (req, res, next) => {
    try {
      const isApi = req.path.startsWith('/api/');
      if (isApi) {
        if (req.method === 'OPTIONS') return next();
        const p = req.path.slice(4);
        if (PUBLIC_API.some(([m, re]) => (m === 'ALL' || m === req.method || (m === 'GET' && req.method === 'HEAD')) && re.test(p))) return next();
        if (await isAuthed(req)) { await renew(req, res); return next(); }
        return res.status(401).json({ error: 'Login required', login: true });
      }
      let decoded = req.path; try { decoded = decodeURIComponent(req.path); } catch (e) { /* keep raw */ }
      if ((req.method === 'GET' || req.method === 'HEAD') && PROTECTED_PAGES.test(decoded)) {
        if (await isAuthed(req)) { await renew(req, res); res.setHeader('Cache-Control', 'no-store'); return next(); }
        return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
      }
      next();
    } catch (e) { console.error('[AUTH] gate error:', e.message); res.status(500).json({ error: 'Auth error' }); }
  });

  // ---- login / logout / credentials ----
  app.get('/login', async (req, res) => {
    const cfg = await loadCfg().catch(() => null);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(loginPage(!cfg, safeNext(req.query.next)));
  });
  app.post('/api/staff-auth/login', async (req, res) => {
    if (blocked(req)) return res.status(429).json({ error: 'Bahut galat koshish. 15 minute baad try karein.' });
    const cfg = await loadCfg();
    if (!cfg) return res.status(409).json({ error: 'Pehle username/password set karein.', setup: true });
    const { username, password } = req.body || {};
    if (!passwordOk(cfg, username, password)) { failed(req); return res.status(401).json({ error: 'Username ya password galat hai.' }); }
    fails.delete(ipOf(req));
    setSession(req, res, cfg);
    res.json({ success: true });
  });
  // first-time setup or password change: Owner PIN required
  app.post('/api/staff-auth/credentials', (req, res) => {
    if (blocked(req)) return res.status(429).json({ error: 'Bahut galat koshish. 15 minute baad try karein.' });
    const { pin, username, password } = req.body || {};
    checkOwnerPin(pin, async (ok) => {
      if (!ok) { failed(req); return res.status(401).json({ error: 'Owner PIN galat hai.' }); }
      if (!String(username || '').trim() || String(password || '').length < 8) return res.status(400).json({ error: 'Username daalein aur password kam se kam 8 characters ka rakhein.' });
      try { const cfg = await saveCreds(username, password); setSession(req, res, cfg); res.json({ success: true }); }
      catch (e) { console.error('[AUTH] save error:', e.message); res.status(500).json({ error: 'Save nahi hua' }); }
    });
  });
  const logout = (req, res) => { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`); res.redirect('/login'); };
  app.get('/logout', logout);
  app.post('/api/staff-auth/logout', (req, res) => { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`); res.json({ success: true }); });
}

function loginPage(needsSetup, next) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Staff Login</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111827;font-family:system-ui,Segoe UI,Arial,sans-serif;color:#111827}
.card{background:#fff;border-radius:18px;padding:28px;width:min(92vw,380px);box-shadow:0 20px 50px rgba(0,0,0,.4)}
h1{font-size:20px;margin:0 0 4px}p{font-size:13px;color:#6b7280;margin:0 0 18px}
label{display:block;font-size:12px;font-weight:700;margin:12px 0 4px}
input{width:100%;padding:12px;border:1px solid #d1d5db;border-radius:10px;font-size:15px}
button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;background:#ea580c;color:#fff;font-weight:800;font-size:15px;cursor:pointer}
.err{color:#dc2626;font-size:13px;margin-top:12px;min-height:16px}
a.sw{display:block;text-align:center;margin-top:14px;font-size:12px;color:#6b7280;cursor:pointer;text-decoration:underline}
</style></head><body><div class="card">
<h1 id="ttl">${needsSetup ? 'Pehli baar setup' : 'Staff Login'}</h1>
<p id="sub">${needsSetup ? 'Staff ke liye username aur password set karein. Owner PIN zaroori hai.' : 'POS, Kitchen, Kiosk aur Attendance ke liye login karein.'}</p>
<form id="f">
  <div id="pinRow" style="display:${needsSetup ? 'block' : 'none'}"><label>Owner PIN</label><input id="pin" type="password" autocomplete="off" inputmode="numeric"></div>
  <label>Username</label><input id="u" autocomplete="username" autocapitalize="none">
  <label>Password${needsSetup ? ' (kam se kam 8 characters)' : ''}</label><input id="p" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
  <button id="btn" type="submit">${needsSetup ? 'Set & Login' : 'Login'}</button>
  <div class="err" id="err"></div>
</form>
${needsSetup ? '' : '<a class="sw" id="sw">Username / password badalna hai? (Owner PIN)</a>'}
</div><script>
var setup=${needsSetup ? 'true' : 'false'},NEXT=${JSON.stringify(next)};
var $=function(i){return document.getElementById(i)};
var sw=$('sw');if(sw)sw.onclick=function(){setup=true;$('pinRow').style.display='block';$('ttl').textContent='Credentials badlein';$('sub').textContent='Naya username/password set karne par sab devices dobara login karenge.';$('btn').textContent='Save & Login';sw.style.display='none';};
$('f').onsubmit=function(e){e.preventDefault();$('err').textContent='';
 var url=setup?'/api/staff-auth/credentials':'/api/staff-auth/login';
 var body=setup?{pin:$('pin').value,username:$('u').value,password:$('p').value}:{username:$('u').value,password:$('p').value};
 fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})})
 .then(function(x){if(x.ok&&x.d.success){location.href=NEXT}else{$('err').textContent=x.d.error||'Dikkat aayi'}}).catch(function(){$('err').textContent='Server se connect nahi hua'});};
</script></body></html>`;
}

module.exports = { register };
