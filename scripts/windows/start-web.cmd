@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Zichan Web

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
  echo [OK] Web launcher preflight passed.
  set "EXIT_CODE=0"
  goto :finish
)

echo.
echo Starting Zichan Web on http://127.0.0.1:5173/
echo Press Ctrl+C to stop. Port 5173 must be free.
echo.
call npm.cmd run dev --workspace @zichan/web -- --host 127.0.0.1 --port 5173 --strictPort
set "EXIT_CODE=%ERRORLEVEL%"

:finish
if defined ROOT_ENTERED popd >nul
echo.
if "%EXIT_CODE%"=="0" (echo Web process finished.) else echo [ERROR] Web launcher exited with code %EXIT_CODE%.
if not "%ZICHAN_NO_PAUSE%"=="1" pause
endlocal & exit /b %EXIT_CODE%
