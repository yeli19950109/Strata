/**
 * The engine folder the person chose (Settings, "Use an existing engine"). It is the app's engine folder from then on, the same as
 * <components>/engine: Control starts, updates, rolls back and removes the engines in it (STRATA_ENGINE_DIR). Nothing is copied.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ENGINE_DIR_ENV = 'STRATA_ENGINE_DIR';
const MANIFEST = 'engine-component.json';
const plain = path => typeof path === 'string' && isAbsolute(path) && !/[\0\r\n]/.test(path);
const isDir = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const hasPackages = folder => { try { return readdirSync(folder, { withFileTypes: true }).some(e => e.isDirectory() && existsSync(join(folder, e.name, MANIFEST))); } catch { return false; } };

/** The engine folder for what was picked. An engine package is used as it is (a source checkout's engine/ is one, and Control reads a
 *  package folder as the engine folder); a folder with an engine/ in it (a component folder, a checkout) means that engine/. */
export function engineFolderOf(picked) {
  const folder = resolve(picked);
  if (existsSync(join(folder, MANIFEST))) return folder;
  const inner = join(folder, 'engine');
  if (existsSync(join(inner, MANIFEST)) || (!hasPackages(folder) && isDir(inner))) return inner;
  return folder;
}

export function createEngineFolder(directory, { env = process.env } = {}) {
  const file = join(directory, 'engine-folder.json');
  const old = join(directory, 'external-engine.json');           // what an earlier version kept: the engine executable
  function saved() {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      return plain(value.path) ? engineFolderOf(value.path) : null;
    } catch { /* none yet */ }
    try {
      const value = JSON.parse(readFileSync(old, 'utf8'));
      return plain(value.path) ? engineFolderOf(dirname(value.path)) : null;
    } catch { return null; }
  }
  function status() {
    const path = saved();
    if (!path) return { selected: false, usable: false, path: null, notice: null };
    const usable = isDir(path);
    return { selected: true, usable, path, notice: usable ? null : 'The engine folder is unavailable. Reconnect its drive or choose the folder again.' };
  }
  /** Control reads the folder from the environment of every process the app starts. */
  function apply() {
    const path = saved();
    if (path) env[ENGINE_DIR_ENV] = path; else delete env[ENGINE_DIR_ENV];
    return status();
  }
  function write(value) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, `.engine-folder-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temp, file);
    } finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
  }
  function select(picked) {
    if (!plain(picked)) throw new Error('Choose an absolute path to an engine folder.');
    if (!isDir(picked)) throw new Error('Choose a folder that exists. Reconnect its drive if it is on another disk.');
    const path = engineFolderOf(picked);
    write({ path });
    try { unlinkSync(old); } catch { /* none */ }
    return apply();
  }
  function clear() {
    for (const name of [file, old]) try { unlinkSync(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return apply();
  }
  return { status, select, clear, apply };
}
