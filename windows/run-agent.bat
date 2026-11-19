@echo off
setlocal EnableExtensions

set "AGENT=%~dp0agent.ps1"
if not exist "%AGENT%" (
  echo Agent not found: %AGENT%
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%AGENT%" -Console %*
exit /b %ERRORLEVEL%
