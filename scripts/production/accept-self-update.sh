#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

[[ $# == 2 && ( "$1" == before || "$1" == after ) ]] || {
  echo 'Usage: accept-self-update.sh before|after EVIDENCE_JSON' >&2
  exit 2
}
command -v curl >/dev/null && command -v jq >/dev/null || {
  echo 'curl and jq are required for acceptance' >&2
  exit 2
}
export ZICHAN_RUNTIME_DIR="${ZICHAN_RUNTIME_DIR:-/opt/zichan/runtime}"
check_directory "$ZICHAN_STATE_DIR"
check_directory "$ZICHAN_BACKUP_DIR"
check_directory "$ZICHAN_RUNTIME_DIR"
evidence="$2"
[[ "$evidence" == /* && "$evidence" != "$ZICHAN_STATE_DIR/"* \
  && "$evidence" != "$ZICHAN_BACKUP_DIR/"* && "$evidence" != "$repo_root/"* ]] || {
  echo 'Evidence path must be absolute and outside state, backups and the Git checkout' >&2
  exit 2
}
base="${BASE_PATH:-}"
base="/${base#/}"
base="${base%/}"
health="$(curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:8787$base/api/health")"
ready="$(curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:8787$base/api/ready")"
echo "$health" | jq -e '.ok == true and (.version | test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")) and (.serverId | type == "string") and (.nodePublicKey | type == "string")' >/dev/null
echo "$ready" | jq -e '.ok == true and .database.ok == true' >/dev/null
server_id="$(cat "$ZICHAN_STATE_DIR/server/server-id")"
[[ "$(echo "$health" | jq -r .serverId)" == "$server_id" ]] || {
  echo 'Health endpoint and persistent server ID differ' >&2
  exit 1
}
runtime_target="$(readlink "$ZICHAN_RUNTIME_DIR/current")"
version="$(echo "$health" | jq -r .version)"
[[ "$runtime_target" == "releases/v$version" ]] || {
  echo 'Runtime version and health endpoint differ' >&2
  exit 1
}
secret_hash="$(sha256sum "$ZICHAN_STATE_DIR/server/server.secret" | cut -d ' ' -f 1)"
node_key_hash="$(sha256sum "$ZICHAN_STATE_DIR/server/node-signing.key" | cut -d ' ' -f 1)"
custody_hash="$(sha256sum "$ZICHAN_STATE_DIR/server/custody.key" | cut -d ' ' -f 1)"
if [[ "$1" == before ]]; then
  [[ ! -e "$evidence" ]] || { echo 'Baseline evidence already exists' >&2; exit 2; }
  jq -n --arg version "$version" --arg serverId "$server_id" \
    --arg nodePublicKey "$(echo "$health" | jq -r .nodePublicKey)" \
    --arg secretHash "$secret_hash" --arg nodeKeyHash "$node_key_hash" \
    --arg custodyHash "$custody_hash" --arg runtimeTarget "$runtime_target" \
    --argjson claimed "$(echo "$health" | jq .claimed)" \
    '{version:$version,serverId:$serverId,nodePublicKey:$nodePublicKey,secretHash:$secretHash,nodeKeyHash:$nodeKeyHash,custodyHash:$custodyHash,runtimeTarget:$runtimeTarget,claimed:$claimed}' > "$evidence"
  chmod 600 "$evidence"
  printf 'Baseline captured: %s (%s)\n' "$version" "$server_id"
  exit 0
fi
[[ -f "$evidence" ]] || { echo 'Baseline evidence is missing' >&2; exit 2; }
jq -e --arg serverId "$server_id" --arg nodePublicKey "$(echo "$health" | jq -r .nodePublicKey)" \
  --arg secretHash "$secret_hash" --arg nodeKeyHash "$node_key_hash" --arg custodyHash "$custody_hash" \
  --argjson claimed "$(echo "$health" | jq .claimed)" \
  '.serverId == $serverId and .nodePublicKey == $nodePublicKey and .secretHash == $secretHash and .nodeKeyHash == $nodeKeyHash and .custodyHash == $custodyHash and .claimed == $claimed' "$evidence" >/dev/null || {
  echo 'Persistent identity or claimed status changed during update' >&2
  exit 1
}
old_version="$(jq -r .version "$evidence")"
[[ "$version" != "$old_version" ]] || { echo 'Version did not change' >&2; exit 1; }
result="$ZICHAN_RUNTIME_DIR/update-result.json"
[[ -f "$result" ]] || { echo 'Update result is missing' >&2; exit 1; }
task_id="$(jq -r .taskId "$result")"
[[ "$task_id" =~ ^[a-f0-9-]{36}$ ]] || { echo 'Update task ID is invalid' >&2; exit 1; }
backup="$ZICHAN_BACKUP_DIR/pre-update-$task_id"
jq -e --arg version "$version" --arg backup "$backup" \
  '.state == "success" and .operation == "update" and .version == $version and .backupPath == $backup' "$result" >/dev/null || {
  echo 'Update result does not match the running version and pre-update backup' >&2
  exit 1
}
verify_image
verify_backup "$backup"
[[ "$(cat "$backup/server-id")" == "$server_id" ]] || {
  echo 'Pre-update backup belongs to another server identity' >&2
  exit 1
}
printf 'Cross-version update accepted: %s -> %s; backup verified: %s\n' "$old_version" "$version" "$backup"
