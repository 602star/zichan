@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Build Zichan Desktop

set "EXIT_CODE=1"
pushd "%~dp0..\.." >nul
if errorlevel 1 (
  echo [ERROR] Could not enter the repository root.
  goto :finish
)
set "ROOT_ENTERED=1"

call "%~dp0_check-environment.cmd"
if errorlevel 1 goto :finish

cargo.exe --version >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo.exe was not found in PATH. Install the Rust toolchain first.
  goto :finish
)
rustc.exe --version >nul 2>nul
if errorlevel 1 (
  echo [ERROR] rustc.exe was not found in PATH. Install the Rust toolchain first.
  goto :finish
)
for /f "tokens=2" %%V in ('rustc.exe --version') do echo [OK] Rust %%V is available.

perl.exe -v >nul 2>nul
if errorlevel 1 (
  echo [ERROR] perl.exe was not found in PATH.
  echo         The vendored OpenSSL/SQLCipher release build requires Perl on Windows.
  echo         Install a Windows Perl distribution, then reopen this window.
  goto :finish
)
echo [OK] Perl is available.

if "%ZICHAN_CHECK_ONLY%"=="1" (
  echo [OK] Desktop-build launcher preflight passed.
  set "EXIT_CODE=0"
  goto :finish
)

echo.
echo Building Web, sync-server resources, desktop executable, MSI, and NSIS installer...
echo The first build may take a long time and may need network access for Rust dependencies.
echo Local installers are development artifacts; signed releases are produced by CI.
echo.
call npm.cmd run release:check
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Release consistency check failed before the desktop build.
  goto :finish
)

if exist "apps\desktop\src-tauri\target\release\bundle\msi\*.msi" (
  del /q "apps\desktop\src-tauri\target\release\bundle\msi\*.msi" >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Could not remove the previous MSI build output.
    goto :finish
  )
)
if exist "apps\desktop\src-tauri\target\release\bundle\nsis\*.exe" (
  del /q "apps\desktop\src-tauri\target\release\bundle\nsis\*.exe" >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Could not remove the previous NSIS build output.
    goto :finish
  )
)

call npm.cmd run build --workspace @zichan/desktop -- --ci
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :finish

if not exist "apps\desktop\src-tauri\target\release\zichan.exe" (
  echo [ERROR] Desktop executable was not generated: target\release\zichan.exe
  set "EXIT_CODE=1"
  goto :finish
)
dir /b "apps\desktop\src-tauri\target\release\bundle\msi\*.msi" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] MSI installer was not generated.
  set "EXIT_CODE=1"
  goto :finish
)
dir /b "apps\desktop\src-tauri\target\release\bundle\nsis\*.exe" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] NSIS installer was not generated.
  set "EXIT_CODE=1"
  goto :finish
)

echo.
echo [OK] Desktop build completed.
echo Executable: apps\desktop\src-tauri\target\release\zichan.exe
echo Installers: apps\desktop\src-tauri\target\release\bundle\msi and bundle\nsis

:finish
if defined ROOT_ENTERED popd >nul
echo.
if not "%EXIT_CODE%"=="0" echo [ERROR] Desktop build exited with code %EXIT_CODE%.
if not "%ZICHAN_NO_PAUSE%"=="1" pause
endlocal & exit /b %EXIT_CODE%
