#!/bin/bash
set -eu
deployment=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source /home/igna/.config/wsl-proxy.sh
export PATH="$deployment/build-tools/bun/bin:/home/igna/.nvm/current/bin:/home/igna/.local/bin:/usr/bin:/bin"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
export HAPI_PUBLIC_URL=https://seia.tailc9c975.ts.net:8444
export HAPI_PASSKEY_ORIGIN=https://seia.tailc9c975.ts.net:8444
cd "$deployment/current/hub"
exec bun run src/index.ts --no-relay
