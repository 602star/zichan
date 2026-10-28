#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/apps/sync-server/docker-compose.prod.yml"
export ZICHAN_STATE_DIR="${ZICHAN_STATE_DIR:-/srv/zichan/state}"
export ZICHAN_BACKUP_DIR="${ZICHAN_BACKUP_DIR:-/srv/zichan/backups}"

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
    --certificate-identity 'https://github.com/602star/zichan/.github/workflows/sync-server-image.yml@refs/heads/main' \
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
    "$ZICHAN_STATE_DIR"/*|"$ZICHAN_BACKUP_DIR"/*|"$repo_root"/*)
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
