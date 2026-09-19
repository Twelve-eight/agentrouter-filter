@echo off
rem Launcher for the omp service stack (Windows Terminal, tabs merged in one window).
rem Registered in HKCU\..\Run as "omp-services".
rem Hidden + non-blocking: autostart.ps1 opens the wt window and returns.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "G:\omp works\Tools\agentrouter-filter\autostart.ps1"
exit /b 0
