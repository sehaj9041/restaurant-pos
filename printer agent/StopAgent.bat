@echo off
title Printer Agent Band Karo
echo Auto-start aur watchdog hataya ja raha hai...
schtasks /End /TN "TadkaTechPrinterAgent" >/dev/null 2>&1
schtasks /Delete /F /TN "TadkaTechPrinterAgent" >/dev/null 2>&1
schtasks /Delete /F /TN "TadkaTechPrinterAgentWatchdog" >/dev/null 2>&1
echo Agent band kiya ja raha hai...
taskkill /F /IM wscript.exe >/dev/null 2>&1
taskkill /F /IM powershell.exe >/dev/null 2>&1
timeout /t 2 >nul
echo.
schtasks /Query /TN "TadkaTechPrinterAgent" >/dev/null 2>&1 && (echo DIKKAT: agent task abhi bhi hai) || echo OK: agent ka auto-start hat gaya
echo Ab Vishal Foodiez POS exe ko band karke dobara kholiye.
pause
