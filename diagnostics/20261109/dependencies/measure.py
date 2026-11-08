import collections
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone


source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2])
base = '85ccab1ac673bb848a3ca80e448b919db1cfccef'
root = source / 'node_modules'
store = root / '.bun'
dep_fields = ('dependencies', 'optionalDependencies', 'peerDependencies')


def parse_lock(text):
    tokens = re.compile(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/|,(?=\s*[}\]])', re.S)
    return json.loads(tokens.sub(lambda m: m[0] if m[0].startswith('"') else '', text))


def resolve_package(parent, name):
    for ancestor in (parent, *parent.parents):
        if ancestor.name == 'node_modules':
            continue
        candidate = ancestor / 'node_modules' / name
        if candidate.is_dir():
            return candidate.resolve()
        if ancestor == source:
            break
    return None


def walk_paths(path):
    pending = [path]
    while pending:
        item = pending.pop()
        status = item.lstat()
        yield item, status
        if stat.S_ISDIR(status.st_mode):
            pending.extend(item.iterdir())


def read_source(path, revision=None):
    if revision:
        return subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=source).decode('utf-8-sig')
    return (source / path).read_text(encoding='utf-8-sig')


lock_files = ('bun.lock', 'website/bun.lock')
base_locks = {path: parse_lock(read_source(path, base)) for path in lock_files}
current_locks = {path: parse_lock(read_source(path)) for path in lock_files}
base_versions = {record[0] for lock in base_locks.values() for record in lock['packages'].values()}
current_versions = {record[0] for lock in current_locks.values() for record in lock['packages'].values()}
added_versions = current_versions - base_versions
workspace_paths = ['', *json.loads(read_source('package.json'))['workspaces']]
manifests = [str(Path(workspace) / 'package.json') for workspace in workspace_paths]
direct_changes = []
direct_added_versions = set()
root_groups = collections.defaultdict(list)
for workspace, manifest in zip(workspace_paths, manifests):
    previous = json.loads(read_source(manifest, base))
    current = json.loads(read_source(manifest))
    for field in (*dep_fields, 'devDependencies'):
        old_deps = previous.get(field, {})
        for name, spec in current.get(field, {}).items():
            group = f'{workspace or "root"}:{field}'
            resolved = resolve_package(source / workspace, name)
            if resolved:
                root_groups[group].append((name, resolved))
            if old_deps.get(name) != spec:
                resolved_id = None
                if resolved:
                    meta = json.loads((resolved / 'package.json').read_text(encoding='utf-8-sig'))
                    resolved_id = f'{meta["name"]}@{meta["version"]}'
                direct_changes.append(dict(workspace=workspace, field=field, name=name,
                                           before=old_deps.get(name), after=spec, resolved=resolved_id))
                if resolved_id in added_versions:
                    direct_added_versions.add(resolved_id)


def dependency_closure(starts):
    seen = set()
    pending = list(starts)
    while pending:
        package = pending.pop()
        if package in seen:
            continue
        seen.add(package)
        manifest = package / 'package.json'
        if not manifest.is_file():
            continue
        meta = json.loads(manifest.read_text(encoding='utf-8-sig'))
        for field in dep_fields:
            for dependency in meta.get(field, {}):
                resolved = resolve_package(package, dependency)
                if resolved and resolved not in seen:
                    pending.append(resolved)
    return seen


usage = collections.defaultdict(list)
for group, roots in root_groups.items():
    for package in dependency_closure(resolved for _, resolved in roots):
        usage[package].append(group)

store_packages = {}
for entry in store.iterdir():
    if entry.name == 'node_modules' or not entry.is_dir() or entry.is_symlink():
        continue
    package_level = entry / 'node_modules'
    if not package_level.is_dir():
        continue
    package_dirs = [p for p in package_level.iterdir() if not p.is_symlink() and p.is_dir()]
    for directory in package_dirs:
        candidates = [directory]
        if directory.name.startswith('@'):
            candidates = [p for p in directory.iterdir() if not p.is_symlink() and p.is_dir()]
        for package in candidates:
            manifest = package / 'package.json'
            if manifest.is_file():
                meta = json.loads(manifest.read_text(encoding='utf-8-sig'))
                if 'name' in meta and 'version' in meta:
                    store_packages[package] = f'{meta["name"]}@{meta["version"]}'


def origin(package_id):
    if package_id in base_versions:
        return 'upstream_lock'
    if package_id in direct_added_versions:
        return 'local_direct_new'
    if package_id in added_versions:
        return 'local_transitive_new'
    return 'outside_both_locks'


priority = dict(upstream_lock=0, outside_both_locks=1, local_direct_new=2, local_transitive_new=3)
seen = set()
rows = []
for package, package_id in sorted(store_packages.items(), key=lambda kv: (priority[origin(kv[1])], kv[1], str(kv[0]))):
    allocated = apparent = shared = 0
    for _, info in walk_paths(package):
        inode = info.st_dev, info.st_ino
        if inode in seen:
            shared += info.st_blocks * 512
            continue
        seen.add(inode)
        allocated += info.st_blocks * 512
        apparent += info.st_size
    name, version = package_id.rsplit('@', 1)
    rows.append(dict(id=package_id, name=name, version=version, origin=origin(package_id),
                     path=str(package.relative_to(source)), allocated_bytes=allocated,
                     apparent_bytes=apparent, hardlinked_bytes_already_counted=shared,
                     usage=sorted(usage[package])))

overhead_allocated = overhead_apparent = 0
for _, info in walk_paths(root):
    inode = info.st_dev, info.st_ino
    if inode in seen:
        continue
    seen.add(inode)
    overhead_allocated += info.st_blocks * 512
    overhead_apparent += info.st_size

by_id = collections.defaultdict(list)
for row in rows:
    by_id[row['id']].append(row)
hub_dependency_links = {name: str(path) for name, path in root_groups['hub:dependencies']}
hub_workspace_links = sorted(str(path) for path in dependency_closure(path for _, path in root_groups['hub:dependencies'])
                             if root not in path.parents and source in path.parents)
rows.sort(key=lambda row: (-row['allocated_bytes'], row['id'], row['path']))
report = dict(
    measured_at=datetime.now(timezone.utc).isoformat(),
    source=str(source),
    base=base,
    git_head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip(),
    normalized_sha256={path: hashlib.sha256(read_source(path).encode()).hexdigest() for path in (*manifests, *lock_files)},
    direct_changes=direct_changes,
    lock_added_ids=sorted(added_versions),
    lock_removed_ids=sorted(base_versions - current_versions),
    hub_dependency_links=hub_dependency_links,
    hub_workspace_links=hub_workspace_links,
    package_instance_count=len(rows),
    package_id_count=len(by_id),
    package_instances=rows,
    overhead=dict(allocated_bytes=overhead_allocated, apparent_bytes=overhead_apparent),
    allocated_bytes=sum(row['allocated_bytes'] for row in rows) + overhead_allocated,
    apparent_bytes=sum(row['apparent_bytes'] for row in rows) + overhead_apparent,
)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{len(rows)} package instances, {len(by_id)} package/version IDs, {report["allocated_bytes"]} allocated bytes, {report["apparent_bytes"]} apparent bytes')
