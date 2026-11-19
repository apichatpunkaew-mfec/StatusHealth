@echo off
setlocal EnableExtensions

REM แก้ไข 2 บรรทัดนี้หลัง deploy (หรือ set เป็น environment variable ก็ได้)
if not defined HEALTH_ENDPOINT set "HEALTH_ENDPOINT=https://pc-health-dashboard.apichat-p-1989.workers.dev/api/health"
if not defined HEALTH_TOKEN set "HEALTH_TOKEN=CHANGE_ME"

set "COLLECTOR=%~dp0collect-and-send.ps1"
if not exist "%COLLECTOR%" (
  echo Collector not found: %COLLECTOR%
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%COLLECTOR%" -Endpoint "%HEALTH_ENDPOINT%" -Token "%HEALTH_TOKEN%" %*
exit /b %ERRORLEVEL%
