const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const net = require('net');

const CLOUD_HOST = 'menu.vishalfoodiez.in';
const PRINTER_IP = '192.168.1.87';
const PRINTER_PORT = 9100;

// ================= KITCHEN NETWORK PRINTER FUNCTION =================
function printToNetworkPrinter(printData) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(4000);
    client.setNoDelay(true);

    let resolved = false;

    client.connect(PRINTER_PORT, PRINTER_IP, () => {
      client.write(printData, 'binary', () => {
        client.end();
        if (!resolved) {
          resolved = true;
          resolve(true);
        }
      });
    });

    client.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    client.on('timeout', () => {
      client.destroy();
      if (!resolved) {
        resolved = true;
        reject(new Error('Connection timed out'));
      }
    });
  });
}

function buildPrintPayload(job) {
  const ESC = '\x1B';
  const GS = '\x1D';
  const INIT = ESC + '@';
  const BOLD_ON = ESC + 'E' + '\x01';
  const BOLD_OFF = ESC + 'E' + '\x00';
  const CENTER = ESC + 'a' + '\x01';
  const LEFT = ESC + 'a' + '\x00';
  const CUT = GS + 'V' + '\x41' + '\x00';

  const count = Math.max(1, parseInt(job.qty, 10) || 1);
  let out = '';
  for (let n = 1; n <= count; n++) {
    out +=
      INIT +
      CENTER + BOLD_ON + `ITEM READY (${n}/${count})\n` + BOLD_OFF +
      `Order #${job.order_id} | ${job.table}\n` +
      "--------------------------------\n" +
      LEFT + BOLD_ON + `1 x ${job.item_name}\n` + BOLD_OFF +
      [].concat(job.addons || []).filter(Boolean).map(a => `+ ${a}\n`).join('') +
      "--------------------------------\n" +
      CENTER + `Time: ${job.time}\n\n\n` +
      CUT;
  }
  return out;
}

// Native HTTPS GET Request to fetch pending print queue from cloud
function checkCloudPrintQueue() {
  https.get(`https://${CLOUD_HOST}/api/print/pending-queue`, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed && parsed.success && parsed.jobs && parsed.jobs.length > 0) {
          console.log(`[QUEUE] Found ${parsed.jobs.length} pending print job(s).`);
          parsed.jobs.forEach(async (job) => {
            console.log(`[PRINT JOB] Processing Order #${job.order_id} - ${job.item_name}`);
            try {
              const rawData = buildPrintPayload(job);
              await printToNetworkPrinter(rawData);
              console.log(`[PRINT SUCCESS] Order #${job.order_id} printed successfully.`);

              // Acknowledge cloud via POST
              const postData = JSON.stringify({ jobId: job.id });
              const reqOpts = {
                hostname: CLOUD_HOST,
                port: 443,
                path: '/api/print/acknowledge',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': postData.length
                }
              };
              const ackReq = https.request(reqOpts, (ackRes) => {});
              ackReq.on('error', () => {});
              ackReq.write(postData);
              ackReq.end();

            } catch (printErr) {
              console.error(`[PRINT ERROR] Failed for job #${job.id}:`, printErr.message);
            }
          });
        }
      } catch (e) {}
    });
  }).on('error', (err) => {
    // Silent ignore for internet hiccups
  });
}

// Poll cloud every 2 seconds
setInterval(checkCloudPrintQueue, 2000);

// ================= HTTP SERVER FOR CASH DRAWER =================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/kick-drawer' && req.method === 'POST') {
    const cmd = `powershell -NoProfile -Command "$b = [byte[]](0x1B,0x70,0x00,0x19,0xFA); $p = [System.IO.Path]::Combine($env:TEMP, 'k.bin'); [System.IO.File]::WriteAllBytes($p, $b); Get-Content -Path $p -Encoding Byte -Raw | Out-Printer -Name 'Posiflex PP8803 Printer'; Remove-Item $p -ErrorAction SilentlyContinue"`;

    exec(cmd, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false }));
      }
      console.log('>> Cash Drawer Kicked! (0mm Paper)');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(4567, '127.0.0.1', () => {
  console.log('TadkaTech Zero-Paper Agent Running (Polling Active)!');
});