/** Validate legacy run configurations without reading or running the files they name. */
import { isAbsolute, join, dirname, basename } from 'node:path';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkAndParseRunConfig, describeIssues } from './run-config-check.mjs';

// A drive-relative path (C:foo or \\foo) depends on process state and is not absolute.
const absolute = value => isAbsolute(value) || /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value);
const usablePath = (value, cwd) => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/.test(value) && (absolute(value) || (absolute(cwd ?? '') && !/^(?:[a-z]:|[\\/])/i.test(value)));
const ID = /^[a-z0-9](?:[a-z0-9_-]|\.(?!\.)){0,79}$/i;
const MAX_BYTES = 1024 * 1024;

/** Reject a symlink (including a Windows junction) before treating this as private storage. */
export function checkedLegacyDirectory(directory, { create = false } = {}) {
  if (create) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The imported configuration folder is not a private directory.');
  const actual = realpathSync(directory), expected = join(realpathSync(dirname(directory)), basename(directory));
  if (process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) throw new Error('The imported configuration folder is not a private directory.');
  return actual;
}

/** Returns the original text and parsed content for an explicit confirmation step. */
export function previewLegacyRunConfig(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Choose a JSON file under 1 MiB.');
  const checked = checkAndParseRunConfig(text);
  if (!checked.ok) throw new Error(describeIssues(checked.issues, 'error').join(' '));
  const config = checked.config;
  for (const key of ['exe', 'tokenizer']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`"${key}" must name a file or folder.`);
  }
  if (!Array.isArray(config.args) || config.args.some(x => typeof x !== 'string')) throw new Error('"args" must be a list of text entries.');
  for (const key of ['exe', 'cwd', 'tokenizer', 'log']) {
    if (config[key] !== undefined && !usablePath(config[key], key === 'exe' ? config.cwd : undefined)) throw new Error(key === 'exe' ? '"exe" must be absolute or relative to an absolute cwd.' : `"${key}" must be an absolute path.`);
  }
  if (config.lib_dirs !== undefined && (!Array.isArray(config.lib_dirs) || config.lib_dirs.some(x => !usablePath(x)))) throw new Error('"lib_dirs" must be a list of absolute paths.');
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env) || Object.values(config.env).some(x => typeof x !== 'string'))) throw new Error('"env" must contain text values.');
  // Relative paths are safe only with an absolute cwd, which is retained on import.
  // MTP may also be a numeric draft depth.
  const pathFlags = new Set(['--pack', '--native', '--ple-gguf', '--expert-profile', '--mtp']);
  for (let i = 0; i < config.args.length; i++) if (pathFlags.has(config.args[i])) {
    const value = config.args[++i];
    if (!value || !(config.args[i - 1] === '--mtp' && /^\d+$/.test(value)) && !usablePath(value, config.cwd)) throw new Error(`"${config.args[i - 1]}" must name an absolute path or a path relative to an absolute cwd.`);
  }
  const issues = checked.issues.map(issue => issue.code === 'args-managed' ? {...issue, message: 'Network flags in args are passed to the engine. They do not configure the app server; check that your engine accepts them.'} : issue);
  return { text, config, issues, overrides: ['The app server uses localhost, chooses its own port and API key, and disables automatic browser opening.', 'The app adds a model alias and may increase the startup timeout. The engine receives the listed args in order; separate settings that normally rewrite those args are not applied.', 'The server may adjust GPU and HIP environment settings for the selected hardware.'] };
}

/** Save only a confirmed snapshot, exclusively: never replace an existing model. */
export function saveLegacyRunConfig(directory, id, text, ops = { openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync }) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Choose a model name using letters, numbers, dots, hyphens or underscores.');
  previewLegacyRunConfig(text);
  const root = checkedLegacyDirectory(directory), target = join(root, `strata-${id}.json`);
  const temp = join(root, `.legacy-import-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = ops.openSync(temp, 'wx', 0o600);
    ops.writeFileSync(fd, text);
    ops.fsyncSync(fd);
    ops.closeSync(fd); fd = undefined;
    // Same-directory hard-link creation is atomic and fails if target exists,
    // including a dangling symlink; it never replaces an existing record.
    ops.linkSync(temp, target);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('A model with this name already exists. Choose another name.');
    if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM'].includes(error.code)) throw new Error('This filesystem cannot safely save an imported configuration. Choose a supported app data location.');
    throw error;
  } finally {
    if (fd !== undefined) try { ops.closeSync(fd); } catch { /* preserve the original error */ }
    try { ops.unlinkSync(temp); } catch { /* the committed record remains valid; a leftover temp is harmless */ }
  }
  return target;
}
