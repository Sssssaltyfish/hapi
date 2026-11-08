import hashlib
import json
from pathlib import Path
import subprocess
import sys


source, tree_path, report_path = map(Path, sys.argv[1:])
tree = {}
for entry in tree_path.read_bytes().split(b'\0'):
    if entry:
        header, path = entry.split(b'\t', 1)
        mode, object_type, digest = header.decode().split()
        if object_type == 'blob':
            tree[path.decode()] = mode, digest


def blob_id(data):
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()


results = {'matched_exact': 0, 'matched_after_crlf_normalization': 0,
           'missing': [], 'different': [], 'extra_untracked': [], 'extra_tracked': []}
for relative, (mode, digest) in tree.items():
    path = source / relative
    if not path.is_file() and not path.is_symlink():
        results['missing'].append(relative)
        continue
    if mode == '120000' and path.is_symlink():
        data = str(path.readlink()).encode()
    else:
        data = path.read_bytes()
    if blob_id(data) == digest:
        results['matched_exact'] += 1
    elif b'\r\n' in data and blob_id(data.replace(b'\r\n', b'\n')) == digest:
        results['matched_after_crlf_normalization'] += 1
    else:
        results['different'].append(relative)

for kind, flags in [('extra_untracked', ['--others', '--exclude-standard']), ('extra_tracked', [])]:
    paths = subprocess.check_output(['git', 'ls-files', '-z', *flags], cwd=source).decode().split('\0')
    results[kind] = sorted(path for path in paths if path and path not in tree and (source / path).exists())

report_path.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(json.dumps({key: len(value) if isinstance(value, list) else value for key, value in results.items()}))
