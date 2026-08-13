@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Start Zichan Web and Server

set "EXIT_CODE=1"
pushd "%~dp0..\.." >nul
if errorlevel 1 (
  echo [ERROR] Could not enter the repository root.
  goto :finish
)
set "ROOT_ENTERED=1"

call "%~dp0_check-environment.cmd"
if errorlevel 1 goto :finish

if not exist "%~dp0start-web.cmd" (
  echo [ERROR] Missing child launcher: %~dp0start-web.cmd
  goto :finish
)
if not exist "%~dp0start-sync-server.cmd" (
  echo [ERROR] Missing child launcher: %~dp0start-sync-server.cmd
  goto :finish
)

if "%ZICHAN_CHECK_ONLY%"=="1" (
  echo [OK] Combined Web and server launcher preflight passed.
  set "EXIT_CODE=0"
  goto :finish
)

echo.
echo Launching two independent windows:
echo   Web development server  http://127.0.0.1:5173/
echo   Sync and admin server    http://127.0.0.1:8787/
echo Use Ctrl+C in each child window to stop that service.
echo.

start "Zichan Web" /D "%~dp0" "%ComSpec%" /D /C "call start-web.cmd"
if errorlevel 1 (
  echo [ERROR] Could not launch the Web window.
  goto :finish
)

start "Zichan Sync Server" /D "%~dp0" "%ComSpec%" /D /C "call start-sync-server.cmd"
if errorlevel 1 (
  echo [ERROR] Could not launch the sync-server window.
  echo         The Web window may already be running; use Ctrl+C there to stop it.
  goto :finish
)

echo [OK] Both service windows were launched.
set "EXIT_CODE=0"

:finish
if defined ROOT_ENTERED popd >nul
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Combined launcher exited with code %EXIT_CODE%.
  if not "%ZICHAN_NO_PAUSE%"=="1" pause
)
endlocal & exit /b %EXIT_CODE%
