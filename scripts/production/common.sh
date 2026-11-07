#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/compose.yml"
if [[ -n "${ZICHAN_STATE_DIR:-}${ZICHAN_BACKUP_DIR:-}${ZICHAN_RUNTIME_DIR:-}" ]]; then
  echo 'Legacy directory variables are unsupported. Migrate to one ZICHAN_DATA_DIR first.' >&2
  exit 2
fi
export ZICHAN_DATA_DIR="${ZICHAN_DATA_DIR:-/opt/zichan/data}"
[[ "$ZICHAN_DATA_DIR" == /* && "$ZICHAN_DATA_DIR" != / && "$ZICHAN_DATA_DIR" != */ && "$ZICHAN_DATA_DIR" != *'/../'* ]] || {
  echo 'ZICHAN_DATA_DIR must be a dedicated absolute directory' >&2
  exit 2
}
ZICHAN_STATE_DIR="$ZICHAN_DATA_DIR"
ZICHAN_BACKUP_DIR="$ZICHAN_DATA_DIR/backups"
ZICHAN_RUNTIME_DIR="$ZICHAN_DATA_DIR/runtime"

check_legacy_layout() {
  if [[ "$ZICHAN_DATA_DIR" == /opt/zichan/data && ! -f "$ZICHAN_DATA_DIR/server/server-id" ]] &&
    { [[ -n "$(find /opt/zichan/state -mindepth 1 -print -quit 2>/dev/null)" ]] || [[ -n "$(find /opt/zichan/runtime -mindepth 1 -print -quit 2>/dev/null)" ]] || [[ -n "$(find /opt/zichan/backups -mindepth 1 -print -quit 2>/dev/null)" ]]; }; then
    echo 'Legacy /opt/zichan/{state,backups,runtime} data exists. Migrate it before using /opt/zichan/data.' >&2
    exit 2
  fi
}

check_data_not_used_by_other_project() {
  local container project mounted_path
  for container in $(docker ps -q); do
    project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
    [[ "$project" == zichan-prod ]] && continue
    while IFS= read -r mounted_path; do
      if [[ "$mounted_path" == "$ZICHAN_DATA_DIR" ]]; then
        echo "Data directory is mounted by another running container ($container, project $project); stop it before deploying" >&2
        exit 2
      fi
    done < <(docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$container")
  done
}

require_image() {
  [[ "${ZICHAN_IMAGE:-}" =~ ^ghcr\.io/602star/zichan-sync@sha256:[a-f0-9]{64}$ ]] || {
    echo 'ZICHAN_IMAGE must be the signed ghcr.io/602star/zichan-sync digest' >&2
    exit 2
  }
}

verify_image() {
  require_image
  command -v cosign >/dev/null || { echo 'cosign is required' >&2; exit 2; }
  cosign verify "$ZICHAN_IMAGE" \
    --certificate-identity-regexp '^https://github\.com/602star/zichan/\.github/workflows/sync-server-image\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$' \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' >/dev/null
  if ! docker image inspect "$ZICHAN_IMAGE" >/dev/null 2>&1; then
    docker pull "$ZICHAN_IMAGE"
  fi
  [[ "$(docker image inspect --format '{{.Architecture}}' "$ZICHAN_IMAGE")" == amd64 ]] || {
    echo 'Image is not linux/amd64' >&2
    exit 2
  }
}

check_directory() {
  local path="$1"
  [[ "$path" == /* && -d "$path" && ! -L "$path" ]] || {
    echo "Directory missing, relative or symlink: $path" >&2
    exit 2
  }
  [[ "$(stat -c %u "$path")" == 1000 ]] || {
    echo "Directory must be owned by container uid 1000: $path" >&2
    exit 2
  }
}

check_restic_password() {
  [[ -f "${RESTIC_PASSWORD_FILE:-}" && -r "$RESTIC_PASSWORD_FILE" ]] || {
    echo 'Restic password file is missing or unreadable' >&2
    exit 2
  }
  local password_path
  password_path="$(realpath -- "$RESTIC_PASSWORD_FILE")"
  case "$password_path" in
    "$ZICHAN_DATA_DIR"/*|"$repo_root"/*)
      echo 'Restic password file must be outside state, backups and Git checkout' >&2
      exit 2
      ;;
  esac
  [[ -z "$(find "$password_path" -perm /077 -print -quit)" ]] || {
    echo 'Restic password file must not be accessible to group or other users' >&2
    exit 2
  }
}

verify_backup() {
  local backup="$1" scratch
  scratch="$(mktemp -d)"
  chown 1000:1000 "$scratch"
  chmod 700 "$scratch"
  if ! docker run --rm --network none --user 1000:1000 \
    --mount "type=bind,src=$backup,dst=/backup,readonly" \
    --mount "type=bind,src=$scratch,dst=/record" \
    --entrypoint node "$ZICHAN_IMAGE" \
    dist/maintenance.mjs verify-backup --data-dir /record --backup /backup --record-id transport-check; then
    rm -rf -- "$scratch"
    return 1
  fi
  rm -rf -- "$scratch"
}
