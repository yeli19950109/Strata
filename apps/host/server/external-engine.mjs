/** An engine chosen by the user stays in place. This module never runs or modifies it. */
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createExternalEngine(directory) {
  const file = join(directory, 'external-engine.json');
  function saved() {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      return typeof value.path === 'string' && isAbsolute(value.path) && !/[\0\r\n]/.test(value.path) ? value.path : null;
    } catch { return null; }
  }
  function check(path) {
    if (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)) return 'Choose an absolute path to an engine executable.';
    try {
      if (!statSync(path).isFile()) return 'Choose an engine executable, not a folder.';
      accessSync(path, process.platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK);
      return null;
    } catch { return 'The engine file is unavailable or cannot be read or executed. Check the path and reconnect its drive.'; }
  }
  function status() {
    const path = saved();
    if (!path) return { selected: false, usable: false, path: null, notice: null };
    const notice = check(path);
    return { selected: true, usable: !notice, path, notice };
  }
  function select(path) {
    const notice = check(path);
    if (notice) throw new Error(notice);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, `.external-engine-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify({ path }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temp, file);
    } finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
    return status();
  }
  function clear() {
    try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return status();
  }
  return { status, select, clear };
}
