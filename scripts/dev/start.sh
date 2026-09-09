#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mode="${1:-server}"
if [[ $# -gt 0 ]]; then shift; fi
exec node scripts/dev/runner.mjs start "$mode" "$@"
