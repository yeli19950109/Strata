#!/usr/bin/env python3
"""Stage the verified Windows artifact; never overwrite a name."""
import argparse
import json
import shutil
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--tag', required=True)
p.add_argument('--input', required=True, type=Path)
p.add_argument('--output', required=True, type=Path)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
merged = None
for directory in sorted(a.input.glob('fork-release-*')):
    part = json.loads((directory / 'latest.json').read_text())
    if merged is None:
        merged = {**part, 'platforms': {}}
    if part['version'] != a.tag.removeprefix('v') or merged['version'] != part['version']:
        raise SystemExit('Release artifact versions differ.')
    for target, info in part['platforms'].items():
        if target in merged['platforms']:
            raise SystemExit('Duplicate platform.')
        merged['platforms'][target] = info
    for f in directory.iterdir():
        if f.name == 'latest.json': continue
        dest = a.output / f.name
        if not f.is_file() or dest.exists(): raise SystemExit('Duplicate or invalid artifact.')
        shutil.copyfile(f, dest)
if not merged or set(merged['platforms']) != {'windows-x86_64'}:
    raise SystemExit('Exactly the Windows x64 artifact is required.')
(a.output / 'latest.json').write_text(json.dumps(merged, indent=2)+'\n')
