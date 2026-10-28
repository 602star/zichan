#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

check_directory "$ZICHAN_BACKUP_DIR"
state_dir="${ZICHAN_TRANSPORT_STATE_DIR:-/var/lib/zichan/backup-transport}"
install -d -m 700 "$state_dir"
exec 9>"$state_dir/ship.lock"
flock -n 9 || { echo 'Backup transport is already running' >&2; exit 2; }
latest="$(find "$ZICHAN_BACKUP_DIR" -mindepth 2 -maxdepth 2 -type f -name manifest.json -printf '%T@ %h\n' | sort -nr | sed -n '1p' | cut -d ' ' -f 2-)"
[[ -n "$latest" ]] || { echo 'No completed backup found' >&2; exit 2; }
if [[ -f "$state_dir/last" && "$(cat "$state_dir/last")" == "$latest" ]]; then
  printf 'Already transferred: %s\n' "$latest"
  exit 0
fi
bash "$(dirname "$0")/ship-backup.sh" "$latest"
printf '%s\n' "$latest" > "$state_dir/last.tmp"
mv -- "$state_dir/last.tmp" "$state_dir/last"
