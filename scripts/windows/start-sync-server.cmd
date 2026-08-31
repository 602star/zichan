@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Zichan Sync Server

set "EXIT_CODE=1"
pushd "%~dp0..\.." >nul
if errorlevel 1 (
  echo [ERROR] Could not enter the repository root.
  goto :finish
)
set "ROOT_ENTERED=1"

call "%~dp0_check-environment.cmd"
if errorlevel 1 goto :finish

if "%ZICHAN_CHECK_ONLY%"=="1" (
  echo [OK] Sync-server launcher preflight passed.
  set "EXIT_CODE=0"
  goto :finish
)

echo.
echo Starting the all-in-one sync server on http://127.0.0.1:8787/ (bind 0.0.0.0:8787)
set "DATA_DIR=%CD%\.runtime\sync-server"
set "HOST=0.0.0.0"
set "REGISTRATION_MODE=open"
echo Development data are stored under %DATA_DIR%.
echo Registration is open; the first successfully registered account becomes the administrator.
echo This enables LAN HTTP for private-network use. Do not expose port 8787 publicly.
echo Press Ctrl+C to stop. Port 8787 must be free.
echo.
call npm.cmd run server --workspace @zichan/desktop
set "EXIT_CODE=%ERRORLEVEL%"

:finish
if defined ROOT_ENTERED popd >nul
echo.
if "%EXIT_CODE%"=="0" (echo Sync-server process finished.) else echo [ERROR] Sync-server launcher exited with code %EXIT_CODE%.
if not "%ZICHAN_NO_PAUSE%"=="1" pause
endlocal & exit /b %EXIT_CODE%
