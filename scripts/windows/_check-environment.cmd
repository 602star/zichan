@echo off
setlocal EnableExtensions

node.exe --version >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node.js 22.3 or newer, then reopen this window.
  exit /b 1
)

call npm.cmd --version >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd was not found in PATH.
  echo         Repair the Node.js installation, then reopen this window.
  exit /b 1
)

node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 3) ? 0 : 1)"
if errorlevel 1 (
  for /f "delims=" %%V in ('node.exe -p "process.versions.node"') do echo [ERROR] Node.js 22.3 or newer is required. Current: %%V
  exit /b 1
)

if not exist "%~dp0..\..\package.json" (
  echo [ERROR] Repository root could not be resolved from %~dp0
  exit /b 1
)

if not exist "%~dp0..\..\node_modules\" (
  echo [ERROR] Dependencies are not installed.
  echo         Run "npm install" once in the repository root.
  exit /b 1
)

for /f "delims=" %%V in ('node.exe -p "process.versions.node"') do echo [OK] Node.js %%V and npm are available.
exit /b 0
