#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

release="${1:-}"
if [[ ! "$release" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Usage: bash scripts/production/install-docker.sh v<version>' >&2
  exit 2
fi
if (( EUID != 0 )); then
  echo 'Run this first-install command with sudo' >&2
  exit 2
fi

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 2; }
command -v docker >/dev/null || { echo 'Docker is required' >&2; exit 2; }
command -v cosign >/dev/null || { echo 'Cosign is required' >&2; exit 2; }
docker compose version >/dev/null || { echo 'Docker Compose v2 is required' >&2; exit 2; }

if [[ -n "${ZICHAN_IMAGE:-}" ]]; then
  echo 'ZICHAN_IMAGE is set; use deploy.sh for an existing or custom deployment' >&2
  exit 2
fi
check_legacy_layout

if [[ -d "$ZICHAN_DATA_DIR" && -n "$(find "$ZICHAN_DATA_DIR" -mindepth 1 -print -quit)" ]]; then
  echo "Existing data found at $ZICHAN_DATA_DIR; use deploy.sh and preserve its identity" >&2
  exit 2
fi
if [[ -n "$(docker ps -aq --filter label=com.docker.compose.project=zichan-prod)" ]]; then
  echo 'An existing production container was found; use deploy.sh' >&2
  exit 2
fi

digest_file="$(mktemp)"
trap 'rm -f -- "$digest_file"' EXIT
curl --fail --location --silent --show-error --retry 3 \
  "https://github.com/602star/zichan/releases/download/$release/image-digest.txt" \
  --output "$digest_file"
export ZICHAN_IMAGE="$(tr -d '\r\n' < "$digest_file")"
require_image

install -d -m 700 -o 1000 -g 1000 \
  "$ZICHAN_DATA_DIR" "$ZICHAN_DATA_DIR/server" "$ZICHAN_BACKUP_DIR" "$ZICHAN_RUNTIME_DIR"
export ZICHAN_ALLOW_FIRST_BOOT=yes
bash "$repo_root/scripts/production/deploy.sh"

printf 'Open http://<server-LAN-IP>:8787/admin/ to create the administrator.\n'
