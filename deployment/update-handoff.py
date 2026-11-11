"""Refresh portable deployment files in an existing sealed application handoff."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def update(kit, repo):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args])

    head = git('rev-parse', 'HEAD').decode().strip()
    seal = {}
    for line in (kit / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
        sha, separator, name = line.partition('  ')
        path = kit / name
        if not separator or not path.resolve().is_relative_to(kit) or path.is_symlink():
            raise ValueError('Invalid handoff manifest path')
        if digest(path.read_bytes()) != sha:
            raise ValueError(f'Unsealed handoff file: {name}')
        seal[name] = sha

    manifest = json.loads((kit / 'PATCH_MANIFEST.json').read_bytes())
    reference = json.loads((kit / 'WINDOWS_REFERENCE_MANIFEST.json').read_bytes())
    files = git('ls-tree', '-r', '--name-only', head, '--', 'deployment').decode().splitlines()
    outputs = {}
    sources = {}
    root_files = {
        'task-bootstrap.js', 'task-launcher.ps1', 'task-lifetime.ps1',
        'service-settings.ps1', 'services.example.json', 'configure-arso.ps1',
        'install-background-services.ps1', 'install-wsl-services.ps1',
        'start-windows-runner.ps1', 'start-wsl-services.ps1', 'SERVICE_LIFECYCLE_AUDIT.md',
    }
    for source in files:
        relative = source.removeprefix('deployment/')
        destination = None
        if relative in root_files or relative.startswith(('windows-native/', 'wsl/')):
            destination = relative
        elif relative.startswith('docs/'):
            destination = relative.removeprefix('docs/')
        elif relative == 'hidden-task-launcher/README.md':
            destination = relative
        elif relative in {'build_release.py', 'finalize-handoff.py', 'update-handoff.py'}:
            destination = source
        if destination:
            outputs[destination] = git('show', f'{head}:{source}').replace(b'\r\n', b'\n')
            sources[destination] = source

    removed = {'hidden-task-launcher/Launcher.cs', 'wsl/shared-auth-bootstrap.py', 'wsl/auth-bootstrap.patch'}
    rows = {row['path']: row for row in reference['files'] if row['path'] not in removed}
    for name, source in sources.items():
        if name.startswith('windows-native/') or name.endswith(('.ps1', '.js')):
            data = outputs[name]
            rows[name] = dict(path=name, sha256=digest(data), bytes=len(data),
                contentSha256LfNormalized=digest(data), classification='maintained-deployment-source',
                sourceCommit=head, sourcePath=source)
    if 'historicalRelocation' not in reference:
        reference['historicalRelocation'] = dict(source=reference.get('source'), integration=reference.get('integration'))
    reference.update(source=dict(repository='https://github.com/Sssssaltyfish/hapi',
        branch='ops/seia-deployment', commit=head),
        integration=dict(status='maintained-deployment-source', currentDeploymentGuide='WINDOWS_SERVICES.md'),
        files=list(rows.values()), currentSourceCommit=head)
    outputs['WINDOWS_REFERENCE_MANIFEST.json'] = json_bytes(reference)
    manifest['deploymentOperations']['commit'] = head
    manifest['deploymentOperations']['files'] = [dict(path=name, sourcePath=source, sha256=digest(outputs[name]))
        for name, source in sorted(sources.items())]
    manifest['deploymentOperations']['machineConfigurationIncluded'] = False
    manifest['components']['windowsNative'].update(sourceCommit=head, fileCount=len(rows))
    # Keep historical validation outcomes, but not the source machine's settings.
    recovery = manifest.get('validations', {}).get('serviceStartupRecovery', {})
    recovery.pop('proxy', None)
    recovery.pop('arso', None)
    recovery['configurationScope'] = 'Historical validation only; choose target-machine policy and private settings independently.'
    outputs['PATCH_MANIFEST.json'] = json_bytes(manifest)

    # Check public deployment material before replacing any sealed files.
    for name, data in outputs.items():
        if re.search(rb'(?i)(?:[A-Z]:[\\/]Users[\\/](?!example[\\/])[A-Za-z0-9_.-]+[\\/]|/home/(?!example/|developer/)[A-Za-z0-9_.-]+/)', data):
            # Historical manifests contain application source hashes and examples;
            # their existing portable content is audited separately from source export.
            if name not in {'PATCH_MANIFEST.json', 'WINDOWS_REFERENCE_MANIFEST.json'}:
                raise ValueError(f'Use portable paths or fictional examples: {name}')
    for name in removed:
        seal.pop(name, None)
        path = kit / name
        if path.exists():
            path.unlink()
    for name, data in outputs.items():
        path = kit / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        seal[name] = digest(data)
    (kit / 'SHA256SUMS.txt').write_text(''.join(f'{sha}  {name}\n' for name, sha in sorted(seal.items())), encoding='utf-8', newline='\n')
    print(json.dumps(dict(opsCommit=head, updatedFiles=len(outputs), removedFiles=len(removed),
        applicationPatchCount=manifest['components']['hapi']['patchCount'])))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='Existing sealed handoff directory')
    parser.add_argument('--ops-repo', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    update(args.source.resolve(strict=True), args.ops_repo.resolve(strict=True))
