"""Back up Termix after its graceful shutdown persists the in-memory database."""

from contextlib import closing
import datetime
import fcntl
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import uuid


def resume_marker():
    invocation = os.environ.get('INVOCATION_ID')
    identifier = uuid.UUID(invocation) if invocation else uuid.uuid4()
    return Path(os.environ['XDG_RUNTIME_DIR']) / f'seia-termix-backup-{identifier.hex}.resume'


def resume_termix(marker):
    if marker.exists():
        # Queue the start even when called from the backup unit's stop job.
        subprocess.run(['systemctl', '--user', 'start', '--no-block', 'termix.service'], check=True)
        marker.unlink()


def write_archive(root, destination, shared):
    target = destination / f'termix-{datetime.datetime.now():%Y%m%d-%H%M%S}.tgz'
    required = {'data/.env'}

    with tempfile.TemporaryDirectory(dir=destination, prefix='.termix-backup-') as temporary:
        pending = Path(temporary) / target.name
        with tarfile.open(pending, 'w:gz') as archive:
            archive.add(root / 'data', arcname='data')
            if shared is not None:
                snapshot = Path(temporary) / 'passkeys.sqlite'
                with closing(sqlite3.connect(f'{shared.as_uri()}?mode=ro', uri=True)) as source:
                    with closing(sqlite3.connect(snapshot)) as backup:
                        source.backup(backup)
                archive.add(snapshot, arcname='shared-auth/passkeys.sqlite')
                required.add('shared-auth/passkeys.sqlite')

        pending.chmod(0o600)
        with tarfile.open(pending, 'r:gz') as archive:
            if not required.issubset(archive.getnames()):
                raise RuntimeError('Termix backup is missing required files')
        pending.replace(target)

    for old in sorted(destination.glob('termix-*.tgz'), reverse=True)[7:]:
        old.unlink()
    print('Backup verified:', target.name)


def backup_termix(marker):
    configured_root = os.environ.get('TERMIX_ROOT')
    if not configured_root:
        raise SystemExit('Set TERMIX_ROOT to the Termix deployment directory.')
    root = Path(configured_root).expanduser().resolve()
    shared_db = os.environ.get('TERMIX_SHARED_AUTH_DB')
    shared = Path(shared_db).expanduser().resolve() if shared_db else None
    destination = root / 'backups'
    destination.mkdir(exist_ok=True, mode=0o700)

    with (root / 'backup.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = subprocess.check_output(
            ['systemctl', '--user', 'show', '--property=ActiveState', '--value', 'termix.service'],
            text=True,
        ).strip()
        running = state in {'active', 'activating', 'reloading', 'refreshing'}
        if not running and state not in {'inactive', 'failed'}:
            raise RuntimeError(f'Termix is changing state ({state}). Retry the backup when it is stable.')
        try:
            if running:
                marker.touch(mode=0o600, exist_ok=False)
                subprocess.run(['systemctl', '--user', 'stop', 'termix.service'], check=True)
            write_archive(root, destination, shared)
        finally:
            resume_termix(marker)


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


if __name__ == '__main__':
    marker = resume_marker()
    if sys.argv[1:] == ['--resume']:
        resume_termix(marker)
    elif not sys.argv[1:]:
        signal.signal(signal.SIGTERM, interrupted)
        backup_termix(marker)
    else:
        raise SystemExit('Usage: backup-termix.py [--resume]')
