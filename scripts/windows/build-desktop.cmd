@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Build Zichan Windows Portable

set "EXIT_CODE=1"
pushd "%~dp0..\.." >nul
if errorlevel 1 (
  echo [ERROR] Could not enter the repository root.
  goto :finish
)
set "ROOT_ENTERED=1"

call "%~dp0_check-environment.cmd"
if errorlevel 1 goto :finish

for /f "delims=" %%A in ('node.exe -p "process.arch"') do set "NODE_ARCH=%%A"
if /i not "%NODE_ARCH%"=="x64" (
  echo [ERROR] The portable release is Windows x64 only, but Node.js reports %NODE_ARCH%.
  echo         Install and use an x64 Node.js runtime before building.
  goto :finish
)
echo [OK] Node.js architecture is x64.

set /p "RELEASE_NODE_VERSION="<".node-version"
for /f "delims=" %%V in ('node.exe -p "process.versions.node"') do set "ACTUAL_NODE_VERSION=%%V"
if not "%ACTUAL_NODE_VERSION%"=="%RELEASE_NODE_VERSION%" (
  echo [ERROR] Windows releases require Node.js %RELEASE_NODE_VERSION%, but PATH provides %ACTUAL_NODE_VERSION%.
  echo         Install the pinned version from .node-version before building.
  goto :finish
)
echo [OK] Release Node.js version is pinned to %RELEASE_NODE_VERSION%.

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
  echo [OK] Desktop-build launcher environment preflight passed.
  echo [INFO] Full builds also require the locked WebView2 runtime; run setup-webview2-runtime.cmd once.
  set "EXIT_CODE=0"
  goto :finish
)

echo.
echo Validating the locked WebView2 Fixed Version runtime...
node.exe scripts\release\setup-webview2-runtime.mjs --check
if errorlevel 1 (
  echo [ERROR] The pinned WebView2 runtime is not ready.
  echo         Run scripts\windows\setup-webview2-runtime.cmd once, then retry.
  goto :finish
)

echo.
echo Running portable release gates...
call npm.cmd run release:check
if errorlevel 1 goto :finish
call npm.cmd run test:release
if errorlevel 1 goto :finish
call npm.cmd run test:scripts
if errorlevel 1 goto :finish
call npm.cmd run build:server
if errorlevel 1 goto :finish
call npm.cmd run typecheck
if errorlevel 1 goto :finish
call npm.cmd test
if errorlevel 1 goto :finish

echo.
echo Building the desktop executable without MSI, NSIS, or updater bundles...
echo The first build may take a long time while Cargo compiles dependencies.
set "ZICHAN_BUILD_PREPARED=1"
set "ZICHAN_RELEASE_BUILD=1"
call npm.cmd run build --workspace @zichan/desktop -- --no-bundle --ci -- --locked
if errorlevel 1 goto :finish

if not exist "apps\desktop\src-tauri\target\release\zichan.exe" (
  echo [ERROR] Desktop executable was not generated: target\release\zichan.exe
  goto :finish
)

echo.
echo Creating the Windows x64 portable ZIP...
node.exe scripts\release\create-windows-portable.mjs
if errorlevel 1 goto :finish

set "EXIT_CODE=0"
echo.
echo [OK] Windows portable build completed.
echo Output directory: apps\desktop\src-tauri\target\release\portable
echo The verified ZIP and its .sha256 sidecar are in this directory.
echo The release contains no user data, MSI, NSIS, service, registry installer, or updater payload.

:finish
if defined ROOT_ENTERED popd >nul
echo.
if not "%EXIT_CODE%"=="0" echo [ERROR] Desktop portable build exited with code %EXIT_CODE%.
if not "%ZICHAN_NO_PAUSE%"=="1" pause
endlocal & exit /b %EXIT_CODE%
