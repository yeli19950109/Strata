#!/usr/bin/env python3
"""Prepare fork updater configuration and verify artifacts without handling private keys."""
import argparse
import importlib.util
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from strata_control import signing
spec = importlib.util.spec_from_file_location('strata_feed_tool', ROOT / 'packaging/feed_tool.py')
feed_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed_tool)

CONF = ROOT / 'apps/desktop/src-tauri/tauri.conf.json'
REPO = 'yeli19950109/Strata'
TARGETS = ('windows-x86_64',)


def public_key():
    key = os.environ.get('FORK_TAURI_PUBLIC_KEY', '').strip()
    if not key:
        raise ValueError('Set the repository variable FORK_TAURI_PUBLIC_KEY to the fork updater public key.')
    signing.minisign_public(key)
    upstream = json.loads(CONF.read_text())['plugins']['updater']['pubkey']
    if signing.minisign_public(key) == signing.minisign_public(upstream):
        raise ValueError('The fork public key must differ from the upstream updater key.')
    return key


def version_for(tag):
    package = json.loads((ROOT / 'apps/desktop/package.json').read_text())['version']
    cargo = (ROOT / 'apps/desktop/src-tauri/Cargo.toml').read_text()
    match = re.search(r'(?m)^version\s*=\s*"([^\"]+)"', cargo)
    version = json.loads(CONF.read_text()).get('version', package)
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag) or tag != 'v' + version or package != version or not match or match.group(1) != version:
        raise ValueError('The tag must be vMAJOR.MINOR.PATCH and match the Tauri, npm and Cargo versions.')
    return version


def overlay(tag, output):
    version_for(tag)
    output.write_text(json.dumps({'bundle': {'createUpdaterArtifacts': True}, 'plugins': {'updater': {'pubkey': public_key()}}}, indent=2)+'\n')


def collect(tag, target, bundle, output):
    version = version_for(tag)
    key = public_key()
    patterns = {'windows-x86_64': 'nsis/*-setup.exe'}
    found = list(bundle.glob(patterns[target]))
    if len(found) != 1:
        raise ValueError(f'Expected exactly one {target} updater artifact, found {len(found)}.')
    archive = found[0]
    if not re.search(r'(?<!\d)' + re.escape(version) + r'(?!\d)', archive.name):
        raise ValueError(f'{archive.name} does not contain the release version {version}.')
    signature = Path(str(archive) + '.sig')
    if not signature.is_file():
        raise ValueError(f'Missing updater signature for {archive.name}.')
    output.mkdir(parents=True, exist_ok=True)
    # Keep each platform's actual archive name and verify before publication.
    dest = output / archive.name
    shutil.copyfile(archive, dest)
    shutil.copyfile(signature, Path(str(dest)+'.sig'))
    url = f'https://github.com/{REPO}/releases/download/{tag}/{dest.name}'
    feed_tool.set_app_platform(output / 'latest.json', target=target, archive=dest, signature_file=Path(str(dest)+'.sig'), url=url, version=version, pubkey=key)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['overlay', 'collect', 'verify'])
    p.add_argument('--tag', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--target', choices=TARGETS)
    p.add_argument('--bundle', type=Path)
    a = p.parse_args()
    try:
        if a.action == 'overlay': overlay(a.tag, a.output)
        elif a.action == 'collect':
            if not a.target or not a.bundle: p.error('collect requires --target and --bundle')
            collect(a.tag, a.target, a.bundle, a.output)
        else:
            version = version_for(a.tag)
            data = json.loads((a.output / 'latest.json').read_text())
            if data.get('version') != version or set(data.get('platforms', {})) != set(TARGETS):
                raise ValueError('latest.json must have the release version and only the Windows x64 platform.')
            for target, item in data['platforms'].items():
                prefix = f'https://github.com/{REPO}/releases/download/{a.tag}/'
                if not item['url'].startswith(prefix) or '/' in item['url'][len(prefix):]:
                    raise ValueError(f'Invalid fork release URL for {target}.')
                archive = a.output / item['url'][len(prefix):]
                feed_tool.set_app_platform(a.output / 'verified.json', target=target, archive=archive, signature_file=Path(str(archive)+'.sig'), url=item['url'], version=version, pubkey=public_key())
                verified = json.loads((a.output / 'verified.json').read_text())['platforms'][target]
                if verified != item: raise ValueError(f'Metadata does not match the signed {target} artifact.')
            (a.output / 'verified.json').unlink()
    except (OSError, ValueError, signing.SignatureError) as e:
        print(str(e), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
