"""Fork release configuration and artifact validation use throwaway test keys only."""
import importlib.util
import json
import os
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from tests.terminal.update_fixture import minisign_pair, minisign_sign

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('fork_release', ROOT / 'apps/desktop/scripts/fork-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class ForkRelease(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.public, self.secret = minisign_pair()
        self.tag = 'v' + json.loads((ROOT/'apps/desktop/package.json').read_text())['version']

    def test_overlay_requires_distinct_valid_key_and_matching_tag(self):
        out = self.root / 'overlay.json'
        with mock.patch.dict(os.environ, {'FORK_TAURI_PUBLIC_KEY': self.public}):
            release.overlay(self.tag, out)
            value = json.loads(out.read_text())
            self.assertTrue(value['bundle']['createUpdaterArtifacts'])
            self.assertEqual(value['plugins']['updater']['pubkey'], self.public)
            with self.assertRaises(ValueError): release.overlay('v99.0.0', out)
        with mock.patch.dict(os.environ, {'FORK_TAURI_PUBLIC_KEY': ''}):
            with self.assertRaises(ValueError): release.overlay(self.tag, out)
        upstream=json.loads(release.CONF.read_text())['plugins']['updater']['pubkey']
        with mock.patch.dict(os.environ, {'FORK_TAURI_PUBLIC_KEY': upstream}):
            with self.assertRaises(ValueError): release.overlay(self.tag, out)

    def test_collect_verifies_fork_signature_and_fails_for_tampering(self):
        bundle=self.root/'bundle'; (bundle/'nsis').mkdir(parents=True)
        artifact=bundle/'nsis'/f'Strata_{self.tag[1:]}_x64-setup.exe'; artifact.write_bytes(b'test installer')
        sig=Path(str(artifact)+'.sig');sig.write_text(minisign_sign(artifact.read_bytes(),self.secret))
        out=self.root/'out'
        with mock.patch.dict(os.environ, {'FORK_TAURI_PUBLIC_KEY': self.public}):
            release.collect(self.tag,'windows-x86_64',bundle,out)
            record=json.loads((out/'latest.json').read_text())['platforms']['windows-x86_64']
            self.assertIn('/yeli19950109/Strata/releases/download/',record['url'])
            wrong=bundle/'nsis'/'Strata_99.0.0_x64-setup.exe'
            artifact.rename(wrong)
            with self.assertRaisesRegex(ValueError, 'release version'): release.collect(self.tag,'windows-x86_64',bundle,self.root/'wrong')
            wrong.rename(artifact)
            artifact.write_bytes(b'tampered installer')
            with self.assertRaises(SystemExit): release.collect(self.tag,'windows-x86_64',bundle,self.root/'bad')

    def test_windows_metadata_reverifies_and_rejects_tampering_or_extra_platform(self):
        bundle = self.root / 'bundle'
        (bundle / 'nsis').mkdir(parents=True)
        artifact = bundle / 'nsis' / f'Strata_{self.tag[1:]}_x64-setup.exe'
        artifact.write_bytes(b'windows')
        Path(str(artifact) + '.sig').write_text(minisign_sign(artifact.read_bytes(), self.secret))
        staged = self.root / 'staged'
        with mock.patch.dict(os.environ, {'FORK_TAURI_PUBLIC_KEY': self.public}):
            release.collect(self.tag, 'windows-x86_64', bundle, staged / 'fork-release-windows-x86_64')
            result = self.root / 'combined'
            merge = [os.sys.executable, str(ROOT / 'apps/desktop/scripts/fork-release-merge.py'), '--tag', self.tag, '--input', str(staged), '--output', str(result)]
            empty = self.root / 'empty'
            empty.mkdir()
            missing = [os.sys.executable, str(ROOT / 'apps/desktop/scripts/fork-release-merge.py'), '--tag', self.tag, '--input', str(empty), '--output', str(self.root / 'missing')]
            self.assertNotEqual(subprocess.run(missing, capture_output=True).returncode, 0)
            subprocess.run(merge, check=True)
            cmd = [os.sys.executable, str(ROOT / 'apps/desktop/scripts/fork-release.py'), 'verify', '--tag', self.tag, '--output', str(result)]
            subprocess.run(cmd, check=True, capture_output=True)
            metadata = result / 'latest.json'
            data = json.loads(metadata.read_text())
            self.assertEqual(set(data['platforms']), {'windows-x86_64'})
            data['platforms']['linux-x86_64'] = data['platforms']['windows-x86_64']
            metadata.write_text(json.dumps(data))
            self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
            data['platforms'].pop('linux-x86_64')
            metadata.write_text(json.dumps(data))
            (result / artifact.name).write_bytes(b'changed')
            self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
            extra = staged / 'fork-release-linux-x86_64'
            extra.mkdir()
            (extra / 'latest.json').write_text(json.dumps({'version': self.tag[1:], 'platforms': {'linux-x86_64': {}}}))
            self.assertNotEqual(subprocess.run(merge[:-1] + [str(self.root / 'bad')], capture_output=True).returncode, 0)

if __name__=='__main__': unittest.main()
