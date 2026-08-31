@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Prepare Zichan WebView2 Runtime

set "EXIT_CODE=1"
pushd "%~dp0..\.." >nul
if errorlevel 1 (
  echo [ERROR] Could not enter the repository root.
  goto :finish
)
set "ROOT_ENTERED=1"

call "%~dp0_check-environment.cmd"
if errorlevel 1 goto :finish

echo.
echo Preparing the locked Microsoft WebView2 Fixed Version runtime...
echo This explicit setup step may download more than 250 MB.
echo Normal desktop builds never download or select a newer runtime automatically.
echo.
node.exe scripts\release\setup-webview2-runtime.mjs %*
set "EXIT_CODE=%ERRORLEVEL%"

:finish
if defined ROOT_ENTERED popd >nul
echo.
if "%EXIT_CODE%"=="0" (echo [OK] WebView2 runtime preparation completed.) else echo [ERROR] WebView2 runtime preparation exited with code %EXIT_CODE%.
if not "%ZICHAN_NO_PAUSE%"=="1" pause
endlocal & exit /b %EXIT_CODE%
