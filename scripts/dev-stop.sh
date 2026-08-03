#!/usr/bin/env bash
# 一键关闭 zichan（POSIX）。用法：bash scripts/dev-stop.sh [web|sync|server|desktop|all]
set -euo pipefail
MODE="${1:-all}"

case "$MODE" in
  web|sync|server|desktop|all) ;;
  *) echo "未知模式：$MODE (可用：web, sync, server, desktop, all)" >&2; exit 2 ;;
esac

case "$MODE" in
  web|desktop) PORTS="5173" ;;
  sync|server) PORTS="8787" ;;
  all) PORTS="5173 8787" ;;
esac

stopped=0
for port in $PORTS; do
  if command -v fuser >/dev/null 2>&1; then
    if fuser -k "${port}/tcp" 2>/dev/null; then
      echo "已停止端口 $port。"
      stopped=1
    fi
  elif command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti tcp:"$port" || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill 2>/dev/null || true
      echo "已停止端口 $port。"
      stopped=1
    fi
  else
    echo "需要 fuser 或 lsof 来按端口清理。"
    exit 1
  fi
done

if [[ "$stopped" -eq 0 ]]; then
  echo "模式 $MODE 对应端口未在运行：$PORTS。"
fi
