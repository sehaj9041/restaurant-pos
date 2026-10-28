$CloudHost = "menu.vishalfoodiez.in"
$KitchenPrinterIP = "192.168.1.87"
$KitchenPrinterPort = 9100
$LocalPOSPrinterName = "Posiflex PP8803 Printerrr"
$historyFile = "$PSScriptRoot\processed.txt"

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

                        $printData = "$INIT$CENTER$BOLD_ON" + "ITEM READY`n" + "$BOLD_OFF" + "Order #$($job.order_id) | $($job.table)`n--------------------------------`n$LEFT$BIG_ON$($job.qty) x $($job.item_name)`n$BIG_OFF";
                        if ($job.addons) { $printData += "+ $($job.addons)`n" };
                        $printData += "--------------------------------`n$CENTER" + "Time: $($job.time)`n`n`n$CUT";

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