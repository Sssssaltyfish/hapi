#!/bin/bash
set -eu

usage() {
    printf 'Usage: %s [--codex] [--dsh] [--termix]\n' "${0##*/}"
}

if [[ $# -eq 0 ]]; then
    usage >&2
    exit 2
fi

codex=0
dsh=0
termix=0
for component in "$@"; do
    case "$component" in
        --codex) codex=1 ;;
        --dsh) dsh=1 ;;
        --termix) termix=1 ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Unknown recovery component: %s\n' "$component" >&2; usage >&2; exit 2 ;;
    esac
done

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
lib_dir="$HOME/.local/lib/seia-wsl"

install -d "$lib_dir" "$unit_dir"
if (( codex )); then
    install -m 0644 "$source_dir/keep-codex-daemon.sh" "$lib_dir/"
    install -m 0644 "$source_dir/seia-codex-daemon.service" "$unit_dir/"
fi
if (( dsh )); then
    install -d "$unit_dir/dsh-web.service.d"
    install -m 0644 "$source_dir/check-dsh-readiness.py" "$lib_dir/"
    install -m 0644 "$source_dir/dsh-web-recovery.conf" "$unit_dir/dsh-web.service.d/recovery.conf"
fi
if (( termix )); then
    install -m 0644 "$source_dir/backup-termix.py" "$lib_dir/"
    install -m 0644 "$source_dir/termix-backup.service" "$source_dir/termix-backup.timer" "$unit_dir/"
fi

systemctl --user daemon-reload
if (( codex )); then
    systemctl --user enable --now seia-codex-daemon.service
fi
