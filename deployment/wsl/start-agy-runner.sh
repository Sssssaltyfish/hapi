#!/bin/bash
set -e
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deployment=$(dirname -- "$script_dir")
service_env="${HAPI_SERVICE_ENV:-$script_dir/service-env.sh}"
if [[ -n ${HAPI_SERVICE_ENV:-} || -f "$service_env" ]]; then
    [[ "$service_env" = /* ]] || service_env="$PWD/$service_env"
    source "$service_env"
fi

export HAPI_API_URL="${HAPI_API_URL:-http://127.0.0.1:3006}"
export HAPI_RUNNER_SUPERVISED=1
unset HAPI_CODEX_EXTERNAL_ENDPOINT HAPI_CODEX_DISCOVERY HAPI_DISCOVERY_EXECUTABLE HAPI_DISCOVERY_WORKSPACE
export HAPI_CLI_EXECUTABLE="$deployment/cli-current/hapi"
exec "$HAPI_CLI_EXECUTABLE" "$@"
