#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

[[ $# -gt 0 ]] || { echo 'Usage: with-maintenance-lock.sh COMMAND [ARG...]' >&2; exit 2; }
data="$ZICHAN_STATE_DIR/server"
check_directory "$ZICHAN_STATE_DIR"
[[ -d "$data" ]] || { echo 'Server data directory is missing' >&2; exit 2; }
lock="$data/maintenance.lock"
mkdir -m 700 -- "$lock" || { echo 'Maintenance lock is held or stale; inspect before retrying' >&2; exit 2; }
owner="host:$(hostname):$$:$(date -u +%s)"
printf '%s\n' "$owner" > "$lock/owner"
release() {
  if [[ "$(cat "$lock/owner" 2>/dev/null || true)" == "$owner" ]]; then
    rm -- "$lock/owner"
    rmdir -- "$lock"
  else
    echo 'Maintenance lock owner changed; leaving lock in place' >&2
  fi
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
state="$data/backup-executor.json"
[[ -f "$state" ]] || { echo 'Backup executor state missing; refusing maintenance' >&2; exit 2; }
status="$(jq -er '.status | strings' "$state")" || { echo 'Invalid backup executor state' >&2; exit 2; }
heartbeat="$(jq -er '.heartbeatAt | strings' "$state")" || { echo 'Invalid backup executor heartbeat' >&2; exit 2; }
case "$status" in
  disabled|waiting) ;;
  *) echo "Backup executor status $status blocks maintenance" >&2; exit 2 ;;
esac
now="$(date -u +%s)"
seen="$(date -u -d "$heartbeat" +%s)" || { echo 'Invalid backup executor heartbeat time' >&2; exit 2; }
(( now - seen >= 0 && now - seen <= 30 )) || { echo 'Backup executor heartbeat is stale' >&2; exit 2; }
"$@"
