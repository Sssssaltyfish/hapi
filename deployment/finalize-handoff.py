"""Publish the current, sealed service handoff from WSL into the Windows workspace."""

from datetime import datetime, timezone
import fcntl
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def publish():
    workspace = Path(__file__).resolve().parents[1]
    name = 'service-deployment-handoff'
    source = workspace / 'dsh-web-shell-kit-20261027'
    sums = 'SHA256SUMS.txt'
    stamp = 'PACKAGED_AT.txt'
    destination = workspace / (name + '.7z')

    # Only publish files in the release's sealed manifest.
    with tempfile.TemporaryDirectory(dir=workspace, prefix='.handoff-publish-') as tmp:
        staging = Path(tmp)
        package = staging / name
        package.mkdir()
        checksums = []
        for line in (source / sums).read_text().splitlines():
            expected, sep, relative = line.partition('  ')
            path = Path(relative)
            if (not sep or not re.fullmatch('[a-f0-9]{64}', expected) or path.is_absolute()
                    or '..' in path.parts or not path.parts or relative == sums):
                raise ValueError(f'Invalid handoff manifest entry: {line}')
            if relative == stamp:
                continue
            original = source / path
            if not original.resolve().is_relative_to(source) or original.is_symlink():
                raise ValueError(f'Invalid handoff source: {relative}')
            content = original.read_bytes()
            if hashlib.sha256(content).hexdigest() != expected:
                raise ValueError(f'Seal the updated handoff before publishing: {relative}')
            member = package / path
            member.parent.mkdir(parents=True, exist_ok=True)
            member.write_bytes(content)
            checksums.append(line)

        timestamp = datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
        stamp_bytes = (timestamp + '\n').encode('ascii')
        (package / stamp).write_bytes(stamp_bytes)
        checksums.append(f'{hashlib.sha256(stamp_bytes).hexdigest()}  {stamp}')
        (package / sums).write_text('\n'.join(checksums) + '\n')

        candidates = []
        for method in ('PPMd', 'LZMA2'):
            candidate = staging / (method + '.7z')
            subprocess.run(['7z', 'a', '-t7z', '-mx=9', '-ms=on', '-mqs=on', '-mmt=1',
                            '-m0=' + method, str(candidate), name], cwd=staging,
                           check=True, stdout=subprocess.DEVNULL)
            print(f'{method}: {candidate.stat().st_size:,} bytes')
            candidates.append(candidate)

        smallest = min(candidates, key=lambda file: file.stat().st_size)
        checksum = hashlib.sha256(smallest.read_bytes()).hexdigest()
        sidecar = staging / 'archive.sha256'
        sidecar.write_text(f'{checksum}  {destination.name}\n')
        smallest.replace(destination)
        sidecar.replace(destination.with_suffix('.7z.sha256'))
        print(f'{destination.name}  {timestamp}  {checksum}')


if __name__ == '__main__':
    # Serialize releases through this entry point, including the checksum swap.
    with open(__file__, 'rb') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        publish()
