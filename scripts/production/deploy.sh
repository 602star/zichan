#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

check_directory "$ZICHAN_STATE_DIR"
check_directory "$ZICHAN_BACKUP_DIR"
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
verify_image
docker run --rm --network none --user 1000:1000 \
  --mount "type=bind,src=$ZICHAN_STATE_DIR,dst=/state" \
  --mount "type=bind,src=$ZICHAN_BACKUP_DIR,dst=/backups" \
  --entrypoint sh "$ZICHAN_IMAGE" -c 'test -w /state && test -w /backups'
docker compose -f "$compose_file" config --quiet
docker compose -f "$compose_file" up -d --no-build --wait --wait-timeout 180
new_id="$(cat "$ZICHAN_STATE_DIR/server/server-id")"
new_key="$(sha256sum "$ZICHAN_STATE_DIR/server/server.secret" | cut -d ' ' -f 1)"
[[ -n "$new_id" && -n "$new_key" ]] || { echo 'Server identity is incomplete' >&2; exit 1; }
[[ -z "$old_id" || "$old_id" == "$new_id" ]] || { echo 'Server identity changed' >&2; exit 1; }
[[ -z "$old_key" || "$old_key" == "$new_key" ]] || { echo 'Server secret changed' >&2; exit 1; }
printf 'Healthy image: %s\nServer ID: %s\n' "$ZICHAN_IMAGE" "$new_id"
