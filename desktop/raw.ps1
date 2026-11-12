# Long-running helper: reads "id<TAB>printer<TAB>file" lines on stdin, writes the file's bytes RAW to that Windows printer,
# answers "id<TAB>OK" or "id<TAB>FAIL". One persistent process so the cash drawer kick is instant.
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
        public struct DOCINFOA { public string pDocName; public string pOutputFile; public string pDataType; }
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
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $p = $line.Split("`t")
    if ($p.Length -lt 3) { continue }
    $ok = $false
    try { $ok = [Win32RawPrinter]::SendBytes($p[1], [System.IO.File]::ReadAllBytes($p[2])) } catch {}
    [Console]::Out.WriteLine($p[0] + "`t" + $(if ($ok) { "OK" } else { "FAIL" }))
    [Console]::Out.Flush()
}
