$createdNew = $false
$script:agentMutex = New-Object System.Threading.Mutex($true, "Global\TadkaTechPrinterAgent", [ref]$createdNew)
if (-not $createdNew) { exit }

$CloudHost = "menu.vishalfoodiez.in"
$KitchenPrinterIP = "192.168.1.87"
$KitchenPrinterPort = 9100
$LocalPOSPrinterName = "Posiflex PP8803 Printerrr"
$historyFile = "$PSScriptRoot\processed.txt"
$BrowserPath = ""   # leave empty to auto-detect Chrome (then Edge); or set the full path to chrome.exe

if (-not (Test-Path $historyFile)) { Set-Content $historyFile "" }
$processedJobs = [System.Collections.Generic.HashSet[string]]@(Get-Content $historyFile -ErrorAction SilentlyContinue)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  TadkaTech Dual Printer Agent Running" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

# Define Win32 Raw Printer class for Bypassing Driver Restrictions on Cash Drawer
if (-not ("Win32RawPrinter" -as [type])) {
    Add-Type -TypeDefinition @'
    using System;
    using System.Runtime.InteropServices;
    public class Win32RawPrinter {
        [DllImport("winspool.Drv", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

        [DllImport("winspool.Drv", SetLastError = true)]
        public static extern bool ClosePrinter(IntPtr hPrinter);

        [DllImport("winspool.Drv", CharSet = CharSet.Ansi, SetLastError = true)]
        public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] ref DOCINFOA pDocInfo);

        [DllImport("winspool.Drv", SetLastError = true)]
        public static extern bool EndDocPrinter(IntPtr hPrinter);

        [DllImport("winspool.Drv", SetLastError = true)]
        public static extern bool StartPagePrinter(IntPtr hPrinter);

        [DllImport("winspool.Drv", SetLastError = true)]
        public static extern bool EndPagePrinter(IntPtr hPrinter);

        [DllImport("winspool.Drv", SetLastError = true)]
        public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBuf, int cbBuf, out int pcWritten);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
        public struct DOCINFOA {
            public string pDocName;
            public string pOutputFile;
            public string pDataType;
        }

        public static bool SendBytes(String printerName, byte[] bytes) {
            IntPtr hPrinter = IntPtr.Zero;
            DOCINFOA di = new DOCINFOA();
            di.pDocName = "POS Raw Print";
            di.pDataType = "RAW";

                        bool ok = false;
            if (OpenPrinter(printerName.Normalize(), out hPrinter, IntPtr.Zero)) {
                if (StartDocPrinter(hPrinter, 1, ref di)) {
                    StartPagePrinter(hPrinter);
                    int written = 0;
                    ok = WritePrinter(hPrinter, bytes, bytes.Length, out written) && written == bytes.Length;
                    EndPagePrinter(hPrinter);
                    EndDocPrinter(hPrinter);
                }
                ClosePrinter(hPrinter);
            }
            return ok;
        }
    }
'@ -ErrorAction SilentlyContinue
}

# Build ESC/POS bytes from a 1-bit bitmap sent by the POS page (same look as the on-screen bill):
# {width, height, data(base64, packed 1 bit/pixel MSB first), copies}. Sent in bands of 200 rows (GS v 0).
function Build-EscPosImage($job) {
    $w = [int]$job.width; $h = [int]$job.height
    $img = [Convert]::FromBase64String([string]$job.data)
    $rowBytes = [int]($w / 8)
    $copies = [Math]::Max(1, [Math]::Min(5, [int]$job.copies))
    $ms = New-Object System.IO.MemoryStream
    for ($c = 0; $c -lt $copies; $c++) {
        # reset, left margin 0 (GS L), print area width 576 dots (GS W) - a saved printer margin was clipping the right side
        $init = [byte[]](0x1B, 0x40, 0x1D, 0x4C, 0x00, 0x00, 0x1D, 0x57, 0x40, 0x02)
        $ms.Write($init, 0, $init.Length)
        for ($y = 0; $y -lt $h; $y += 200) {
            $band = [Math]::Min(200, $h - $y)
            $hdr = [byte[]](0x1D, 0x76, 0x30, 0x00, ($rowBytes -band 0xFF), ($rowBytes -shr 8), ($band -band 0xFF), ($band -shr 8))
            $ms.Write($hdr, 0, $hdr.Length)
            $ms.Write($img, $y * $rowBytes, $band * $rowBytes)
        }
        $tail = [byte[]](0x1D, 0x56, 0x41, 0x03)   # feed to the cutter + 3 dots, partial cut (no extra blank feed)
        $ms.Write($tail, 0, $tail.Length)
    }
    return $ms.ToArray()
}

# Chrome/Edge used for silent bill printing (started with --kiosk-printing, prints to the Windows default printer)
function Find-Browser {
    if ($BrowserPath -and (Test-Path $BrowserPath)) { return $BrowserPath }
    $c = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($p in $c) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}
$printWindows = New-Object System.Collections.ArrayList
# One fixed profile: the first launch keeps a hidden Chrome running, so every later bill opens in that running instance (fast, ~0.3 s)
$printProfile = Join-Path $env:LOCALAPPDATA "vf-print-profile"
function Get-PrintArgs($url) {
    return @("--kiosk-printing", "--user-data-dir=`"$printProfile`"", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-timer-throttling", "--window-position=-3000,0", "--window-size=420,700", "--app=$url")
}
try {
    $warmBrowser = Find-Browser
    if ($warmBrowser) {
        New-Item -ItemType Directory -Force -Path $printProfile | Out-Null
        Start-Process -FilePath $warmBrowser -ArgumentList (Get-PrintArgs "about:blank") | Out-Null
        Write-Host "[PRINT] Silent print browser warmed up" -ForegroundColor Yellow
    }
} catch {}

# 1. Start Local HTTP Server for Cash Drawer + silent bill printing on Port 4567
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:4567/")
try {
    $listener.Start()
    Write-Host "[DRAWER] Listening on port 4567 for local POS printer..." -ForegroundColor Yellow
} catch {
    Write-Host "[ERROR] Port 4567 already in use!" -ForegroundColor Red
}

$jobTimer = [System.Diagnostics.Stopwatch]::StartNew()
$asyncContext = $listener.BeginGetContext($null, $null)

while ($true) {
    if ($asyncContext.IsCompleted) {
        $response = $null
        try {
            $context = $listener.EndGetContext($asyncContext)
            $request = $context.Request
            $response = $context.Response
            
            $response.Headers.Add("Access-Control-Allow-Origin", "*")
            $response.Headers.Add("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
            $response.Headers.Add("Access-Control-Allow-Private-Network", "true")


            if ($request.HttpMethod -eq "OPTIONS") {
                $response.StatusCode = 204
                $response.OutputStream.Close()
            } elseif ($request.Url.LocalPath -eq "/kick-drawer" -and $request.HttpMethod -eq "POST") {
                try {
                    # Send Drawer Kick bytes (Pin 1 -> 0x01) directly via Win32 API RAW Spooler
                    $drawerBytes = [byte[]](0x1B, 0x70, 0x01, 0x19, 0xFA)
                    [Win32RawPrinter]::SendBytes($LocalPOSPrinterName, $drawerBytes) | Out-Null
                    
                    Write-Host ">> Cash Drawer Kicked via Win32 RAW API!" -ForegroundColor Green
                } catch {
                    Write-Host "[DRAWER ERROR] $_" -ForegroundColor Red
                }

                $buffer = [System.Text.Encoding]::UTF8.GetBytes('{"success":true}')
                $response.ContentType = "application/json"
                $response.StatusCode = 200
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
                $response.OutputStream.Close()
                                    } elseif ($request.Url.LocalPath -eq "/print-html" -and $request.HttpMethod -eq "POST") {
                $okPrint = $false
                try {
                    $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                    $job = $reader.ReadToEnd() | ConvertFrom-Json
                    $browser = Find-Browser
                    if (-not $browser) { throw "Chrome/Edge not found - set `$BrowserPath at the top of agent.ps1" }
                    $dir = Join-Path $env:TEMP "vf-print"
                    New-Item -ItemType Directory -Force -Path $dir | Out-Null
                    $id = [guid]::NewGuid().ToString("N")
                    $file = Join-Path $dir "bill-$id.html"
                    
                    [System.IO.File]::WriteAllText($file, [string]$job.html, (New-Object System.Text.UTF8Encoding($false)))
                                        # same profile + --kiosk-printing every time; the page closes its own window after printing
                    New-Item -ItemType Directory -Force -Path $printProfile | Out-Null
                    $fileUrl = ([System.Uri]$file).AbsoluteUri
                    Start-Process -FilePath $browser -ArgumentList (Get-PrintArgs $fileUrl) | Out-Null
                    [void]$printWindows.Add(@{ at = (Get-Date).AddSeconds(60); file = $file })
                    $okPrint = $true
                    Write-Host ">> Bill sent to silent print window" -ForegroundColor Green
                } catch {
                    Write-Host "[PRINT ERROR] $_" -ForegroundColor Red
                }
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($(if ($okPrint) { '{"success":true}' } else { '{"success":false}' }))
                $response.ContentType = "application/json"
                $response.StatusCode = 200
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
                $response.OutputStream.Close()
            } elseif ($request.Url.LocalPath -eq "/print-image" -and $request.HttpMethod -eq "POST") {
                $okPrint = $false
                try {
                    $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                    $job = $reader.ReadToEnd() | ConvertFrom-Json
                    $bytes = Build-EscPosImage $job
                    $okPrint = [Win32RawPrinter]::SendBytes($LocalPOSPrinterName, $bytes)
                    if ($okPrint) { Write-Host ">> Bill printed silently" -ForegroundColor Green }
                    else { Write-Host "[PRINT ERROR] Could not open printer '$LocalPOSPrinterName' - check the name" -ForegroundColor Red }
                } catch {
                    Write-Host "[PRINT ERROR] $_" -ForegroundColor Red
                }
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($(if ($okPrint) { '{"success":true}' } else { '{"success":false}' }))
                $response.ContentType = "application/json"
                $response.StatusCode = 200
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
                $response.OutputStream.Close()
            } else {
                $response.StatusCode = 404
                $response.OutputStream.Close()
            }
        } catch {
            if ($response) {
                try {
                    $buffer = [System.Text.Encoding]::UTF8.GetBytes('{"success":false}')
                    $response.ContentType = "application/json"
                    $response.StatusCode = 200
                    $response.OutputStream.Write($buffer, 0, $buffer.Length)
                    $response.OutputStream.Close()
                } catch {}
            }
        }
        $asyncContext = $listener.BeginGetContext($null, $null)
    }

            # Remove the temp bill files a minute after they were printed
    if ($printWindows.Count -gt 0) {
        $now = Get-Date
        foreach ($w in @($printWindows)) {
            if ($now -ge $w.at) {
                                Remove-Item -Force -ErrorAction SilentlyContinue $w.file
                $printWindows.Remove($w)
            }
        }
    }

    # Poll Cloud Print Queue every 2 seconds (Targets Kitchen IP Printer)
    if ($jobTimer.ElapsedMilliseconds -ge 2000) {
        $jobTimer.Restart()
        try {
            $uri = "https://$CloudHost/api/print/pending-queue"
            $responseJson = Invoke-RestMethod -Uri $uri -Method Get -ErrorAction SilentlyContinue
            
            if ($responseJson -and $responseJson.success -and $responseJson.jobs -and $responseJson.jobs.Count -gt 0) {
                foreach ($job in $responseJson.jobs) {
                    $jobUniqueKey = "$($job.id)"
                    
                    if ($processedJobs.Contains($jobUniqueKey)) {
                        continue
                    }

                    Write-Host "[PRINT JOB] Processing Order #$($job.order_id) - $($job.item_name)" -ForegroundColor Magenta
                    try {
                        $ESC = [char]0x1B;
                        $GS = [char]0x1D;
                        $INIT = "$ESC@";
                        $BOLD_ON = "$ESC" + "E" + [char]0x01;
                        $BOLD_OFF = "$ESC" + "E" + [char]0x00;
                        $CENTER = "$ESC" + "a" + [char]0x01;
                        $LEFT = "$ESC" + "a" + [char]0x00;
                        $CUT = "$GS" + "V" + [char]0x41 + [char]0x00;
                        $BIG_ON = "$ESC" + "!" + [char]0x38;
                        $BIG_OFF = "$ESC" + "!" + [char]0x00;

                        $tokenCount = [int]$job.qty; if ($tokenCount -lt 1) { $tokenCount = 1 }
                        $printData = "";
                        for ($t = 1; $t -le $tokenCount; $t++) {
                            $printData += "$INIT$CENTER$BOLD_ON" + "ITEM READY ($t/$tokenCount)`n" + "$BOLD_OFF" + "Order #$($job.order_id) | $($job.table)`n--------------------------------`n$LEFT$BIG_ON" + "1 x $($job.item_name)`n$BIG_OFF";
                            foreach ($a in @($job.addons)) { if ($a) { $printData += "+ $a`n" } };
                            $printData += "--------------------------------`n$CENTER" + "Time: $($job.time)`n`n`n$CUT";
                        }

                        # Send to Kitchen IP Printer via Network Socket
                        $socket = New-Object System.Net.Sockets.TcpClient;
                        $connect = $socket.BeginConnect($KitchenPrinterIP, $KitchenPrinterPort,$null, $null);$success = $connect.AsyncWaitHandle.WaitOne(5000,$true);
                        
                        if (-not $success -or -not$socket.Connected) {
                            throw "Kitchen printer connection timed out (IP: $KitchenPrinterIP)";
                        }

                        $stream = $socket.GetStream();$bytes = [System.Text.Encoding]::Default.GetBytes($printData);$stream.Write($bytes, 0,$bytes.Length);
                        $stream.Close();$socket.Close();

                        $processedJobs.Add($jobUniqueKey) | Out-Null
                        [System.IO.File]::AppendAllText($historyFile, "$jobUniqueKey`r`n")

                        Write-Host "[PRINT SUCCESS] Order #$($job.order_id) sent to Kitchen IP printer!" -ForegroundColor Green

                        try {
                            $ackUrl = "https://$CloudHost/api/print/acknowledge";
                            $wc = New-Object System.Net.WebClient;
                            $wc.Headers.Add("Content-Type", "application/json");
                            $jsonPayload = '{"jobId":' + $job.id + ',"id":' + $job.id + '}';
                            $wc.UploadString($ackUrl, "POST", $jsonPayload);$wc.Dispose();
                        } catch {}
                    } catch {
                        Write-Host "[PRINT ERROR] Failed: $_" -ForegroundColor Red
                    }
                }
            }
        } catch {
            # Network hiccup handling
        }
    }

    Start-Sleep -Milliseconds 50
}