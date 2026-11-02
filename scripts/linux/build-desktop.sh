#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'The Linux desktop release must be built on Linux x86_64.' >&2
  exit 1
fi

expected_node="$(tr -d '\r\n' < .node-version)"
actual_node="$(node -p 'process.versions.node')"
if [[ "$actual_node" != "$expected_node" ]]; then
  echo "Node.js $expected_node is required; found $actual_node." >&2
  exit 1
fi

npm run release:check
npm run test:release
npm run typecheck
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml

export ZICHAN_RELEASE_BUILD=1
update_config=()
if [[ "${ZICHAN_UPDATE_TEST:-0}" == 1 ]]; then
  : "${TAURI_SIGNING_PRIVATE_KEY_PATH:?Set TAURI_SIGNING_PRIVATE_KEY_PATH for the final AppImage signature}"
  export TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY_PATH"
  update_config=(--config src-tauri/tauri.update-test.conf.json)
fi
npm run build --workspace @zichan/desktop -- \
  --config src-tauri/tauri.linux-release.conf.json \
  "${update_config[@]}" \
  --bundles deb appimage --ci -- --locked
node scripts/linux/finalize-appimage.mjs
if [[ "${ZICHAN_UPDATE_TEST:-0}" == 1 ]]; then
  shopt -s nullglob
  appimages=(apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage)
  if [[ "${#appimages[@]}" -ne 1 ]]; then
    echo 'Expected one finalized AppImage for updater signing.' >&2
    exit 1
  fi
  npx tauri signer sign --private-key-path "$TAURI_SIGNING_PRIVATE_KEY_PATH" \
    --password "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" "${appimages[0]}"
fi
node scripts/release/verify-linux-artifacts.mjs
