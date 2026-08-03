@echo off
REM 一键关闭 zichan。双击清理 web+server；命令行可传 web/sync/server/desktop/all。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-stop.ps1" %*
