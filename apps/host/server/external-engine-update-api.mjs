/** Explicit, serialized access to the signed external-engine update transaction. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { controlEnvironment } from './control-runtime.mjs';

export function runModule(control, args, { spawnProcess = spawn, timeoutMs = 3 * 3600_000, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(control.python, ['-m', 'strata_control.external_engine_update', ...args], {
      cwd: control.dir, env: controlEnvironment(control, { acquire: !args.includes('--recover') }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', progressBuffer = '', timeout = false, oversized = false, done = false, forceKill = null;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(alarm); if(forceKill)clearTimeout(forceKill); fn(value); };
    const stop = () => { try{child.kill();}catch{} if(!forceKill)forceKill=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},10000); };
    const alarm = setTimeout(() => { timeout = true; stop(); }, timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 1_000_000) { oversized = true; stop(); } });
    child.stderr.on('data', chunk => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split('\n'); progressBuffer = lines.pop().slice(-20000);
      for (const line of lines) {
        if (line.startsWith('STRATA_PROGRESS ')) { try { onProgress(JSON.parse(line.slice(16))); } catch { /* ignore malformed progress */ } }
        else err = (err + line + '\n').slice(-20000);
      }
    });
    child.on('error', error => finish(reject, new Error(`Could not start the external engine update: ${error.message}`)));
    // Wait for close after a timeout or overflow: the caller's lock must not be released while the child still runs.
    child.on('close', code => {
      if (progressBuffer && !progressBuffer.startsWith('STRATA_PROGRESS ')) err = (err + progressBuffer).slice(-20000);
      if (timeout) return finish(reject, new Error('The external engine update timed out. Check for an interrupted update before retrying.'));
      if (oversized) return finish(reject, new Error('The external engine update returned too much data.'));
      let value; try { value = JSON.parse(out.trim()); } catch { return finish(reject, new Error(err.trim() || 'The external engine update returned an invalid response.')); }
      if (code !== 0 || value?.ok !== true) return finish(reject, new Error(typeof value?.error === 'string' ? value.error : value?.error?.message || err.trim() || 'The external engine update failed.'));
      finish(resolve, value);
    });
  });
}

/** The host supplies an exclusive gate shared with all operations that could start or move files. */
export function createExternalEngineUpdate({ control, directory, selected, exclusive, run = runModule, now = Date.now }) {
  let preview = null, progress = { active: false, done: 0, total: 0 };
  const pending = () => {try {lstatSync(join(directory, 'external-engine-updates', 'backups', 'pending.json')); return true;} catch (e) {if (e.code === 'ENOENT') return false; throw e;} };
  const hashes = value => /^[a-f0-9]{64}$/i.test(value ?? '');
  const getPath = (requireUsable = true) => { const current = selected(); if (!current?.selected || !current.path || (requireUsable && !current.usable)) throw new Error(current?.notice || 'Choose an available existing engine first.'); return current.path; };
  const invoke = (path, extra = [], options = {}) => {
    if (!control?.control) throw new Error('The bundled Strata Control is not available.');
    return run(control.control, ['--exe', path, '--state', join(directory, 'external-engine-updates'), ...(extra.includes('--apply') ? ['--progress-json'] : []), ...extra], options);
  };
  return {
    pending,
    status() { return { progress: { ...progress } }; },
    async backups() {
      if (!control?.control) throw new Error('The bundled Strata Control is not available.');
      const result=await run(control.control,['--state',join(directory,'external-engine-updates'),'--list-backups']);
      if(!Array.isArray(result.backups))throw new Error('The engine backups could not be read.');
      return result.backups;
    },
    async deleteBackup(id) { return exclusive(async()=>{
      if(typeof id!=='string'||!/^external-engine-backup-[a-z0-9_]{8}$/.test(id))throw new Error('Choose an app-managed engine backup.');
      if(pending())throw new Error('Restore the interrupted update before deleting backups.');
      if(!control?.control)throw new Error('The bundled Strata Control is not available.');
      const path=selected()?.path;
      return run(control.control,['--state',join(directory,'external-engine-updates'),...(path?['--exe',path]:[]),'--delete-backup',id]);
    }); },
    async check() { return exclusive(async () => {
      preview = null;
      const path = getPath(), result = await invoke(path);
      if (result.path !== path || !['available','current'].includes(result.status) || !hashes(result.currentManifestSha256) || !hashes(result.manifestSha256)) throw new Error('The update check did not return a valid, matching engine plan.');
      const token = randomUUID(); preview = result.status === 'available' ? { token, path, old: result.currentManifestSha256, next: result.manifestSha256, at: now() } : null;
      return { ...result, confirmationToken: token };
    }); },
    async apply(token) { return exclusive(async () => {
      const plan = preview; preview = null;
      if (!plan || typeof token !== 'string' || token !== plan.token || now() - plan.at > 30 * 60_000) throw new Error('Check the engine update again before confirming.');
      const path = getPath(); if (path !== plan.path) throw new Error('The selected engine changed. Check the update again.');
      progress = { active: true, done: 0, total: 0 };
      try {
        const result = await invoke(path, ['--apply', '--old-sha', plan.old, '--new-sha', plan.next], { onProgress: value => {
          if (Number.isFinite(value.done) && Number.isFinite(value.total) && value.done >= 0 && value.total > 0 && value.done <= value.total) progress = { active: true, done: value.done, total: value.total };
        } });
        progress = { ...progress, outcome: 'done', warning: result.warning ?? null }; return result;
      } catch (error) { progress = { ...progress, outcome: 'error', error: error.message }; throw error; }
      finally { progress = { ...progress, active: false }; }
    }); },
    async recover() { return exclusive(async () => {
      preview = null;
      let path = selected()?.path;
      if (pending()) {
        const journal = join(directory, 'external-engine-updates', 'backups', 'pending.json'), info = lstatSync(journal);
        if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new Error('The recovery record is invalid. Restore the engine from its backup manually.');
        const record = JSON.parse(readFileSync(journal, 'utf8'));
        if (typeof record.root !== 'string' || !isAbsolute(record.root) || typeof record.entrypoint !== 'string' || !record.entrypoint || isAbsolute(record.entrypoint) || record.entrypoint.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('The recovery record is invalid. Restore the engine from its backup manually.');
        path = join(record.root, record.entrypoint);
      }
      return invoke(path, ['--recover']);
    }); },
  };
}
