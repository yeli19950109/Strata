"""External updates replace only files established by signed manifests."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
import shutil
import os
import subprocess
import sys

from strata_control import external_engine_update as ext
from tests.terminal.update_fixture import build_package, make_key, trusted_of


class ExternalEngineUpdate(TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # macOS /var and Windows temporary paths can include system aliases.
        # Test using the canonical directory without weakening link checks.
        root = Path(self.tmp.name).resolve()
        self.root = root
        self.key = make_key()
        self.trusted = trusted_of(self.key)
        one = build_package(root / 'old', '0.1.45', key=self.key)
        self.stage = build_package(root / 'new', '0.1.46', key=self.key)
        self.live = root / '用户 engine'
        shutil.copytree(one, self.live)
        self.exe = self.live / ('strata.cmd' if __import__('os').name == 'nt' else 'strata')
        self.old_hash = ext._digest(self.live / 'engine-component.json')
        self.new_hash = ext._digest(self.stage / 'engine-component.json')
        self.backups = root / 'private backups'

    def run_update(self):
        return ext.apply_staged(self.exe, self.stage, self.trusted, self.backups, self.old_hash, self.new_hash)

    def test_backup_syncs_a_writable_descriptor(self):
        import os
        source = self.root / 'source'
        dest = self.root / 'backup'
        source.write_bytes(b'backup content')
        sync = os.fsync
        def assert_writable(fd):
            os.write(fd, b'')
            sync(fd)
        with mock.patch.object(ext.os, 'fsync', side_effect=assert_writable):
            ext._copy_backup(source, dest)
        self.assertEqual(dest.read_bytes(), b'backup content')

    def test_windows_hip_manifest_shape_and_large_file_list(self):
        # Synthetic files only: exercise the reported schema and scale without
        # retaining the user's private manifest or running an engine.
        import hashlib, json, os
        from tests.terminal.update_fixture import feed_tool
        base = self.root
        old, new = base / 'hip old', base / 'hip new'
        paths = ['strata.exe', 'BUILD.json'] + [f'rocm/bin/lib-{n:04}.dll' for n in range(828)]
        for root, version in ((old, '0.1.48'), (new, '0.1.49')):
            entries = []
            for path in paths:
                dest = root / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                content = (json.dumps({'source': 'prebuilt', 'version': version, 'backend': 'hip',
                                       'platform': 'windows-x64', 'archs': ['gfx1200', 'gfx1201'],
                                       'rocm': '10.2.0a20260930', 'hipblaslt_version': 100500,
                                       'lib_dirs': ['rocm/bin']}).encode()
                           if path == 'BUILD.json' else (version + ':' + path).encode())
                dest.write_bytes(content)
                if path == 'strata.exe': dest.chmod(0o755)
                entries.append({'path': path, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
            manifest = {'schema_version': 2, 'id': 'strata-engine', 'name': 'strata-engine',
                        'version': version, 'platform': 'windows-x86_64', 'backend': 'hip',
                        'archs': ['gfx1200', 'gfx1201'], 'build_id': 'synthetic+rocm-win10.2',
                        'entrypoint': 'strata.exe', 'variant': 'rx9070', 'files': entries}
            (root / 'engine-component.json').write_text(json.dumps(manifest))
            feed_tool.sign_package(root, self.key)
        exe = old / 'strata.exe'
        component = ext.inspect(exe, self.trusted)
        self.assertEqual((component.version, component.backend, component.variant, component.min_runtime), ('0.1.48', 'hip', 'rx9070', None))
        self.assertEqual(len(component.files), 830)
        user_file = old / 'custom.txt'; user_file.write_text('keep')
        result = ext.apply_staged(exe, new, self.trusted, base / 'hip-backups',
                                  ext._digest(old / 'engine-component.json'), ext._digest(new / 'engine-component.json'))
        self.assertEqual(result['targetVersion'], '0.1.49')
        self.assertEqual(user_file.read_text(), 'keep')
        self.assertEqual(ext.inspect(exe, self.trusted).version, '0.1.49')
        (old / paths[-1]).write_bytes(b'changed')
        with self.assertRaisesRegex(ext.ExternalUpdateError, 'not an intact signed'):
            ext.inspect(exe, self.trusted)

    def test_signed_update_keeps_user_files_and_backup(self):
        user = self.live / 'model.gguf'
        user.write_bytes(b'original model')
        result = self.run_update()
        self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.46')
        self.assertEqual(user.read_bytes(), b'original model')
        self.assertTrue((Path(result['backup']) / 'engine-component.json').is_file())

    def test_list_and_delete_verified_backup_only_after_explicit_choice(self):
        result=self.run_update(); backup=Path(result['backup']); state=self.backups.parent
        # The API stores backups under state/backups; use the fixture root as that state.
        target=state/'backups';self.backups.rename(target)
        rows=ext.list_backups(state,self.trusted)
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['version'],'0.1.45')
        backup=target/backup.name
        if not ext._backup_deletion_supported():
            self.assertFalse(rows[0]['deletable']);self.assertEqual(rows[0]['deleteBlockedReason'],'unsafe_platform')
            with self.assertRaisesRegex(ext.ExternalUpdateError,'unavailable'):
                ext.delete_backup(state,backup.name,self.trusted)
            self.assertTrue(backup.is_dir())
            return
        self.assertTrue(rows[0]['deletable'])
        with self.assertRaisesRegex(ext.ExternalUpdateError,'selected engine'):
            ext.delete_backup(state,backup.name,self.trusted,backup/self.exe.name)
        (target/'pending.json').write_text('{}')
        with self.assertRaisesRegex(ext.ExternalUpdateError,'interrupted'):
            ext.delete_backup(state,backup.name,self.trusted)
        (target/'pending.json').unlink()
        with self.assertRaisesRegex(ext.ExternalUpdateError,'Choose'):
            ext.delete_backup(state,'../outside',self.trusted)
        custom=backup/'my-model.gguf';custom.write_text('keep')
        with self.assertRaisesRegex(ext.ExternalUpdateError,'unrecognised'):
            ext.delete_backup(state,backup.name,self.trusted)
        self.assertEqual(custom.read_text(),'keep');custom.unlink()
        ext.delete_backup(state,backup.name,self.trusted);self.assertFalse(backup.exists())
        self.assertEqual(ext.inspect(self.exe,self.trusted).version,'0.1.46')

    def test_backup_symlink_is_never_followed(self):
        result=self.run_update(); backup=Path(result['backup']);state=self.backups.parent;target=state/'backups';self.backups.rename(target);backup=target/backup.name
        outside=state/'outside';outside.write_text('keep');link=backup/'link'
        try: link.symlink_to(outside)
        except OSError: self.skipTest('symlink creation is not available')
        self.assertFalse(ext.list_backups(state,self.trusted)[0]['deletable'])
        with self.assertRaisesRegex(ext.ExternalUpdateError,'link|unavailable'):
            ext.delete_backup(state,backup.name,self.trusted)
        self.assertEqual(outside.read_text(),'keep')

    def test_windows_path_deletion_is_rejected_before_any_walk_or_removal(self):
        # Simulate a directory swap at the validation boundary: Windows must
        # reject before either inspection or the path-based recursive remover.
        outside=self.root/'outside';outside.mkdir();sentinel=outside/'keep.txt';sentinel.write_text('keep')
        with mock.patch.object(ext.sys, 'platform', 'win32'), \
             mock.patch.object(ext, '_backup_info', side_effect=AssertionError('walk must not run')), \
             mock.patch.object(ext.shutil, 'rmtree', side_effect=AssertionError('rmtree must not run')):
            with self.assertRaisesRegex(ext.ExternalUpdateError,'unavailable'):
                ext.delete_backup(self.root,'external-engine-backup-abcdefgh',self.trusted)
        self.assertEqual(sentinel.read_text(),'keep')

    def test_windows_junction_in_backup_never_removes_its_target(self):
        if sys.platform != 'win32': self.skipTest('Windows junctions require Windows')
        result=self.run_update(); backup=Path(result['backup']); state=self.backups.parent
        target=state/'backups';self.backups.rename(target);backup=target/backup.name
        outside=state/'outside-junction';outside.mkdir();sentinel=outside/'keep.txt';sentinel.write_text('keep')
        junction=backup/'link'
        made=subprocess.run(['cmd','/c','mklink','/J',str(junction),str(outside)],capture_output=True,text=True)
        if made.returncode: self.fail('Could not create a Windows junction for the safety test: '+made.stderr)
        try:
            self.assertFalse(ext.list_backups(state,self.trusted)[0]['deletable'])
            with self.assertRaisesRegex(ext.ExternalUpdateError,'unavailable'):
                ext.delete_backup(state,backup.name,self.trusted)
            self.assertEqual(sentinel.read_text(),'keep')
        finally:
            os.rmdir(junction)
        # Replace the backup directory itself with a junction before deletion.
        # The target and the original backup must both remain untouched.
        original=target/'original-backup';backup.rename(original)
        made=subprocess.run(['cmd','/c','mklink','/J',str(backup),str(outside)],capture_output=True,text=True)
        if made.returncode: self.fail('Could not create a replacement junction: '+made.stderr)
        try:
            with self.assertRaisesRegex(ext.ExternalUpdateError,'unavailable'):
                ext.delete_backup(state,backup.name,self.trusted)
            self.assertEqual(sentinel.read_text(),'keep');self.assertTrue(original.is_dir())
        finally:
            os.rmdir(backup)

    def test_failure_restores_old_files(self):
        original = ext._write_atomic
        calls = 0
        def fail_once(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('simulated write failure')
            return original(*args)
        with mock.patch.object(ext, '_write_atomic', side_effect=fail_once):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'previous files were restored'):
                self.run_update()
        self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.45')

    def test_unknown_and_modified_layout_refused(self):
        (self.live / 'engine-component.json').unlink()
        with self.assertRaisesRegex(ext.ExternalUpdateError, 'older or custom'):
            self.run_update()

    def test_changed_preview_is_refused(self):
        with self.assertRaisesRegex(ext.ExternalUpdateError, 'changed since preview'):
            ext.apply_staged(self.exe, self.stage, self.trusted, self.backups, '0' * 64, self.new_hash)

    def test_interrupted_update_can_be_recovered_after_restart(self):
        original = ext._write_atomic
        calls = 0
        def fail_once(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('simulated interruption')
            return original(*args)
        with mock.patch.object(ext, '_write_atomic', side_effect=fail_once), mock.patch.object(ext, 'recover', side_effect=OSError('process stopped')):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'recovery is required'):
                self.run_update()
        self.assertTrue((self.backups / 'pending.json').is_file())
        result = ext.recover(self.exe, self.trusted, self.backups)
        self.assertEqual(result['restoredVersion'], '0.1.45')
        self.assertFalse((self.backups / 'pending.json').exists())
        self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.45')

    def test_space_exhaustion_does_not_change_engine(self):
        usage = __import__('collections').namedtuple('Usage', 'total used free')(10, 10, 0)
        with mock.patch.object(ext.shutil, 'disk_usage', return_value=usage):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'Not enough free space'):
                self.run_update()
        self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.45')

    def test_linked_or_modified_existing_file_refused(self):
        library = next(p for p, _, _ in ext.inspect(self.exe, self.trusted).files if p != self.exe.name)
        (self.live / library).write_text('user modification')
        with self.assertRaisesRegex(ext.ExternalUpdateError, 'not an intact signed'):
            self.run_update()

    def test_unowned_new_file_conflict_is_not_overwritten(self):
        import hashlib, json
        from tests.terminal.update_fixture import feed_tool
        path = self.stage / 'custom.dll'
        path.write_bytes(b'new engine file')
        manifest_path = self.stage / 'engine-component.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['files'].append({'path':'custom.dll', 'sha256':hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes':path.stat().st_size})
        manifest_path.write_text(json.dumps(manifest))
        feed_tool.sign_package(self.stage, self.key)
        self.new_hash = ext._digest(manifest_path)
        user = self.live / 'custom.dll'
        user.write_bytes(b'user file')
        with self.assertRaisesRegex(ext.ExternalUpdateError, 'unowned file'):
            self.run_update()
        self.assertEqual(user.read_bytes(), b'user file')

    def test_running_matching_executable_is_refused(self):
        import os, sys
        if not sys.platform.startswith('linux'):
            self.skipTest('Linux procfs test')
        running = Path(os.readlink('/proc/self/exe'))
        with self.assertRaisesRegex(ext.ExternalUpdateError, 'running|reliably inspect'):
            ext._ensure_not_running(running)

    def test_unknown_platform_does_not_assume_engine_stopped(self):
        with mock.patch.object(ext.sys, 'platform', 'darwin'):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'update manually'):
                ext._ensure_not_running(self.exe)

    def test_concurrent_external_changes_are_not_overwritten(self):
        original = ext._write_atomic
        calls = 0
        def change_next(dest, source):
            nonlocal calls
            calls += 1
            if calls == 1:
                result = original(dest, source)
                second = next(p for p, _, _ in ext.ec.read_manifest(self.stage).files if p != dest.name)
                (self.live / second).write_bytes(b'user changed during update')
                return result
            return original(dest, source)
        with mock.patch.object(ext, '_write_atomic', side_effect=change_next):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'recovery is required'):
                self.run_update()
        self.assertTrue((self.backups / 'pending.json').is_file())
        self.assertTrue(any(p.is_file() and p.read_bytes() == b'user changed during update' for p in self.live.iterdir()))

    def test_recovery_refuses_linked_engine_directory(self):
        import os
        if os.name == 'nt':
            self.skipTest('symlink needs Windows privilege')
        alias = self.live.parent / 'linked-engine'
        alias.symlink_to(self.live, target_is_directory=True)
        with self.assertRaisesRegex(ext.ExternalUpdateError, 'link'):
            ext.inspect(alias / self.exe.name, self.trusted)

    def test_read_only_failure_restores_old_engine(self):
        with mock.patch.object(ext, '_write_atomic', side_effect=PermissionError('read-only')):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'previous files were restored'):
                self.run_update()
        self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.45')

    def test_check_and_apply_verify_signed_feed_and_never_execute_engine(self):
        import contextlib, os
        from tests.terminal.update_fixture import FeedServer, feed_tool
        from strata_control import components, updater
        release = self.live.parent / 'release'
        out = release / 'engine'
        out.mkdir(parents=True)
        feed_tool.pack_engine(self.stage, out)
        feed_tool.build_feed(release, key=self.key, sequence=1, engine_dir=out)
        hw = {'platform':components.host_platform(), 'backend':'cuda', 'runtime':None,
              'nvidia_driver':'610.47', 'cuda_archs':['sm_86'], 'gfx':[]}
        state = self.live.parent / 'private-state'
        state.mkdir()
        with FeedServer(release) as feed, mock.patch.dict(os.environ, {'STRATA_NO_ACQUIRE':'0'}):
            ctx = updater.Context(components=state, source=feed.url + '/strata-feed.json', trusted=self.trusted,
                                  hardware=hw, serving=lambda:[], environ=dict(os.environ))
            offer = ext.preview(self.exe, ctx)
            self.assertEqual(offer['status'], 'available')
            self.assertEqual(offer['currentVersion'], '0.1.45')
            self.assertEqual(offer['targetVersion'], '0.1.46')
            with mock.patch.object(updater.State, 'save', side_effect=OSError('state read-only')), mock.patch.object(updater, '_download', side_effect=AssertionError('no download')):
                with self.assertRaisesRegex(OSError, 'state read-only'):
                    ext.apply(self.exe, ctx, offer['currentManifestSha256'], offer['manifestSha256'], self.backups)
            self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.45')
            with mock.patch.object(ext, '_ensure_not_running'), mock.patch.object(ext, '_exclusive_runtime', side_effect=contextlib.nullcontext):
                ext.apply(self.exe, ctx, offer['currentManifestSha256'], offer['manifestSha256'], self.backups)
            self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.46')
            self.assertFalse((self.live.parent / 'ran.txt').exists())

    def test_mismatched_hardware_is_refused_before_network(self):
        from strata_control import updater
        ctx = updater.Context(components=self.live.parent / 'state', source='unused', trusted=self.trusted,
                              hardware={'platform':'wrong-platform', 'backend':'hip'})
        with mock.patch.object(updater, 'open_feed', side_effect=AssertionError('no network')):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'does not match detected'):
                ext.preview(self.exe, ctx)

    def test_hardlinked_executable_running_under_another_name_is_refused(self):
        import os, subprocess, sys
        if not sys.platform.startswith('linux') or not Path('/bin/sleep').is_file():
            self.skipTest('Linux hardlink process check')
        selected = self.live.parent / 'selected-binary'
        alias = self.live.parent / 'other-name'
        shutil.copy2('/bin/sleep', selected)
        os.link(selected, alias)
        proc = subprocess.Popen([str(alias), '20'])
        try:
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'running|reliably inspect'):
                ext._ensure_not_running(selected)
        finally:
            proc.terminate()
            proc.wait()

    def test_linked_private_backup_directory_is_refused(self):
        import os
        if os.name == 'nt':
            self.skipTest('symlink needs Windows privilege')
        outside = self.live.parent / 'unowned'
        outside.mkdir()
        self.backups.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ext.ExternalUpdateError, 'contains a link'):
            self.run_update()
        self.assertEqual(list(outside.iterdir()), [])

    def test_recovery_preserves_new_files_even_if_their_bytes_match(self):
        import hashlib, json
        from tests.terminal.update_fixture import feed_tool
        addition = self.stage / 'new-runtime.dll'
        addition.write_bytes(b'signed new bytes')
        manifest_path = self.stage / 'engine-component.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['files'].append({'path':'new-runtime.dll', 'sha256':hashlib.sha256(addition.read_bytes()).hexdigest(), 'bytes':addition.stat().st_size})
        manifest_path.write_text(json.dumps(manifest))
        feed_tool.sign_package(self.stage, self.key)
        self.new_hash = ext._digest(manifest_path)
        with mock.patch.object(ext, '_write_atomic', side_effect=PermissionError('read-only')):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'New files were left in place'):
                self.run_update()
        self.assertEqual((self.live / 'new-runtime.dll').read_bytes(), b'signed new bytes')
        self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.45')

    def test_same_disk_reserves_combined_backup_update_and_recovery_space(self):
        import collections
        old_size = sum((self.live / p).stat().st_size for p, _, _ in ext.inspect(self.exe, self.trusted).files) + (self.live / 'engine-component.json').stat().st_size
        new_size = sum((self.stage / p).stat().st_size for p, _, _ in ext._component(self.stage, self.trusted).files)
        free = max(old_size, new_size) + 1  # enough for each separately, not their sum
        usage = collections.namedtuple('Usage','total used free')(free,0,free)
        with mock.patch.object(ext.shutil, 'disk_usage', return_value=usage):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'Not enough free space'):
                self.run_update()
        self.assertEqual(ext.inspect(self.exe, self.trusted).version, '0.1.45')
        self.assertEqual(ext._space_requirements(100, 200, 50, True), (350, 350))
        self.assertEqual(ext._space_requirements(100, 200, 50, False), (100, 250))

    def test_recovery_never_removes_file_created_by_user_after_interruption(self):
        import hashlib, json
        from tests.terminal.update_fixture import feed_tool
        addition = self.stage / 'new-runtime.dll'
        addition.write_bytes(b'same bytes user chose')
        manifest_path = self.stage / 'engine-component.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['files'].append({'path':'new-runtime.dll', 'sha256':hashlib.sha256(addition.read_bytes()).hexdigest(), 'bytes':addition.stat().st_size})
        manifest_path.write_text(json.dumps(manifest))
        feed_tool.sign_package(self.stage, self.key)
        self.new_hash = ext._digest(manifest_path)
        with mock.patch.object(ext, '_exclusive_copy', side_effect=OSError('interrupted')), mock.patch.object(ext, 'recover', side_effect=OSError('process stopped')):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'recovery is required'):
                self.run_update()
        user = self.live / 'new-runtime.dll'
        user.write_bytes(b'same bytes user chose')
        result = ext.recover(self.exe, self.trusted, self.backups)
        self.assertEqual(user.read_bytes(), b'same bytes user chose')
        self.assertEqual(result['retainedAdditions'], [str(user)])

    def test_private_updater_workspace_refuses_links_and_shared_files(self):
        import os
        from strata_control import components, updater
        if os.name == 'nt':
            self.skipTest('symlink needs Windows privilege')
        external = self.live.parent / 'unowned-user-folder'
        external.mkdir()
        marker = external / 'keep.txt'
        marker.write_text('keep')
        hw = {'platform':components.host_platform(), 'backend':'cuda', 'runtime':None,
              'nvidia_driver':'610.47', 'cuda_archs':['sm_86'], 'gfx':[]}
        for kind in ('root', 'staging', 'partial', 'lock', 'hardlink'):
            work = self.live.parent / f'work-{kind}'
            if kind == 'root':
                work.symlink_to(external, target_is_directory=True)
            else:
                work.mkdir()
                if kind == 'staging':
                    (work / '.s').symlink_to(external, target_is_directory=True)
                else:
                    updates = work / '.updates'
                    updates.mkdir()
                    if kind == 'partial':
                        partial = updates / 'partial'
                        partial.mkdir()
                        (partial / 'deadbeef.part').symlink_to(marker)
                    elif kind == 'lock':
                        (updates / 'update.lock').symlink_to(marker)
                    else:
                        os.link(marker, updates / 'update.lock')
            ctx = updater.Context(components=work, source='unused', trusted=self.trusted, hardware=hw)
            with mock.patch.object(updater, 'open_feed', side_effect=AssertionError('no network')), mock.patch.object(ext.shutil, 'rmtree', side_effect=AssertionError('no removal')):
                with self.assertRaisesRegex(ext.ExternalUpdateError, 'link|shared file'):
                    ext.preview(self.exe, ctx)
            self.assertEqual(marker.read_text(), 'keep')

    def test_cli_honors_explicit_engine_feed_override(self):
        import contextlib, io, json, os, sys
        state = self.live.parent / 'cli-state'
        observed = []
        def fake_preview(exe, ctx):
            observed.append(ctx.source)
            return {'path':str(exe),'status':'current'}
        with mock.patch.dict(os.environ, {'STRATA_UPDATE_FEED':'https://example.test/engine-feed.json'}), \
             mock.patch.object(sys, 'argv', ['external', '--state', str(state), '--exe', str(self.exe)]), \
             mock.patch.object(ext, 'preview', side_effect=fake_preview), \
             mock.patch.object(ext.updater, 'detect_hardware', return_value={}), \
             mock.patch.object(ext.signing, 'load_trusted_keys', return_value=self.trusted), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(ext.main(), 0)
        self.assertEqual(observed, ['https://example.test/engine-feed.json'])
        self.assertTrue(json.loads(out.getvalue())['ok'])

    def test_status_exposes_interrupted_recovery_without_network(self):
        import contextlib, io, json, sys
        backup = self.live.parent / 'status-state' / 'backups'
        backup.mkdir(parents=True)
        (backup / 'pending.json').write_text(json.dumps({'root':str(self.live),'entrypoint':self.exe.name,'backup':str(backup / 'saved')}))
        with mock.patch.object(sys, 'argv', ['external', '--state', str(backup.parent), '--status']), \
             mock.patch.object(ext.updater, 'detect_hardware', side_effect=AssertionError('no probe')), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(ext.main(), 0)
        status = json.loads(out.getvalue())
        self.assertTrue(status['recoveryRequired'])
        self.assertEqual(status['path'], str(self.exe))

    def test_cli_default_feed_is_upstream_not_fork(self):
        import contextlib, io, os, sys
        state = self.live.parent / 'default-source-state'
        observed = []
        def fake_preview(exe, ctx):
            observed.append(ctx.source)
            return {'path':str(exe),'status':'current'}
        env = dict(os.environ)
        env.pop('STRATA_UPDATE_FEED', None)
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(sys, 'argv', ['external', '--state', str(state), '--exe', str(self.exe)]), \
             mock.patch.object(ext.ec, 'components_dir', return_value=self.live.parent / 'no-components'), \
             mock.patch.object(ext, 'preview', side_effect=fake_preview), \
             mock.patch.object(ext.updater, 'detect_hardware', return_value={}), \
             mock.patch.object(ext.signing, 'load_trusted_keys', return_value=self.trusted), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ext.main(), 0)
        self.assertTrue(observed[0].startswith('https://github.com/Niko1221/Strata/'), observed)

    def test_cli_progress_reports_transfer_bytes_separately_from_result(self):
        import contextlib, io, json, sys
        state = self.live.parent / 'progress-state'
        def fake_apply(exe, ctx, old, new, backup):
            ctx.emit({'event':'progress','phase':'download','done':25,'total':100})
            ctx.emit({'event':'phase','phase':'verify'})
            return {'targetVersion':'0.1.46'}
        with mock.patch.object(sys, 'argv', ['external','--state',str(state),'--exe',str(self.exe),'--apply','--old-sha','a','--new-sha','b','--progress-json']), \
             mock.patch.object(ext, 'apply', side_effect=fake_apply), \
             mock.patch.object(ext.updater, 'detect_hardware', return_value={}), \
             mock.patch.object(ext.signing, 'load_trusted_keys', return_value=self.trusted), \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(ext.main(), 0)
        self.assertEqual(json.loads(out.getvalue())['targetVersion'],'0.1.46')
        self.assertEqual(err.getvalue().strip(),'STRATA_PROGRESS {"done": 25, "total": 100}')

    def test_private_workspace_refuses_fifo_before_opening_update_lock(self):
        import os
        from strata_control import components, updater
        if not hasattr(os, 'mkfifo'):
            self.skipTest('FIFO unavailable')
        work = self.live.parent / 'fifo-work'
        (work / '.updates').mkdir(parents=True)
        os.mkfifo(work / '.updates' / 'update.lock')
        hw = {'platform':components.host_platform(), 'backend':'cuda', 'runtime':None,
              'nvidia_driver':'610.47', 'cuda_archs':['sm_86'], 'gfx':[]}
        ctx = updater.Context(components=work, source='unused', trusted=self.trusted, hardware=hw)
        with mock.patch.object(updater, 'open_feed', side_effect=AssertionError('no network')):
            with self.assertRaisesRegex(ext.ExternalUpdateError, 'link or shared file'):
                ext.preview(self.exe, ctx)
