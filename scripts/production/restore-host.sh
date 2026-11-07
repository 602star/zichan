#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

[[ $# == 2 ]] || { echo 'Usage: restore-host.sh RESTIC_SNAPSHOT_ID ORIGINAL_ABSOLUTE_BACKUP_PATH' >&2; exit 2; }
: "${RESTIC_REPOSITORY:?}"
: "${RESTIC_PASSWORD_FILE:?}"
check_restic_password
snapshot="$1"
original="$2"
[[ "$snapshot" =~ ^[a-f0-9]{8,64}$ && "$original" == /* && "$original" != *..* ]] || {
  echo 'Invalid snapshot or backup path' >&2; exit 2
}
check_legacy_layout
check_directory "$ZICHAN_DATA_DIR"
check_directory "$ZICHAN_DATA_DIR/server"
check_directory "$ZICHAN_BACKUP_DIR"
check_directory "$ZICHAN_RUNTIME_DIR"
[[ -z "$(find "$ZICHAN_DATA_DIR/server" -mindepth 1 -print -quit)" ]] || {
  echo 'Restore target state must be empty; isolate the original node and use a blank directory' >&2
  exit 2
}
verify_image
staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT
restic restore "$snapshot" --target "$staging" --include "$original"
backup="$staging$original"
[[ -f "$backup/manifest.json" ]] || { echo 'Snapshot does not contain the requested backup' >&2; exit 1; }
chown -R 1000:1000 "$staging"
verify_backup "$backup"
saved_backup="$ZICHAN_BACKUP_DIR/$(basename "$backup")"
[[ ! -e "$saved_backup" && ! -L "$saved_backup" ]] || {
  echo 'Recovered backup record already exists in ZICHAN_BACKUP_DIR' >&2
  exit 2
}
cp -a -- "$backup" "$saved_backup"
verify_backup "$saved_backup"
expected_id="$(cat "$backup/server-id")"
docker run --rm --network none --user 1000:1000 \
  --mount "type=bind,src=$ZICHAN_DATA_DIR,dst=/state" \
  --mount "type=bind,src=$backup,dst=/backup,readonly" \
  --entrypoint node "$ZICHAN_IMAGE" \
  dist/maintenance.mjs restore --data-dir /state/server --backup /backup
[[ "$(cat "$ZICHAN_STATE_DIR/server/server-id")" == "$expected_id" ]] || {
  echo 'Restored server identity differs from the backup' >&2; exit 1
}
printf 'Offline restore verified for server ID %s. Set ZICHAN_BASELINE_BACKUP=%s before deploy; start only after isolating the original node.\n' "$expected_id" "$saved_backup"
