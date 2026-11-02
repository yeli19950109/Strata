"""Fork release configuration and artifact validation use throwaway test keys only."""
import importlib.util
import json
import os
import tempfile
import io
import subprocess
import tarfile
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

    def test_three_platform_metadata_reverifies_and_rejects_changed_file(self):
        bundle=self.root/'bundle'
        for directory in ('nsis','appimage','macos'): (bundle/directory).mkdir(parents=True)
        artifacts = {
            'windows-x86_64':bundle/'nsis'/f'Strata_{self.tag[1:]}_x64-setup.exe',
            'linux-x86_64':bundle/'appimage'/f'Strata_{self.tag[1:]}_amd64.AppImage',
            'darwin-aarch64':bundle/'macos'/'Strata.app.tar.gz',
        }
        artifacts['windows-x86_64'].write_bytes(b'windows')
        artifacts['linux-x86_64'].write_bytes(b'linux')
        with tarfile.open(artifacts['darwin-aarch64'],'w:gz') as t:
            raw=b'plist'; info=tarfile.TarInfo('Strata.app/Contents/Info.plist'); info.size=len(raw);t.addfile(info,io.BytesIO(raw))
        staged=self.root/'staged'
        with mock.patch.dict(os.environ, {'FORK_TAURI_PUBLIC_KEY':self.public}):
            for target,artifact in artifacts.items():
                Path(str(artifact)+'.sig').write_text(minisign_sign(artifact.read_bytes(),self.secret))
                release.collect(self.tag,target,bundle,staged/f'fork-release-{target}')
            result=self.root/'combined'
            subprocess.run([os.sys.executable,str(ROOT/'apps/desktop/scripts/fork-release-merge.py'),'--tag',self.tag,'--input',str(staged),'--output',str(result)],check=True)
            cmd=[os.sys.executable,str(ROOT/'apps/desktop/scripts/fork-release.py'),'verify','--tag',self.tag,'--output',str(result)]
            subprocess.run(cmd,check=True,capture_output=True)
            (result/artifacts['linux-x86_64'].name).write_bytes(b'changed')
            self.assertNotEqual(subprocess.run(cmd,capture_output=True).returncode,0)

if __name__=='__main__': unittest.main()
