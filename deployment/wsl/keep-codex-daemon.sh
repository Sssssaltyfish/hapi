#!/bin/bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_env="${CODEX_DAEMON_ENV:-$script_dir/service-env.sh}"
if [[ -n ${CODEX_DAEMON_ENV:-} || -f "$service_env" ]]; then
    [[ "$service_env" = /* ]] || service_env="$PWD/$service_env"
    source "$service_env"
fi

if ! codex=$(type -P -- "${CODEX_BIN:-codex}"); then
    printf 'Cannot find Codex CLI: %s\n' "${CODEX_BIN:-codex}" >&2
    exit 1
fi

while true; do
    # A successful version probe requires a response from the control socket.
    if ! /usr/bin/timeout --foreground 15s "$codex" app-server daemon version >/dev/null 2>&1; then
        # The CLI serializes start and reuses any daemon that became ready.
        if ! /usr/bin/timeout --foreground 120s "$codex" app-server daemon start; then
            printf '%s\n' 'Managed Codex daemon did not start. Retrying in 30 seconds.' >&2
        fi
    fi
    /usr/bin/sleep 30
done
