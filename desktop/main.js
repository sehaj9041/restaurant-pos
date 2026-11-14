// Vishal Foodiez POS desktop app: shows the POS site and does what the printer agent did
// (silent bill print, ESC/POS image print, cash drawer kick, kitchen network-printer queue).
const { app, BrowserWindow, ipcMain, shell, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const DEFAULTS = {
  url: 'https://menu.vishalfoodiez.in/index.html',   // the POS ("/" is the customer ordering page)
  printerName: '',                 // empty = the Windows default printer (the billing printer)
  kitchenQueue: true,              // poll the cloud for "item ready" tokens and send them to the kitchen network printer
  kitchenPrinterIP: '192.168.1.87',
  kitchenPrinterPort: 9100,
  // bill print settings (Ctrl+Shift+P opens the settings window)
  billDots: 544,                   // printable width in dots: 384 = 58mm paper, 576 = 80mm paper full width, 544 = 80mm with small side margins
  billScale: 100,                  // bill size in % of the paper width (lower = smaller text, more margin)
  billLeft: 0,                     // shift to the right, in dots
  billBottom: 6,                   // blank rows added under the bill, in dots
  billCut: true                    // cut the paper after the bill
};
let cfg = Object.assign({}, DEFAULTS);
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { cfg = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(cfgFile(), 'utf8'))); }
  catch (e) { try { fs.writeFileSync(cfgFile(), JSON.stringify(DEFAULTS, null, 2)); } catch (e2) {} }
  // v1.0.0 saved "/" (customer page) as the url: fix it
  if (/^https:\/\/menu\.vishalfoodiez\.in\/?$/.test(cfg.url)) { cfg.url = DEFAULTS.url; try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch (e) {} }
}
const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), new Date().toISOString() + ' ' + a.join(' ') + os.EOL); } catch (e) {} console.log(...a); };

if (!app.requestSingleInstanceLock()) app.quit();

let win = null, rawProc = null, rawBuf = '', rawSeq = 0;
const rawWaiting = new Map();

// ---------- RAW printer helper (persistent powershell) ----------
function startRaw() {
  const script = app.isPackaged ? path.join(process.resourcesPath, 'raw.ps1') : path.join(__dirname, 'raw.ps1');
  rawProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], { windowsHide: true });
  rawProc.stdout.on('data', (d) => {
    rawBuf += d.toString();
    let i;
    while ((i = rawBuf.indexOf('\n')) >= 0) {
      const line = rawBuf.slice(0, i).trim(); rawBuf = rawBuf.slice(i + 1);
      const [id, res] = line.split('\t');
      const w = rawWaiting.get(id);
      if (w) { rawWaiting.delete(id); clearTimeout(w.t); w.resolve(res === 'OK'); }
    }
  });
  rawProc.on('exit', () => { rawProc = null; rawWaiting.forEach((w) => { clearTimeout(w.t); w.resolve(false); }); rawWaiting.clear(); });
  rawProc.on('error', (e) => log('raw helper error', e.message));
}
let printerNameCache = '';
async function billingPrinter() {
  if (cfg.printerName) return cfg.printerName;
  if (printerNameCache) return printerNameCache;
  try {
    const list = await win.webContents.getPrintersAsync();
    const p = list.find((x) => x.isDefault) || list[0];
    if (p) printerNameCache = p.name;
  } catch (e) {}
  return printerNameCache;
}
async function sendRaw(bytes) {
  const printer = await billingPrinter();
  if (!printer) { log('no printer found'); return false; }
  if (!rawProc) startRaw();
  const id = String(++rawSeq);
  const file = path.join(os.tmpdir(), 'vf-raw-' + id + '-' + Date.now() + '.bin');
  fs.writeFileSync(file, Buffer.from(bytes));
  const ok = await new Promise((resolve) => {
    const t = setTimeout(() => { rawWaiting.delete(id); resolve(false); }, 15000);
    rawWaiting.set(id, { resolve, t });
    rawProc.stdin.write(id + '\t' + printer + '\t' + file + '\n');
  });
  fs.unlink(file, () => {});
  if (!ok) { printerNameCache = ''; log('raw print failed on printer', printer); }
  return ok;
}

// ---------- ESC/POS bitmap (same as agent.ps1 Build-EscPosImage) ----------
function buildEscPosImage(job) {
  const w = job.width | 0, h = job.height | 0, img = Buffer.from(String(job.data), 'base64'), rowBytes = w / 8;
  const copies = Math.max(1, Math.min(5, job.copies | 0 || 1)), parts = [];
  for (let c = 0; c < copies; c++) {
    parts.push(Buffer.from([0x1B, 0x40, 0x1D, 0x4C, 0x00, 0x00, 0x1D, 0x57, 0x40, 0x02]));
    for (let y = 0; y < h; y += 200) {
      const band = Math.min(200, h - y);
      parts.push(Buffer.from([0x1D, 0x76, 0x30, 0x00, rowBytes & 0xFF, rowBytes >> 8, band & 0xFF, band >> 8]));
      parts.push(img.subarray(y * rowBytes, (y + band) * rowBytes));
    }
    if (job.cut !== false) parts.push(Buffer.from([0x1D, 0x56, 0x41, 0x03]));
    else parts.push(Buffer.from([0x1B, 0x64, 0x04])); // no cutter: feed 4 lines so the slip can be torn off
  }
  return Buffer.concat(parts);
}

// ---------- silent HTML print (replaces the --kiosk-printing Chrome window) ----------
async function printHtml(html) {
  // the POS page appends its own window.print() script for the browser route: remove it, we print from here
  html = String(html).replace(/<script>[^]*?window\.print\(\)[^]*?<\/script>/gi, '');
  const dir = path.join(os.tmpdir(), 'vf-print'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bill-' + Date.now() + '.html'); fs.writeFileSync(file, html, 'utf8');
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await pw.loadFile(file);
    await new Promise((r) => setTimeout(r, 400)); // let images (QR, logo) finish
    const printer = await billingPrinter();
    return await new Promise((resolve) => {
      const opts = { silent: true, printBackground: true, margins: { marginType: 'none' } };
      if (printer) opts.deviceName = printer;
      pw.webContents.print(opts, (ok, why) => { if (!ok) log('print failed:', why); resolve(!!ok); });
    });
  } catch (e) { log('printHtml error', e.message); return false; }
  finally { try { pw.destroy(); } catch (e) {} setTimeout(() => fs.unlink(file, () => {}), 60000); }
}

// ---------- bill as ESC/POS bitmap, rendered by Chromium itself (html2canvas dropped spaces / drifted lines on the Windows PCs) ----------
async function printBillBitmap(html, copies) {
  html = String(html).replace(/<script>[^]*?window\.print\(\)[^]*?<\/script>/gi, '');
  const dir = path.join(os.tmpdir(), 'vf-print'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bill-' + Date.now() + '.html'); fs.writeFileSync(file, html, 'utf8');
  // frameless + enableLargerThanScreen: a long bill must not be shrunk to the screen height (that cut off the bottom / right of the slip)
  const pw = new BrowserWindow({ show: false, frame: false, enableLargerThanScreen: true, width: 420, height: 900, useContentSize: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    await pw.loadFile(file);
    await pw.webContents.insertCSS('html,body{overflow:hidden !important}'); // no scrollbar eating the right edge
    await new Promise((r) => setTimeout(r, 500)); // let images (logo, QR) finish
    const box = await pw.webContents.executeJavaScript('(function(){var b=document.body.getBoundingClientRect(),l=document.body.lastElementChild,e=l?l.getBoundingClientRect().bottom:b.bottom;return [b.left,b.width,Math.ceil(e+8)];})()');
    const x = Math.floor(box[0]), w = Math.ceil(box[1]), h = box[2];
    pw.setContentSize(x + w + 10, h + 10);
    await new Promise((r) => setTimeout(r, 200));
    let img = await pw.webContents.capturePage({ x, y: 0, width: w, height: h });
    const DOTS = Math.max(8, (Math.round(Number(cfg.billDots) || 544) >> 3) << 3);   // paper width, multiple of 8
    const scale = Math.max(30, Math.min(100, Number(cfg.billScale) || 100)) / 100;
    const left = Math.max(0, Math.round(Number(cfg.billLeft) || 0));
    const bottom = Math.max(0, Math.round(Number(cfg.billBottom) || 0));
    const CW = Math.max(8, Math.round(DOTS * scale));                                 // bill width inside the paper
    const H = Math.max(1, Math.round(img.getSize().height * CW / img.getSize().width));
    img = img.resize({ width: CW, height: H, quality: 'best' });
    const px = img.toBitmap(), rowBytes = DOTS / 8, bytes = Buffer.alloc(rowBytes * H); // BGRA in, 1 bit out
    const off = Math.min(left + (cfg.billScale < 100 ? Math.round((DOTS - CW) / 2) : 0), DOTS - 1); // a scaled-down bill is centred, then shifted by "left"
    for (let y = 0; y < H; y++) for (let xx = 0; xx < CW; xx++) {
      const ox = xx + off; if (ox >= DOTS) break;
      const i = (y * CW + xx) * 4;
      if (px[i + 3] > 40 && (px[i + 2] * 0.3 + px[i + 1] * 0.59 + px[i] * 0.11) < 170) bytes[y * rowBytes + (ox >> 3)] |= (0x80 >> (ox & 7));
    }
    let last = 0;
    for (let y = H - 1; y >= 0 && !last; y--) for (let q = 0; q < rowBytes; q++) if (bytes[y * rowBytes + q]) { last = y; break; }
    const outH = Math.min(H, last + 1) + bottom, full = Buffer.concat([bytes.subarray(0, Math.min(H, last + 1) * rowBytes), Buffer.alloc(bottom * rowBytes)]);
    return await sendRaw(buildEscPosImage({ width: DOTS, height: outH, copies, cut: cfg.billCut !== false, data: full.toString('base64') }));
  } catch (e) { log('printBillBitmap error', e.message); return false; }
  finally { try { pw.destroy(); } catch (e) {} setTimeout(() => fs.unlink(file, () => {}), 60000); }
}
ipcMain.handle('print-bill', async (e, html, copies) => ({ success: await printBillBitmap(html, Math.max(1, Math.min(5, copies | 0 || 1))) }));
// ---------- printer settings window (Ctrl+Shift+P) ----------
const SETTING_KEYS = ['printerName', 'billDots', 'billScale', 'billLeft', 'billBottom', 'billCut'];
let settingsWin = null;
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({ width: 520, height: 640, parent: win || undefined, title: 'Printer Settings', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}
ipcMain.handle('open-settings', () => { openSettings(); return true; });
ipcMain.handle('get-settings', async () => {
  let printers = []; try { printers = (await win.webContents.getPrintersAsync()).map((p) => ({ name: p.name, isDefault: !!p.isDefault })); } catch (e) {}
  const s = {}; SETTING_KEYS.forEach((k) => { s[k] = cfg[k]; });
  return { settings: s, printers };
});
ipcMain.handle('save-settings', (e, s) => {
  const num = (v, lo, hi, d) => { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d; };
  cfg.printerName = String((s && s.printerName) || '');
  cfg.billDots = num(s && s.billDots, 64, 832, DEFAULTS.billDots);
  cfg.billScale = num(s && s.billScale, 30, 100, DEFAULTS.billScale);
  cfg.billLeft = num(s && s.billLeft, 0, 200, DEFAULTS.billLeft);
  cfg.billBottom = num(s && s.billBottom, 0, 200, DEFAULTS.billBottom);
  cfg.billCut = !(s && s.billCut === false);
  printerNameCache = '';
  try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch (err) { log('save settings', err.message); return false; }
  return true;
});
ipcMain.handle('test-print', async () => {
  const row = (a, b, c, d) => '<tr><td class="nm">' + a + '</td><td class="q">' + b + '</td><td class="r">' + c + '</td><td class="a">' + d + '</td></tr>';
  const html = '<html><head><style>body{font-family:Arial,sans-serif;font-size:13px;color:#000;margin:0;padding:2px 6px 0;width:68mm}.c{text-align:center}.t{border:2.5px solid #000;font-size:26px;font-weight:900;text-align:center;padding:4px 0;margin:6px 0}.d{border-top:1.5px dashed #000;margin:6px 0}table{width:100%;border-collapse:collapse;table-layout:fixed}th{border-bottom:1.5px solid #000;font-size:12px}td{padding:3px 0}.nm{font-weight:700;text-align:left}.q{width:8mm;text-align:center}.r{width:13mm;text-align:right}.a{width:16mm;text-align:right}</style></head><body>' +
    '<div class="c" style="font-size:18px;font-weight:900">VISHAL FOODIEZ</div><div class="c" style="font-size:11px">TEST PRINT - left / right edge check</div><div class="t">TOKEN #1</div><div>&#9664; left edge ........ right edge &#9654;</div><div class="d"></div>' +
    '<table><thead><tr><th class="nm">Item</th><th class="q">Qty</th><th class="r">Rate</th><th class="a">Amount</th></tr></thead><tbody>' + row('Spicy Paneer Burger', 2, '89.00', '178.00') + row('Oreo Shake', 1, '99.00', '99.00') + '</tbody></table>' +
    '<div class="d"></div><div style="display:flex;justify-content:space-between;font-size:16px;font-weight:900"><span>TOTAL BILL:</span><span>&#8377;277.00</span></div><div class="c" style="font-size:11px;margin-top:4px">Thanks For Visiting Us!</div></body></html>';
  return { success: await printBillBitmap(html, 1) };
});
ipcMain.handle('print-html', async (e, html) => ({ success: await printHtml(html) }));
ipcMain.handle('print-image', async (e, job) => { try { return { success: await sendRaw(buildEscPosImage(job)) }; } catch (err) { log('print-image', err.message); return { success: false }; } });
ipcMain.handle('kick-drawer', async () => ({ success: await sendRaw([0x1B, 0x70, 0x01, 0x19, 0xFA]) }));

// ---------- kitchen "item ready" queue -> network printer (same as agent.ps1) ----------
let processed = new Set(), pollBusy = false;
const historyFile = () => path.join(app.getPath('userData'), 'processed.txt');
function kitchenPayload(job) {
  const ESC = '\x1B', GS = '\x1D', n = Math.max(1, parseInt(job.qty, 10) || 1);
  let out = '';
  for (let t = 1; t <= n; t++) {
    out += ESC + '@' + ESC + 'a\x01' + ESC + 'E\x01' + `ITEM READY (${t}/${n})\n` + ESC + 'E\x00' + `Order #${job.order_id} | ${job.table}\n--------------------------------\n` +
      ESC + 'a\x00' + ESC + '!\x38' + `1 x ${job.item_name}\n` + ESC + '!\x00' +
      [].concat(job.addons || []).filter(Boolean).map((a) => `+ ${a}\n`).join('') +
      '--------------------------------\n' + ESC + 'a\x01' + `Time: ${job.time}\n\n\n` + GS + 'V\x41\x00';
  }
  return Buffer.from(out, 'latin1');
}
function sendToKitchen(buf) {
  return new Promise((resolve, reject) => {
    const s = new net.Socket(); let done = false;
    const end = (err) => { if (done) return; done = true; s.destroy(); err ? reject(err) : resolve(); };
    s.setTimeout(5000, () => end(new Error('kitchen printer timeout')));
    s.on('error', end);
    s.connect(cfg.kitchenPrinterPort, cfg.kitchenPrinterIP, () => s.write(buf, () => end()));
  });
}
async function pollKitchen() {
  if (pollBusy) return; pollBusy = true;
  try {
    const base = new URL(cfg.url).origin;
    const r = await fetch(base + '/api/print/pending-queue', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    for (const job of (j && j.success && j.jobs) || []) {
      const key = String(job.id);
      if (processed.has(key)) continue;
      try {
        await sendToKitchen(kitchenPayload(job));
        processed.add(key); fs.appendFileSync(historyFile(), key + '\r\n');
        log('kitchen printed order', job.order_id);
        fetch(base + '/api/print/acknowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id, id: job.id }) }).catch(() => {});
      } catch (e) { log('kitchen print error', e.message); }
    }
  } catch (e) { /* network hiccup */ }
  pollBusy = false;
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({ width: 1366, height: 768, show: false, autoHideMenuBar: true, title: 'Vishal Foodiez POS',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.control && input.shift && String(input.key).toLowerCase() === 'p') { e.preventDefault(); openSettings(); } });
  win.maximize(); win.show();
  win.loadURL(cfg.url);
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { u: cfg.url } });
  });
  // popups on the same site (customer display, reports) open inside the app; everything else (wa.me etc.) opens in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(new URL(cfg.url).origin)) {
      // customer display: open straight fullscreen on the 2nd monitor (no click needed; requestFullscreen from the page would need one)
      if (/\/customer(\?|$)/.test(url)) {
        const primary = screen.getPrimaryDisplay();
        const second = screen.getAllDisplays().find(d => d.id !== primary.id);
        if (second) return { action: 'allow', overrideBrowserWindowOptions: { x: second.bounds.x, y: second.bounds.y, width: second.bounds.width, height: second.bounds.height, fullscreen: true, autoHideMenuBar: true } };
      }
      return { action: 'allow' };
    }
    shell.openExternal(url); return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
// notification beeps (Web Audio) must start without the staff clicking anything first
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(() => {
  loadConfig();
  try { processed = new Set(fs.readFileSync(historyFile(), 'utf8').split(/\r?\n/).filter(Boolean)); } catch (e) {}
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true)); // window-management (2nd screen), notifications, etc.
  session.defaultSession.setPermissionCheckHandler(() => true);
  app.setLoginItemSettings({ openAtLogin: true });
  createWindow();
  startRaw();
  if (cfg.kitchenQueue) setInterval(pollKitchen, 2000);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { if (rawProc) rawProc.kill(); } catch (e) {} });
