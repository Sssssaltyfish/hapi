#!/usr/bin/env bash
set -euo pipefail
probe_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prior=/mnt/c/Users/Igna/codex-temp/hapi-deployment/interaction-improvements-20261031/browser-validation
export LD_LIBRARY_PATH="$prior/runtime-libs/extracted/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_FILE="${HAPI_FONTCONFIG:-$prior/fonts.conf}"
exec /home/igna/hapi-deployment/build-tools/bun/bin/bun "$probe_dir/browser.ts"
