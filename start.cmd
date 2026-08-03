@echo off
REM 一键启动 zichan。双击默认 Web；命令行可传 web/sync/server/desktop/all。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-start.ps1" %*
