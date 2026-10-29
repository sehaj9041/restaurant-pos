@echo off
rem One-time setup: agent auto-starts at every Windows logon and is restarted if it stops.
schtasks /Create /F /TN "TadkaTechPrinterAgent" /SC ONLOGON /RL HIGHEST /TR "wscript.exe \"%~dp0RunHidden.vbs\""
schtasks /Create /F /TN "TadkaTechPrinterAgentWatchdog" /SC MINUTE /MO 5 /TR "wscript.exe \"%~dp0RunHidden.vbs\""
schtasks /Run /TN "TadkaTechPrinterAgent"
echo Done. Agent now runs in background and starts automatically after restart.
pause
