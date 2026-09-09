@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "EXIT_CODE=1"
pushd "%~dp0..\.." >nul
if errorlevel 1 goto :finish
set "ROOT_ENTERED=1"
call "%~dp0_check-environment.cmd"
if errorlevel 1 goto :finish
if "%ZICHAN_CHECK_ONLY%"=="1" (
  node.exe scripts\dev\runner.mjs start all --check
) else (
  node.exe scripts\dev\runner.mjs start all %*
)
set "EXIT_CODE=%ERRORLEVEL%"
:finish
if defined ROOT_ENTERED popd >nul
if not "%EXIT_CODE%"=="0" echo [ERROR] Launcher exited with code %EXIT_CODE%.
if not "%ZICHAN_NO_PAUSE%"=="1" pause
endlocal & exit /b %EXIT_CODE%
