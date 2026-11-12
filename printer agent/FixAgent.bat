@echo off
title Printer Agent Fix
cd /d "%~dp0"
echo.
echo [1/5] Purana agent band kiya ja raha hai...
taskkill /F /IM powershell.exe >nul 2>&1
taskkill /F /IM "Vishal Foodiez POS.exe" /T >nul 2>&1
timeout /t 2 >nul
echo.
echo [2/5] Is PC ke printers (Default = True wala billing printer hona chahiye):
powershell -NoProfile -Command "Get-CimInstance Win32_Printer | Select-Object Name,Default | Format-Table -AutoSize"
echo.
echo [3/5] Agent start aur auto-start set ho raha hai...
schtasks /Create /F /TN "TadkaTechPrinterAgent" /SC ONLOGON /RL HIGHEST /TR "wscript.exe \"%~dp0RunHidden.vbs\"" >nul 2>&1
schtasks /Create /F /TN "TadkaTechPrinterAgentWatchdog" /SC MINUTE /MO 5 /TR "wscript.exe \"%~dp0RunHidden.vbs\"" >nul 2>&1
start "" wscript.exe "%~dp0RunHidden.vbs"
timeout /t 8 >nul
echo.
echo [4/5] Agent check:
powershell -NoProfile -Command "try { Invoke-WebRequest http://127.0.0.1:4567/ -UseBasicParsing -TimeoutSec 5 | Out-Null; Write-Host 'AGENT CHAL RAHA HAI - OK' -ForegroundColor Green } catch { if ($_.Exception.Response) { Write-Host 'AGENT CHAL RAHA HAI - OK' -ForegroundColor Green } else { Write-Host 'AGENT NAHI CHAL RAHA - is screen ki photo bhejo' -ForegroundColor Red } }"
echo.
echo [5/5] Server se connection check (naya print/drawer raasta):
powershell -NoProfile -Command "try { $r = Invoke-RestMethod https://menu.vishalfoodiez.in/api/print/local-queue -TimeoutSec 10; if ($r.success) { Write-Host 'SERVER CONNECTION OK' -ForegroundColor Green } else { Write-Host 'SERVER ne naya code nahi liya - baad me dobara chalao' -ForegroundColor Yellow } } catch { Write-Host 'SERVER CONNECTION FAIL - internet ya server check karo' -ForegroundColor Red }"
echo.
echo Ab POS wale Chrome tab me Ctrl+Shift+R dabao. Phir Print aur Open Drawer try karo.
pause
