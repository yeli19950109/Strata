/** Validate legacy run configurations without reading or running the files they name. */
import { isAbsolute, join, dirname, basename } from 'node:path';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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

/** Recognise the publisher's local SC117 shard names without guessing a pack or downloading files. */
export function identifySc117(config) {
  const args=Array.isArray(config?.args)?config.args:[];
  const value=flag=>{const i=args.indexOf(flag);return i>=0?args[i+1]:null;};
  const first=value('--native'),second=value('--ple-gguf');
  const name=p=>typeof p==='string'?p.split(/[\\/]/).pop():'';
  const match=/^Qwen3\.8-Flash-Next-GSQ-RCO-abliterated-(IQ3_XXS|IQ3_S|IQ2_XS|Q2_0)-00001-of-00002\.gguf$/i.exec(name(first));
  if(!match)return null;
  const expected=`Qwen3.8-Flash-Next-GSQ-RCO-abliterated-${match[1]}-00002-of-00002.gguf`;
  return {family:'SC117 Qwen3.8-Flash-Next GSQ-RCO abliterated',quant:match[1].toUpperCase(),shardsMatch:name(second).toLowerCase()===expected.toLowerCase(),pack:value('--pack'),mtp:value('--mtp')};
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
  return { text, config, issues, knownModel:identifySc117(config), overrides: ['The app server uses localhost, chooses its own port and API key, and disables automatic browser opening.', 'The app adds a model alias and may increase the startup timeout. The engine receives the listed args in order; separate settings that normally rewrite those args are not applied.', 'The server may adjust GPU and HIP environment settings for the selected hardware.'] };
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

/** Replace only the app-owned copy, after validating and checking for concurrent edits. */
export function updateLegacyRunConfig(directory, id, text, expectedHash) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Choose an imported configuration.');
  previewLegacyRunConfig(text);
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? '')) throw new Error('Reload the configuration before saving.');
  const root=checkedLegacyDirectory(directory), target=join(root,`strata-${id}.json`), info=lstatSync(target);
  if(info.isSymbolicLink()||!info.isFile()||dirname(realpathSync(target))!==root) throw new Error('The imported configuration is not a regular app-owned file.');
  const digest=()=>createHash('sha256').update(readFileSync(target)).digest('hex');
  if(digest()!==expectedHash) throw new Error('The configuration changed since it was opened. Reload it before saving.');
  const temp=join(root,`.legacy-edit-${randomUUID()}.tmp`);let fd;
  try {
    fd=openSync(temp,'wx',0o600);writeFileSync(fd,text);fsyncSync(fd);closeSync(fd);fd=undefined;
    const current=lstatSync(target);
    if(current.isSymbolicLink()||!current.isFile()||digest()!==expectedHash)throw new Error('The configuration changed since it was opened. Reload it before saving.');
    renameSync(temp,target);
  } finally {if(fd!==undefined)try{closeSync(fd);}catch{}try{unlinkSync(temp);}catch{}}
}
