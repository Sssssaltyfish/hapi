import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

OLD = Path('/home/igna/hapi-deployment')
ROOT = Path('/home/igna/.local/share/hapi')
COMMIT = '6a5341eef0130c1041bc8c3454cd336ce1611902'
RELEASE = ROOT / 'releases' / ('hub-' + COMMIT[:12])
TASK = Path(__file__).resolve().parent
OPS = TASK.parent / 'ops/deployment'
UNITS = Path('/home/igna/.config/systemd/user')
SERVICES = ['hapi-hub.service', 'hapi-runner.service', 'seia-auth.service']
RECEIPT = TASK / 'wsl-migration.json'

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def record(data):
    data['at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    RECEIPT.write_text(json.dumps(data, indent=2) + '\n')

def prepare():
    assert not ROOT.exists(), 'Target already exists'
    ROOT.mkdir(mode=0o700)
    RELEASE.mkdir(parents=True)
    git = ['/mnt/c/Program Files/Git/cmd/git.exe', '-C',
           'C:/Users/Igna/codex-temp/hapi-deployment/source', 'archive', COMMIT]
    archive = subprocess.Popen(git, stdout=subprocess.PIPE)
    try:
        run('tar', '-xf', '-', '-C', str(RELEASE), stdin=archive.stdout)
    finally:
        archive.stdout.close()
    assert archive.wait() == 0, 'Git export failed'
    (ROOT / 'current').symlink_to(RELEASE.relative_to(ROOT), target_is_directory=True)
    (ROOT / 'bin').mkdir()
    (ROOT / 'config').mkdir(mode=0o700)
    for name in ['start-passkey-hub.sh', 'start-agy-runner.sh']:
        shutil.copy2(OPS / 'wsl' / name, ROOT / 'bin' / name)
        (ROOT / 'bin' / name).chmod(0o700)
        run('bash', '-n', str(ROOT / 'bin' / name))
    shutil.copy2(OLD / 'shared-passkeys.env', ROOT / 'config/shared-passkeys.env')
    (ROOT / 'config/shared-passkeys.env').chmod(0o600)
    record({'phase': 'prepared', 'commit': COMMIT, 'target': str(ROOT)})

def switch():
    data = json.loads(RECEIPT.read_text())
    assert data['phase'] == 'prepared'
    unit_names = ['hapi-hub.service', 'hapi-runner.service', 'seia-auth.service',
                  'hapi-hub.service.d/passkeys.conf', 'hapi-runner.service.d/agy-cpa.conf',
                  'hapi-hub.service.d/shared-passkeys.conf']
    original = {name: (UNITS / name).read_text() for name in unit_names}
    (TASK / 'wsl-unit-originals.json').write_text(json.dumps(original, indent=2) + '\n')
    moves = [(OLD / 'build-tools', ROOT / 'build-tools'),
             (OLD / 'cli-releases', ROOT / 'cli-releases'),
             (OLD / 'source/node_modules', RELEASE / 'node_modules'),
             (OLD / 'source/web/dist', RELEASE / 'web/dist')]
    for module in ['hub', 'shared', 'cli', 'web', 'website', 'docs', 'relay']:
        path = OLD / 'source' / module / 'node_modules'
        if path.is_dir():
            moves.append((path, RELEASE / module / 'node_modules'))
    for src, dst in moves:
        assert src.exists() and not dst.exists(), (src, dst)
        assert src.resolve().is_relative_to(OLD) and dst.parent.resolve().is_relative_to(ROOT)
    moved = []
    try:
        run('systemctl', '--user', 'stop', *SERVICES)
        for src, dst in moves:
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dst)
            moved.append((src, dst))
        for name, content in original.items():
            if name in ['hapi-hub.service.d/passkeys.conf', 'hapi-runner.service.d/agy-cpa.conf']:
                (UNITS / name).unlink()
                continue
            if name == 'hapi-hub.service':
                content = content.replace('ExecStart=/home/igna/hapi-deployment/start-hapi.sh hub --no-relay',
                    f'WorkingDirectory={ROOT}/current/hub\nExecStart={ROOT}/bin/start-passkey-hub.sh')
            elif name == 'hapi-runner.service':
                content = content.replace('/home/igna/hapi-deployment/start-desktop-runner.sh',
                    str(ROOT / 'bin/start-agy-runner.sh'))
            elif name.endswith('shared-passkeys.conf'):
                content = content.replace(str(OLD / 'shared-passkeys.env'), str(ROOT / 'config/shared-passkeys.env'))
            else:
                content = content.replace(str(OLD / 'build-tools'), str(ROOT / 'build-tools'))
            (UNITS / name).write_text(content)
        run('systemctl', '--user', 'daemon-reload')
        run('systemctl', '--user', 'start', 'seia-auth.service', 'hapi-hub.service', 'hapi-runner.service')
        deadline = time.monotonic() + 60
        while True:
            try:
                with urllib.request.urlopen('http://127.0.0.1:3006/health', timeout=2) as response:
                    assert response.status == 200
                run('systemctl', '--user', 'is-active', '--quiet', *SERVICES)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)
        data.update(phase='ready', moved=[{'from': str(a), 'to': str(b)} for a, b in moved])
        data['services'] = subprocess.check_output(['systemctl', '--user', 'show', *SERVICES,
            '-p', 'Id', '-p', 'MainPID', '-p', 'ActiveState', '-p', 'ExecStart'], text=True)
        record(data)
        print(json.dumps({'phase': data['phase'], 'target': str(ROOT), 'moved': len(moved)}))
    except Exception as error:
        subprocess.run(['systemctl', '--user', 'stop', *SERVICES])
        for name, content in original.items():
            (UNITS / name).parent.mkdir(parents=True, exist_ok=True)
            (UNITS / name).write_text(content)
        for src, dst in reversed(moved):
            src.parent.mkdir(parents=True, exist_ok=True)
            dst.rename(src)
        subprocess.run(['systemctl', '--user', 'daemon-reload'])
        subprocess.run(['systemctl', '--user', 'start', *SERVICES])
        data.update(phase='rolled-back', error=str(error))
        record(data)
        raise

parser = argparse.ArgumentParser()
parser.add_argument('phase', choices=['prepare', 'switch'])
args = parser.parse_args()
globals()[args.phase]()
