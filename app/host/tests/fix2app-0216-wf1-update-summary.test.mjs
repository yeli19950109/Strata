import './helpers/isolate-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeControl } from '../server/native-control.mjs';
import { createAppUi, BROWSER_UPDATE_MESSAGE } from '../server/app-ui.mjs';
import { APP_UPDATER_NOT_READY } from '../server/update-messages.mjs';

/**
 * On the fork, the signed app installer carries Control. The job must not update bundled
 * Control independently, or report success if the app update check did not work.
 */
function fixture({ appUpdater }) {
  const calls = [];
  const root = mkdtempSync(join(tmpdir(), 'strata-wf1-'));
  const install = join(root, 'install'), data = join(root, 'data');
  mkdirSync(install, { recursive: true });
  process.env.STRATA_INSTALL_DIR = install;
  const control = {
    control: { dir: join(root, 'control') }, version: '0.1.62',
    async installedModels() { return { install_dir: install, models: [] }; },
    async engine() { return { usable: true, backend: 'cuda', components_dir: join(root, 'c'), previous: null, engine: { version: '0.1.62', platform: 'windows-x86_64', backend: 'cuda', exe: 'e', root: 'r' } }; },
    async saveProfile() { return {}; }, async start() { return { ok: true, state: 'ready' }; }, async stop() { return { ok: true }; },
    async update(options) {
      calls.push(options);
      throw new Error('Update Strata must not fetch a separate Control update');
    },
  };
  const native = createNativeControl({ control, appUpdater, directory: data, spawnProcess: () => { throw new Error('no process'); }, fetcher: async () => Response.json({}), requests: () => [] });
  return { native, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const finish = async (native, id) => { for (let i = 0; i < 400; i++) { const job = native.state().jobs.find(j => j.id === id); if (job.state !== 'running') return job; await new Promise(r => setTimeout(r, 10)); } throw new Error('job did not finish'); };
const run = async f => { await f.native.refresh(true); return finish(f.native, f.native.operation('update-strata', {}).id); };

function failedWithoutChangingControl(f, job, details) {
  assert.deepEqual(f.calls, [], 'the bundled Control was not touched');
  assert.equal(job.state, 'error');
  assert.equal(job.details, details);
  assert.match(job.summary, /nothing was changed/);
  assert.doesNotMatch(job.summary, /up to date|is updated/);
}

test('without an updater, the fork refuses to fetch Control separately', async () => {
  const f = fixture({});
  try {
    failedWithoutChangingControl(f, await run(f), 'The desktop app updater is unavailable. Open the fork release page to update the app.');
  } finally { await f.native.close(); f.cleanup(); }
});

test('before the window hands over its updater, the job keeps the retry reason', async () => {
  const ui = createAppUi({ env: { STRATA_UI_MODE: 'window' } });
  const f = fixture({ appUpdater: ui.updater });
  try {
    failedWithoutChangingControl(f, await run(f), APP_UPDATER_NOT_READY);
  } finally { await f.native.close(); f.cleanup(); }
});

test('an unreachable fork feed is a check failure, not an up-to-date result', async () => {
  const failure = 'The Strata app could not check for updates (502).';
  const f = fixture({ appUpdater: { check: async () => { throw new Error(failure); }, install: async () => assert.fail('nothing to install') } });
  try {
    const lines = [], original = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { failedWithoutChangingControl(f, await run(f), failure); } finally { console.log = original; }
    assert.ok(lines.includes(`update · update-strata failed: ${failure}`), lines.join('\n'));
  } finally { await f.native.close(); f.cleanup(); }
});

test('browser mode still explains how to open the app to update it', async () => {
  const ui = createAppUi({ env: { STRATA_UI_MODE: 'browser' } });
  const f = fixture({ appUpdater: ui.updater });
  try {
    failedWithoutChangingControl(f, await run(f), BROWSER_UPDATE_MESSAGE);
  } finally { await f.native.close(); f.cleanup(); }
});

test('an app update that was found and then fails to install is still a real failure', async () => {
  const failure = 'The app update failed.';
  const f = fixture({ appUpdater: { check: async () => ({ available: true, version: '0.2.2202' }), install: async () => { throw new Error(failure); } } });
  try {
    failedWithoutChangingControl(f, await run(f), failure);
  } finally { await f.native.close(); f.cleanup(); }
});
