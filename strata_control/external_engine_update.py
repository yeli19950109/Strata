"""Update an externally selected signed engine without taking ownership of its folder.

Only files named by a verified existing component manifest may be replaced. New
manifest files may be created only when absent. Removed package files are left
alone. Downloads and backups live in the application's private state directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path

from strata_control import engine_component as ec, feed as feedmod, signing, updater
from strata_cli.update_cmd import _feed_source


class ExternalUpdateError(ValueError):
    pass


def _ensure_not_running(exe: Path):
    """Conservatively reject any process with the same executable basename."""
    name = exe.name.casefold()
    if sys.platform.startswith('linux'):
        proc = Path('/proc')
        if not proc.is_dir():
            raise ExternalUpdateError('Cannot inspect running processes. Close the command-line engine and update manually.')
        try:
            try:
                selected = exe.stat()
                identity = (selected.st_dev, selected.st_ino)
            except FileNotFoundError:
                identity = None  # recovery may need to restore a missing exe
            for entry in proc.iterdir():
                if not entry.name.isdecimal():
                    continue
                try:
                    target = os.readlink(entry / 'exe')
                    current = (entry / 'exe').stat()
                except FileNotFoundError:
                    continue  # process ended, or a kernel thread has no executable
                except OSError as exc:
                    raise ExternalUpdateError('Cannot reliably inspect running processes. Close the command-line engine and update manually.') from exc
                if (identity is not None and (current.st_dev, current.st_ino) == identity) or Path(target.removesuffix(' (deleted)')).name.casefold() == name:
                    raise ExternalUpdateError('A process with this engine executable name is running. Stop it before updating.')
        except OSError as exc:
            raise ExternalUpdateError('Cannot inspect running processes. Stop the engine and update manually.') from exc
        return
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        class ProcessEntry(ctypes.Structure):
            _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                        ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD),
                        ('cntThreads', wintypes.DWORD), ('th32ParentProcessID', wintypes.DWORD),
                        ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
        kernel.Process32FirstW.restype = wintypes.BOOL
        kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
        kernel.Process32NextW.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        snap = kernel.CreateToolhelp32Snapshot(2, 0)
        if snap == ctypes.c_void_p(-1).value:
            raise ExternalUpdateError('Cannot inspect running processes. Stop the engine and update manually.')
        try:
            item = ProcessEntry(); item.dwSize = ctypes.sizeof(item)
            if not kernel.Process32FirstW(snap, ctypes.byref(item)):
                raise ExternalUpdateError('Cannot inspect running processes. Stop the engine and update manually.')
            while True:
                if item.szExeFile.casefold() == name:
                    raise ExternalUpdateError('A process with this engine executable name is running. Stop it before updating.')
                if not kernel.Process32NextW(snap, ctypes.byref(item)):
                    if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                        raise ExternalUpdateError('Process inspection failed. Stop the engine and update manually.')
                    break
        finally:
            kernel.CloseHandle(snap)
        return
    raise ExternalUpdateError('This system cannot reliably check for a running command-line engine. Stop it and update manually.')


@contextmanager
def _exclusive_runtime():
    # The owner runtime and CLI hold the shared lease while serving. Keep the
    # exclusive lease until replacement/recovery ends so no new one can start.
    from strata_control import runtime
    try:
        descriptor = runtime.acquire_activity_lease(shared=False)
    except Exception as exc:
        raise ExternalUpdateError('A Strata engine is running or the activity lease is unavailable. Stop it and try again.') from exc
    try:
        yield
    finally:
        os.close(descriptor)


def _sync_dir(path: Path):
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass  # Windows does not generally allow opening a directory for fsync.


def _private_dir(path: Path, *, create: bool = False):
    # Never follow a substituted state or backup directory into a user folder.
    parent = path.parent
    if not parent.is_dir() or parent.resolve() != parent.absolute():
        raise ExternalUpdateError('The app update state directory is unavailable or contains a link.')
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    if path.is_symlink() or not path.is_dir() or path.resolve() != path.absolute():
        raise ExternalUpdateError('The app update state directory is unavailable or contains a link.')


def _checked_workdir(path: Path):
    """Do not let updater lock/state files follow pre-existing links or hardlinks."""
    _private_dir(path, create=True)
    def failed(error):
        raise ExternalUpdateError(f'Cannot inspect the app update workspace: {error}')
    for directory, dirs, files in os.walk(path, followlinks=False, onerror=failed):
        for name in dirs + files:
            child = Path(directory) / name
            st = child.lstat()
            if (child.is_symlink() or getattr(st, 'st_file_attributes', 0) & 0x400
                    or not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode))
                    or (stat.S_ISREG(st.st_mode) and st.st_nlink != 1)):
                raise ExternalUpdateError('The app update workspace contains a link or shared file. Remove it before checking for updates.')


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


_BACKUP_NAME = re.compile(r'external-engine-backup-[a-z0-9_]{8}\Z')

def _backup_deletion_supported():
    # Windows lacks the dir-fd operations needed to bind a recursive walk to
    # already-verified directories. A path-based rmtree can race a reparse
    # point replacement, so do not attempt it until a handle-based version is
    # implemented and tested on Windows.
    return sys.platform != 'win32' and shutil.rmtree.avoids_symlink_attacks

def _backup_info(root: Path, folder: Path, trusted: dict, *, verify_bytes=False):
    """Recognise only signed update backups, rejecting links and unknown contents."""
    if folder.parent != root or not _BACKUP_NAME.fullmatch(folder.name):
        raise ExternalUpdateError('This is not an app-managed engine backup.')
    _private_dir(folder)
    for manifest in (folder / ec.MANIFEST, folder / 'new-manifest' / ec.MANIFEST):
        _regular(manifest, folder)
    old, new = ec.read_manifest(folder), ec.read_manifest(folder / 'new-manifest')
    previous = ec._verifier
    signing.install_component_verifier(trusted)
    try:
        ec.verify_signature(old, {ec.ENV_REQUIRE_SIGNED:'1'})
        ec.verify_signature(new, {ec.ENV_REQUIRE_SIGNED:'1'})
    finally:
        ec.register_signature_verifier(previous)
    allowed = {p:(digest,size) for p,digest,size in old.files}
    allowed[ec.MANIFEST] = None
    allowed['new-manifest/' + ec.MANIFEST] = None
    dirs = {'new-manifest'}
    for path in allowed:
        parent = Path(path).parent
        while str(parent) not in ('.',''):
            dirs.add(parent.as_posix()); parent = parent.parent
    total=0
    def fail(error): raise error
    for parent, children, files in os.walk(folder, followlinks=False, onerror=fail):
        for name in children + files:
            item=Path(parent)/name; rel=item.relative_to(folder).as_posix(); st=item.lstat()
            if item.is_symlink() or getattr(st,'st_file_attributes',0)&0x400:
                raise ExternalUpdateError('The backup contains a link and cannot be deleted here.')
            if stat.S_ISDIR(st.st_mode):
                if rel not in dirs: raise ExternalUpdateError('The backup contains an unrecognised folder.')
            elif stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
                if rel not in allowed: raise ExternalUpdateError('The backup contains an unrecognised file.')
                spec=allowed[rel]
                if spec and (st.st_size != spec[1] or (verify_bytes and _digest(item) != spec[0])):
                    raise ExternalUpdateError('The backup contains a modified file.')
                total+=st.st_size
            else: raise ExternalUpdateError('The backup contains a shared or unusual file.')
    return {'id':folder.name,'path':str(folder),'version':old.version,'targetVersion':new.version,'modifiedAt':folder.stat().st_mtime,'bytes':total}

def list_backups(state: Path, trusted: dict):
    root=state/'backups'
    if not root.exists() and not root.is_symlink(): return []
    _private_dir(root)
    result=[]
    for folder in sorted(root.iterdir()):
        if not _BACKUP_NAME.fullmatch(folder.name): continue
        try: result.append({**_backup_info(root,folder,trusted),'deletable':_backup_deletion_supported(),
                           **({} if _backup_deletion_supported() else {'deleteBlockedReason':'unsafe_platform'})})
        except (OSError,ValueError,ec.ComponentProblem,signing.SignatureError):
            result.append({'id':folder.name,'path':str(folder),'deletable':False})
    return result

def delete_backup(state: Path, backup_id: str, trusted: dict, selected: Path | None = None):
    if not _backup_deletion_supported():
        raise ExternalUpdateError('Backup deletion is unavailable on this platform until a race-safe implementation is available. No files were deleted.')
    root=state/'backups';_private_dir(root)
    if not _BACKUP_NAME.fullmatch(backup_id or ''): raise ExternalUpdateError('Choose an app-managed engine backup.')
    if (root/'pending.json').exists() or (root/'pending.json').is_symlink(): raise ExternalUpdateError('Restore the interrupted update before deleting backups.')
    folder=root/backup_id
    if selected:
        try: selected.resolve().relative_to(folder.resolve())
        except ValueError: pass
        else: raise ExternalUpdateError('This backup contains the selected engine and cannot be deleted.')
    info=_backup_info(root,folder,trusted,verify_bytes=True)
    # Refuse links/unowned files above; remove only the exact verified backup.
    shutil.rmtree(folder)
    _sync_dir(root)
    return info


def _copy_backup(source: Path, dest: Path) -> None:
    # Windows cannot fsync a read-only descriptor. Flush the writable copy
    # before applying source permissions, which may themselves be read-only.
    with source.open('rb') as inp, dest.open('xb') as out:
        shutil.copyfileobj(inp, out, 1024 * 1024)
        out.flush()
        os.fsync(out.fileno())
    shutil.copystat(source, dest)


def _regular(path: Path, root: Path, *, absent=False) -> bool:
    """Reject links at every existing path component, including Windows junctions."""
    relative = path.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        try:
            st = current.lstat()
        except FileNotFoundError:
            if absent:
                return False
            raise ExternalUpdateError(f'{current} is missing; reconnect the drive.') from None
        if current.is_symlink() or getattr(st, 'st_file_attributes', 0) & 0x400:
            raise ExternalUpdateError(f'{current} is a link or reparse point; use a standard signed engine package.')
    if not path.is_file():
        raise ExternalUpdateError(f'{path} is not a regular file.')
    return True


def _component(root: Path, trusted: dict):
    try:
        if root.is_symlink() or not root.is_dir() or root.resolve() != root.absolute():
            raise ExternalUpdateError('The engine folder is unavailable or contains a link; reconnect the drive or use a standard package.')
        if not (root / ec.MANIFEST).exists():
            raise ExternalUpdateError('This older or custom engine has no verifiable signed package manifest, so it cannot be safely updated in place. Back up your files, unpack an official signed engine package into a separate folder, then select the new executable in Strata. Your models and JSON can stay where they are.')
        _regular(root / ec.MANIFEST, root)
        component = ec.read_manifest(root)
        old = ec._verifier
        signing.install_component_verifier(trusted)
        try:
            ec.verify_signature(component, {ec.ENV_REQUIRE_SIGNED: '1'})
            for rel, _, _ in component.files:
                _regular(root / rel, root)
            ec.verify(component, full=True)
        finally:
            ec.register_signature_verifier(old)
        return component
    except ExternalUpdateError:
        raise
    except (OSError, ec.ComponentProblem, ValueError) as exc:
        raise ExternalUpdateError('This older or custom engine is not an intact signed Strata package, so it cannot be safely updated in place. Back up your files, unpack an official signed engine package into a separate folder, then select the new executable in Strata. Your models and JSON can stay where they are. ' + str(exc)) from None


def inspect(exe: Path, trusted: dict):
    exe = Path(exe)
    if not exe.is_absolute() or not exe.is_file():
        raise ExternalUpdateError('The selected engine is unavailable. Reconnect the drive and try again.')
    root = exe.parent
    component = _component(root, trusted)
    if component.exe.resolve() != exe.resolve():
        raise ExternalUpdateError('The selected file is not the signed package entrypoint; choose the engine executable from the package.')
    return component


def preview(exe: Path, ctx: updater.Context):
    current = inspect(exe, ctx.trusted)
    hardware = {**ctx.hardware, 'installed_variant': current.variant}
    if hardware.get('backend') != current.backend or hardware.get('platform') != current.platform:
        raise ExternalUpdateError('The selected engine does not match detected hardware or platform. Reconnect the device or update manually.')
    _checked_workdir(ctx.components)
    with updater.update_lock(ctx.components):
        state = updater.State(ctx.components)
        feed = updater.open_feed(ctx, state)
        candidate, reasons = feedmod.select_engine(feed.engine, hardware)
        if not candidate:
            raise ExternalUpdateError('No compatible upstream engine is available: ' + '; '.join(reasons))
        if candidate.platform != current.platform or candidate.backend != current.backend:
            raise ExternalUpdateError('The upstream package targets a different platform or backend.')
        state.save()
        return {'path': str(exe), 'currentVersion': current.version, 'targetVersion': candidate.version,
                'manifestSha256': candidate.manifest_sha256, 'currentManifestSha256': _digest(current.root / ec.MANIFEST),
                'status': 'available' if feedmod.version_key(candidate.version) > feedmod.version_key(current.version) else 'current',
                'downloadBytes': candidate.size, 'source': ctx.source}


def _write_atomic(dest: Path, source: Path):
    fd, tmp = tempfile.mkstemp(prefix='.strata-update-', dir=dest.parent)
    try:
        with os.fdopen(fd, 'wb') as out, source.open('rb') as inp:
            shutil.copyfileobj(inp, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        shutil.copymode(source, tmp)
        os.replace(tmp, dest)
        _sync_dir(dest.parent)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _signed_manifest(folder: Path, trusted: dict):
    if folder.is_symlink() or not folder.is_dir() or folder.resolve() != folder.absolute():
        raise ExternalUpdateError('The saved recovery directory is unavailable or contains a link.')
    _regular(folder / ec.MANIFEST, folder)
    item = ec.read_manifest(folder)
    old = ec._verifier
    signing.install_component_verifier(trusted)
    try:
        ec.verify_signature(item, {ec.ENV_REQUIRE_SIGNED: '1'})
    finally:
        ec.register_signature_verifier(old)
    return item


def _space_requirements(backup_bytes: int, new_bytes: int, restore_temp: int, same_volume: bool):
    # Backups and target files may share a volume; leave enough for the whole
    # staged change and a temporary file when restoring the largest old file.
    target = new_bytes + restore_temp
    return (backup_bytes + target, backup_bytes + target) if same_volume else (backup_bytes, target)


def _exclusive_copy(dest: Path, source: Path):
    # Create a complete file beside the target, then publish only if no file
    # already owns that name. A crash cannot leave a partially written target.
    fd, tmp = tempfile.mkstemp(prefix='.strata-update-', dir=dest.parent)
    try:
        with os.fdopen(fd, 'wb') as out, source.open('rb') as inp:
            shutil.copyfileobj(inp, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        shutil.copymode(source, tmp)
        os.link(tmp, dest)
        _sync_dir(dest.parent)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def recover(exe: Path, trusted: dict, backup_root: Path):
    """Recover an interrupted transaction only when every target still matches a signed version."""
    _private_dir(backup_root)
    journal = backup_root / 'pending.json'
    if not journal.is_file() or journal.is_symlink():
        raise ExternalUpdateError('No pending external-engine update was found.')
    data = json.loads(journal.read_text(encoding='utf-8'))
    root = Path(data['root'])
    backup = Path(data['backup'])
    if root.is_symlink() or not root.is_dir() or root.resolve() != root.absolute():
        raise ExternalUpdateError('The original engine directory is unavailable or has changed. Reconnect it before recovery.')
    if root / data['entrypoint'] != Path(exe) or backup.parent.resolve() != backup_root.resolve() or backup.is_symlink():
        raise ExternalUpdateError('The recovery record does not match the selected engine. Restore from the backup manually.')
    old = _signed_manifest(backup, trusted)
    new_manifest_dir = backup / 'new-manifest'
    new = _signed_manifest(new_manifest_dir, trusted)
    if ((old.entrypoint, old.backend, old.platform) != (new.entrypoint, new.backend, new.platform)
            or old.entrypoint != data['entrypoint'] or _digest(backup / ec.MANIFEST) != data['oldManifestSha256']
            or _digest(new_manifest_dir / ec.MANIFEST) != data['newManifestSha256']):
        raise ExternalUpdateError('The signed recovery manifests do not match.')
    old_hashes = {p: h for p, h, _ in old.files}
    new_hashes = {p: h for p, h, _ in new.files}
    old_hashes[ec.MANIFEST] = _digest(backup / ec.MANIFEST)
    new_hashes[ec.MANIFEST] = _digest(new_manifest_dir / ec.MANIFEST)
    # Validate all files before restoring any. Unknown contents are never overwritten.
    for rel in new_hashes:
        dest = root / rel
        if rel in old_hashes:
            present = _regular(dest, root, absent=True)
            source = backup / rel
            _regular(source, backup)
            if _digest(source) != old_hashes[rel]:
                raise ExternalUpdateError(f'The backup for {rel} is damaged. Restore manually from {backup}.')
            if not present or _digest(dest) not in (old_hashes[rel], new_hashes[rel]):
                raise ExternalUpdateError(f'{dest} changed during recovery; no files restored. Backup: {backup}.')
    # A file absent from the old signed manifest has no proven prior ownership.
    # Even a matching hash does not prove we created it before a crash: keep it.
    retained = [str(root / rel) for rel in new_hashes if rel not in old_hashes
                and ((root / rel).exists() or (root / rel).is_symlink())]
    for rel in reversed(list(new_hashes)):
        dest = root / rel
        if rel in old_hashes:
            if _digest(dest) != old_hashes[rel]:
                _write_atomic(dest, backup / rel)
    journal.unlink()
    _sync_dir(backup_root)
    return {'path': str(exe), 'restoredVersion': old.version, 'backup': str(backup), 'retainedAdditions': retained}


def apply_staged(exe: Path, stage: Path, trusted: dict, backup_root: Path, expected_old: str, expected_new: str):
    """Apply staged signed packages; leave a durable recovery record before writes."""
    current, target = inspect(exe, trusted), _component(Path(stage), trusted)
    root = current.root
    if _digest(root / ec.MANIFEST) != expected_old or _digest(Path(stage) / ec.MANIFEST) != expected_new:
        raise ExternalUpdateError('The engine or offered update changed since preview. Check again.')
    if (current.entrypoint, current.backend, current.platform) != (target.entrypoint, target.backend, target.platform):
        raise ExternalUpdateError('The new package has a different entrypoint, platform or backend. Update manually.')
    old_files = {p.casefold(): p for p, _, _ in current.files}
    new_files = {p.casefold(): p for p, _, _ in target.files}
    if len(old_files) != len(current.files) or len(new_files) != len(target.files) or any(k in old_files and old_files[k] != v for k, v in new_files.items()):
        raise ExternalUpdateError('The package has ambiguous file names; update manually.')
    old_hashes = {p: h for p, h, _ in current.files}
    new_hashes = {p: h for p, h, _ in target.files}
    for rel in new_files.values():
        path = root / rel
        if not path.parent.is_dir():
            raise ExternalUpdateError(f'The new package needs an unrecognised folder ({path.parent}); update manually.')
        if rel.casefold() not in old_files and _regular(path, root, absent=True):
            raise ExternalUpdateError(f'The new package would overwrite an unowned file ({path}); update manually.')
        if rel.casefold() in old_files:
            _regular(path, root)
    replacements = [p for p in new_files.values() if p.casefold() in old_files] + [ec.MANIFEST]
    additions = [p for p in new_files.values() if p.casefold() not in old_files]
    old_hashes[ec.MANIFEST] = expected_old
    needed = sum((root / p).stat().st_size for p in replacements)
    new_size = sum((Path(stage) / p).stat().st_size for p in new_files.values())
    _private_dir(backup_root, create=True)
    journal = backup_root / 'pending.json'
    if journal.exists() or journal.is_symlink():
        raise ExternalUpdateError('An earlier engine update needs recovery. Use Recover before trying again.')
    restore_temp = max(((root / p).stat().st_size for p in replacements), default=0)
    backup_need, target_need = _space_requirements(needed, new_size, restore_temp, backup_root.stat().st_dev == root.stat().st_dev)
    if shutil.disk_usage(backup_root).free < backup_need or shutil.disk_usage(root).free < target_need:
        raise ExternalUpdateError('Not enough free space for the update and its backup.')
    backup = Path(tempfile.mkdtemp(prefix='external-engine-backup-', dir=backup_root))
    for rel in replacements:
        dest = backup / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        _copy_backup(root / rel, dest)
        _sync_dir(dest.parent)
        if _digest(dest) != old_hashes[rel] or _digest(root / rel) != old_hashes[rel]:
            raise ExternalUpdateError('The engine changed or the backup could not be verified; no engine files were changed.')
    (backup / 'new-manifest').mkdir()
    _copy_backup(Path(stage) / ec.MANIFEST, backup / 'new-manifest' / ec.MANIFEST)
    _sync_dir(backup / 'new-manifest')
    _sync_dir(backup)
    record = {'root': str(root), 'backup': str(backup), 'entrypoint': current.entrypoint,
              'oldManifestSha256': expected_old, 'newManifestSha256': expected_new}
    fd, journal_temp = tempfile.mkstemp(prefix='.pending-', dir=backup_root)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(record, f)
            f.flush()
            os.fsync(f.fileno())
        os.link(journal_temp, journal)
        _sync_dir(backup_root)
    finally:
        os.unlink(journal_temp)
    try:
        for rel in additions:
            dest = root / rel
            _regular(dest, root, absent=True)
            _exclusive_copy(dest, Path(stage) / rel)
        for rel in replacements:
            _regular(root / rel, root)
            if _digest(root / rel) != old_hashes[rel]:
                raise ExternalUpdateError(f'{rel} changed during update; refusing to overwrite it.')
            _write_atomic(root / rel, Path(stage) / rel)
        inspect(exe, trusted)
        journal.unlink()
        _sync_dir(backup_root)
    except BaseException as exc:
        try:
            restored = recover(exe, trusted, backup_root)
        except Exception as recovery:
            raise ExternalUpdateError(f'Update interrupted; recovery is required. Backup: {backup}. {recovery}') from exc
        remaining = restored['retainedAdditions']
        note = f' New files were left in place for you to review: {", ".join(remaining)}.' if remaining else ''
        raise ExternalUpdateError(f'Update failed; the previous files were restored. Backup: {backup}.{note} {exc}') from exc
    return {'path': str(exe), 'currentVersion': current.version, 'targetVersion': target.version, 'backup': str(backup)}


def apply(exe: Path, ctx: updater.Context, expected_old: str, expected_new: str, backup_root: Path):
    """Recheck the signed feed and stage into app storage only after confirmation."""
    current = inspect(exe, ctx.trusted)
    hardware = {**ctx.hardware, 'installed_variant': current.variant}
    if hardware.get('backend') != current.backend or hardware.get('platform') != current.platform:
        raise ExternalUpdateError('The selected engine does not match detected hardware or platform. Reconnect the device or update manually.')
    _checked_workdir(ctx.components)
    with updater.update_lock(ctx.components):
        state = updater.State(ctx.components)
        feed = updater.open_feed(ctx, state)
        pkg, reasons = feedmod.select_engine(feed.engine, hardware)
        if not pkg or pkg.manifest_sha256 != expected_new or _digest(current.root / ec.MANIFEST) != expected_old:
            raise ExternalUpdateError('The engine or upstream offer changed since preview. Check again.')
        if feedmod.version_key(pkg.version) <= feedmod.version_key(current.version):
            raise ExternalUpdateError('The selected engine is already current; downgrades are not applied.')
        # Persist accepted feed sequence before touching the external engine.
        # A state write failure after committing would falsely report failure.
        state.save()
        updater.wait_until_idle(ctx.serving, wait=0, emit=ctx.emit, cancel=ctx.cancel)
        _ensure_not_running(exe)
        updater._free_space_check(ctx.components, pkg.size + pkg.installed_bytes, ctx, pkg.sha256, 'engine')
        # A fresh workspace prevents the updater from following pre-planted
        # partial-download links or deleting a pre-existing staging folder.
        with tempfile.TemporaryDirectory(prefix='.external-stage-', dir=ctx.components) as work:
            staging = replace(ctx, components=Path(work))
            archive = updater._download(staging, 'engine', pkg.url, pkg.size, pkg.sha256, pkg.label, feed)
            stage_root, staged = updater.stage_engine(staging, feed, pkg, archive)
            try:
                updater.wait_until_idle(ctx.serving, wait=0, emit=ctx.emit, cancel=ctx.cancel)
                with _exclusive_runtime():
                    _ensure_not_running(exe)
                    return apply_staged(exe, staged.root, ctx.trusted, backup_root, expected_old, expected_new)
            finally:
                shutil.rmtree(stage_root, ignore_errors=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--exe')
    p.add_argument('--state', required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--recover', action='store_true')
    p.add_argument('--status', action='store_true')
    p.add_argument('--old-sha')
    p.add_argument('--new-sha')
    p.add_argument('--progress-json', action='store_true')
    p.add_argument('--list-backups', action='store_true')
    p.add_argument('--delete-backup')
    a = p.parse_args()
    try:
        state = Path(a.state)
        _private_dir(state, create=True)
        if a.list_backups:
            print(json.dumps({'ok':True,'backups':list_backups(state,signing.load_trusted_keys())},ensure_ascii=False))
            return 0
        if a.delete_backup:
            result=delete_backup(state,a.delete_backup,signing.load_trusted_keys(),Path(a.exe) if a.exe else None)
            print(json.dumps({'ok':True,'deleted':result},ensure_ascii=False))
            return 0
        if a.status:
            pending = state / 'backups' / 'pending.json'
            if pending.exists() or pending.is_symlink():
                try:
                    if pending.is_symlink():
                        raise ValueError('linked recovery record')
                    data = json.loads(pending.read_text(encoding='utf-8'))
                    print(json.dumps({'ok': True, 'recoveryRequired': True, 'path': str(Path(data['root']) / data['entrypoint']), 'backup': data['backup']}, ensure_ascii=False))
                except (ValueError, OSError, KeyError, TypeError):
                    print(json.dumps({'ok': True, 'recoveryRequired': True, 'path': None, 'error': 'The recovery record is unreadable; restore the saved backup manually.'}))
            else:
                print(json.dumps({'ok': True, 'recoveryRequired': False}))
            return 0
        if not a.exe:
            raise ExternalUpdateError('Choose the external engine first.')
        if not a.recover:
            pending = state / 'backups' / 'pending.json'
            if pending.exists() or pending.is_symlink():
                raise ExternalUpdateError('An earlier engine update needs recovery. Use Recover before trying again.')
        source = _feed_source(SimpleNamespace(feed=None), ec.components_dir())
        def report_progress(event):
            if a.progress_json and event.get('event') == 'progress' and event.get('phase') == 'download':
                print('STRATA_PROGRESS ' + json.dumps({'done': event.get('done'), 'total': event.get('total')}), file=sys.stderr, flush=True)
        ctx = updater.Context(components=state / 'components', source=source, trusted=signing.load_trusted_keys(), hardware=updater.detect_hardware(), emit=report_progress)
        if a.recover:
            with _exclusive_runtime():
                _ensure_not_running(Path(a.exe))
                result = recover(Path(a.exe), ctx.trusted, state / 'backups')
        elif a.apply:
            if not a.old_sha or not a.new_sha:
                raise ExternalUpdateError('Review and confirm the update first.')
            result = apply(Path(a.exe), ctx, a.old_sha, a.new_sha, state / 'backups')
        else:
            result = preview(Path(a.exe), ctx)
        result['path'] = a.exe
        print(json.dumps({'ok': True, **result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
