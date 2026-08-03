#!/usr/bin/env bash
# 一键启动 zichan（POSIX：WSL / Git Bash / macOS / Linux）。
# 用法：bash scripts/dev-start.sh [web|sync|server|desktop|all]
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-web}"
case "$MODE" in
  web|sync|server|desktop|all) ;;
  *) echo "未知模式：$MODE (可用：web, sync, server, desktop, all)" >&2; exit 2 ;;
esac

ports_for_mode() {
  case "$MODE" in
    web|desktop) echo "5173" ;;
    sync|server) echo "8787" ;;
    all) echo "5173 8787" ;;
  esac
}

kill_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$port" | xargs -r kill 2>/dev/null || true
  fi
}

cleanup() {
  echo ""
  echo "■ 正在停止并清理端口 $(ports_for_mode) ..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for port in $(ports_for_mode); do kill_port "$port"; done
}
trap cleanup EXIT INT TERM

[[ -d node_modules ]] || npm install
for port in $(ports_for_mode); do kill_port "$port"; done

PIDS=()
echo "▶ zichan 启动模式：$MODE"
case "$MODE" in
  web)
    echo "  Web -> http://localhost:5173"
    npm run dev --workspace @zichan/web &
    PIDS+=("$!")
    ;;
  sync)
    echo "  Sync API -> http://localhost:8787/api/health"
    npm start --workspace @zichan/sync-server &
    PIDS+=("$!")
    ;;
  server)
    echo "  Desktop all-in-one server -> http://localhost:8787"
    npm run server --workspace @zichan/desktop &
    PIDS+=("$!")
    ;;
  desktop)
    echo "  Tauri desktop -> native window + http://localhost:5173"
    npm run dev --workspace @zichan/desktop &
    PIDS+=("$!")
    ;;
  all)
    echo "  Web -> http://localhost:5173"
    npm run dev --workspace @zichan/web &
    PIDS+=("$!")
    echo "  Desktop all-in-one server -> http://localhost:8787"
    npm run server --workspace @zichan/desktop &
    PIDS+=("$!")
    ;;
esac

while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      exit 0
    fi
  done
  sleep 1
done
