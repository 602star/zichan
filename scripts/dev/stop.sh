#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node scripts/dev/runner.mjs stop "${1:-all}"
