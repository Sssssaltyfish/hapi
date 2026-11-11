#!/bin/bash
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
lib_dir="$HOME/.local/lib/seia-wsl"

install -d "$lib_dir" "$unit_dir/dsh-web.service.d"
install -m 0644 "$source_dir/keep-codex-daemon.sh" "$source_dir/check-dsh-readiness.py" "$lib_dir/"
install -m 0644 "$source_dir/seia-codex-daemon.service" "$unit_dir/"
install -m 0644 "$source_dir/dsh-web-recovery.conf" "$unit_dir/dsh-web.service.d/recovery.conf"
if [[ -d "$HOME/termix-deployment" ]]; then
    install -m 0600 "$source_dir/backup-termix.py" "$HOME/termix-deployment/backup.py"
    install -m 0644 "$source_dir/termix-backup.service" "$source_dir/termix-backup.timer" "$unit_dir/"
fi

systemctl --user daemon-reload
systemctl --user enable --now seia-codex-daemon.service
