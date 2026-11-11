#!/bin/bash
set -eu

codex="$HOME/.local/bin/codex"
proxy_setup="$HOME/.config/wsl-proxy.sh"
export PATH="$HOME/.nvm/current/bin:$HOME/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"

while true; do
    # A successful version probe requires a response from the control socket.
    if ! /usr/bin/timeout --foreground 15s "$codex" app-server daemon version >/dev/null 2>&1; then
        if [[ -r "$proxy_setup" ]]; then
            source "$proxy_setup"
        fi
        # The CLI serializes start and reuses any daemon that became ready.
        if ! /usr/bin/timeout --foreground 120s "$codex" app-server daemon start; then
            printf '%s\n' 'Managed Codex daemon did not start. Retrying in 30 seconds.' >&2
        fi
    fi
    /usr/bin/sleep 30
done
