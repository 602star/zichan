#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

check_directory "$ZICHAN_STATE_DIR"
check_directory "$ZICHAN_BACKUP_DIR"
export ZICHAN_RUNTIME_DIR="${ZICHAN_RUNTIME_DIR:-/srv/zichan/runtime}"
check_directory "$ZICHAN_RUNTIME_DIR"
if [[ -e "$ZICHAN_STATE_DIR/server/maintenance.lock" || -L "$ZICHAN_STATE_DIR/server/maintenance.lock" ]]; then
  echo 'Maintenance lock is held or stale; refusing deployment' >&2
  exit 2
fi
if [[ ! -f "$ZICHAN_STATE_DIR/server/server-id" ]]; then
  if [[ -n "$(find "$ZICHAN_STATE_DIR" -mindepth 1 -print -quit)" ]]; then
    echo 'Existing nonempty server state has no server-id; refusing to create a new identity' >&2
    exit 2
  fi
  if [[ "${ZICHAN_ALLOW_FIRST_BOOT:-}" != yes ]]; then
    echo 'Empty server state requires ZICHAN_ALLOW_FIRST_BOOT=yes for an intentional first boot' >&2
    exit 2
  fi
fi
if [[ -f "$ZICHAN_STATE_DIR/server/server-id" && ! -s "$ZICHAN_STATE_DIR/server/server.secret" ]]; then
  echo 'Existing server identity has no persistent server.secret' >&2
  exit 2
fi
old_id="$(cat "$ZICHAN_STATE_DIR/server/server-id" 2>/dev/null || true)"
old_key="$(sha256sum "$ZICHAN_STATE_DIR/server/server.secret" 2>/dev/null | cut -d ' ' -f 1 || true)"
old_node_key="$(sha256sum "$ZICHAN_STATE_DIR/server/node-signing.key" 2>/dev/null | cut -d ' ' -f 1 || true)"
if [[ -z "$old_id" && -n "$(find "$ZICHAN_RUNTIME_DIR" -mindepth 1 -print -quit)" ]]; then
  echo 'Existing update runtime with empty server state; refusing a new server identity' >&2
  exit 2
fi
verify_image
if [[ -n "$old_id" && -z "$(find "$ZICHAN_RUNTIME_DIR" -mindepth 1 -print -quit)" ]]; then
  : "${ZICHAN_BASELINE_BACKUP:?First self-update deployment requires a verified backup in ZICHAN_BACKUP_DIR}"
  baseline_backup="$(realpath -- "$ZICHAN_BASELINE_BACKUP")"
  [[ "$baseline_backup" == "$ZICHAN_BACKUP_DIR/"* \
    && "$(dirname "$baseline_backup")" == "$ZICHAN_BACKUP_DIR" \
    && -f "$baseline_backup/manifest.json" ]] || {
    echo 'Baseline backup must be a completed record directly below ZICHAN_BACKUP_DIR' >&2
    exit 2
  }
  verify_backup "$baseline_backup"
  [[ "$(cat "$baseline_backup/server-id")" == "$old_id" ]] || {
    echo 'Baseline backup belongs to another server identity' >&2
    exit 2
  }
fi
docker run --rm --network none --user 1000:1000 \
  --mount "type=bind,src=$ZICHAN_STATE_DIR,dst=/state" \
  --mount "type=bind,src=$ZICHAN_BACKUP_DIR,dst=/backups" \
  --mount "type=bind,src=$ZICHAN_RUNTIME_DIR,dst=/app/runtime" \
  --entrypoint sh "$ZICHAN_IMAGE" -c 'test -w /state && test -w /backups && test -w /app/runtime && test -s /keys/github-token && test -s /app/bootstrap/update-public.pem && test -s /app/bootstrap/update-launcher.mjs && test -s /app/bootstrap/pre-update-backup.mjs'
docker compose -f "$compose_file" config --quiet
if [[ -n "$(docker ps -q --filter label=com.docker.compose.project=zichan-prod)" ]]; then
  bash "$repo_root/scripts/production/with-maintenance-lock.sh" \
    docker compose -f "$compose_file" up -d --no-build --wait --wait-timeout 180
else
  docker compose -f "$compose_file" up -d --no-build --wait --wait-timeout 180
fi
new_id="$(cat "$ZICHAN_STATE_DIR/server/server-id")"
new_key="$(sha256sum "$ZICHAN_STATE_DIR/server/server.secret" | cut -d ' ' -f 1)"
new_node_key="$(sha256sum "$ZICHAN_STATE_DIR/server/node-signing.key" 2>/dev/null | cut -d ' ' -f 1 || true)"
[[ -n "$new_id" && -n "$new_key" ]] || { echo 'Server identity is incomplete' >&2; exit 1; }
[[ -z "$old_id" || "$old_id" == "$new_id" ]] || { echo 'Server identity changed' >&2; exit 1; }
[[ -z "$old_key" || "$old_key" == "$new_key" ]] || { echo 'Server secret changed' >&2; exit 1; }
[[ -z "$old_node_key" || "$old_node_key" == "$new_node_key" ]] || { echo 'Node signing key changed' >&2; exit 1; }
printf 'Healthy image: %s\nServer ID: %s\n' "$ZICHAN_IMAGE" "$new_id"
