#!/bin/bash
set -e
source /home/igna/.config/wsl-proxy.sh
export PATH=/home/igna/.nvm/current/bin:/home/igna/.local/bin:/usr/local/bin:/usr/bin:/bin
source /home/igna/.config/agy-cpa/path.sh
source /home/igna/.config/claude-cpa/hapi-env.sh
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
export HAPI_API_URL=http://127.0.0.1:3006
export HAPI_RUNNER_SUPERVISED=1
unset HAPI_CODEX_EXTERNAL_ENDPOINT HAPI_CODEX_DISCOVERY HAPI_DISCOVERY_EXECUTABLE HAPI_DISCOVERY_WORKSPACE
export HAPI_CLI_EXECUTABLE='/home/igna/hapi-deployment/cli-releases/20261106-7fdacc301eeb/hapi'
exec '/home/igna/hapi-deployment/cli-releases/20261106-7fdacc301eeb/hapi' "$@"
