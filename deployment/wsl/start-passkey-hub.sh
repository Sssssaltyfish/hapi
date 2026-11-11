#!/bin/bash
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deployment=$(dirname -- "$script_dir")
service_env="${HAPI_SERVICE_ENV:-$script_dir/service-env.sh}"
if [[ -n ${HAPI_SERVICE_ENV:-} || -f "$service_env" ]]; then
    [[ "$service_env" = /* ]] || service_env="$PWD/$service_env"
    source "$service_env"
fi

export PATH="$deployment/build-tools/bun/bin:$PATH"
cd "$deployment/current/hub"
exec bun run src/index.ts --no-relay
