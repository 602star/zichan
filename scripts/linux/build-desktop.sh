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
npm run build --workspace @zichan/desktop -- \
  --config src-tauri/tauri.linux-release.conf.json \
  --bundles deb appimage --ci -- --locked
node scripts/linux/finalize-appimage.mjs
node scripts/release/verify-linux-artifacts.mjs
