#!/usr/bin/env bash
set -euo pipefail
probe_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prior=/mnt/c/Users/Igna/codex-temp/hapi-deployment/interaction-improvements-20261031/browser-validation
export LD_LIBRARY_PATH="$prior/runtime-libs/extracted/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Use Linux system fonts for performance diagnosis. Set HAPI_PROBE_FONTCONFIG
# explicitly to reproduce the historical Windows-font appearance environment.
export FONTCONFIG_FILE="${HAPI_PROBE_FONTCONFIG:-/etc/fonts/fonts.conf}"
script=group-expand.ts
if [[ ${1:-} == running ]]; then script=running-group.ts; fi
exec /home/igna/hapi-deployment/build-tools/bun/bin/bun "$probe_dir/$script"
