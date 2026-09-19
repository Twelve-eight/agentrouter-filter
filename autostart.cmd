@echo off
rem agentrouter filter gateway autostart (HKCU\..\Run, no admin needed).
rem Codex providers in %USERPROFILE%\.codex\config.toml point at
rem http://127.0.0.1:7878/<route>/v1; without this process they all fail.
rem Remove with: reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v agentrouter-gateway /f
setlocal
set "NODE=G:\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set "GW=G:\omp works\Tools\agentrouter-filter\server.mjs"
set "LOG=G:\omp works\.tmp\argw-autostart.log"
start "" /min cmd /c ""%NODE%" "%GW%" >> "%LOG%" 2>&1"
exit /b 0
