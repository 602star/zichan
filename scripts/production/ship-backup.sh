#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

[[ $# == 1 ]] || { echo 'Usage: ship-backup.sh BACKUP_RECORD_DIRECTORY' >&2; exit 2; }
: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY to an independent encrypted backup target}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE outside the business host data and repository}"
check_restic_password
command -v restic >/dev/null || { echo 'restic is required' >&2; exit 2; }
check_directory "$ZICHAN_BACKUP_DIR"
record="$(realpath -- "$1")"
[[ "$record" == "$ZICHAN_BACKUP_DIR/"* && "$(dirname "$record")" == "$ZICHAN_BACKUP_DIR" && -f "$record/manifest.json" ]] || {
  echo 'Expected a completed backup directly below ZICHAN_BACKUP_DIR' >&2
  exit 2
}
verify_image
verify_backup "$record"
restic snapshots >/dev/null # The destination must already have been initialized.
restic backup --tag "zichan-$(basename "$record")" "$record"
restic check --read-data
printf 'Encrypted backup transferred and repository data verified: %s\n' "$record"
