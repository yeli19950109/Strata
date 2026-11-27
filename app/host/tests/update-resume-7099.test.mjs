import './helpers/isolate-profile.mjs';   // a test run never writes the owner's real Strata profile
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeControl } from '../server/native-control.mjs';
import { createAgentBridge } from '../server/agent/agent-bridge.mjs';

/**
 * #7099: "Update Strata" paused the chat agent (agent.prepareForUpdate) and only a host restart cleared the pause. Whenever no installer took over, the app never restarted and every chat turn failed with "Agent work is paused for the Strata update. Restart Strata to resume."
 * The pause now ends when the update job ends without an app install (nothing new, failed, cancelled) and stays only once the app installer took over.
 */

const ROOT = mkdtempSync(join(tmpdir(), 'strata-a7099-'));
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

function fixture({ appCheck, appVerdict = { available: false }, appInstall, beforeUpdate } = {}) {
  const root = mkdtempSync(join(ROOT, 'n-'));
  const install = join(root, 'install'), data = join(root, 'data');
  mkdirSync(install, { recursive: true });
  process.env.STRATA_INSTALL_DIR = install;
  const events = [];
  const control = {
    control: { dir: join(root, 'control') }, version: '0.1.67',
    async installedModels() { return { install_dir: install, models: [] }; },
    async engine() { return { usable: true, backend: 'cuda', components_dir: join(root, 'c'), previous: null, engine: { version: '0.1.67', platform: 'windows-x86_64', backend: 'cuda', exe: 'e', root: 'r' } }; },
    async saveProfile() { return {}; }, async start() { return { ok: true, state: 'ready' }; }, async stop() { return { ok: true }; },
    async update(options) {
      events.push('engine-update');
      assert.equal(options.engine, true);
      assert.equal(options.control, false, 'managed Control updates with the app, not the engine');
      return { ok: true, results: [{ component: 'engine', status: 'updated' }] };
    },
  };
  const appUpdater = {
    async check() { events.push('app-check'); return appCheck ? appCheck() : appVerdict; },
    async install(options) { events.push('app-install'); return appInstall ? appInstall(options) : { state: 'done' }; },
  };
  const native = createNativeControl({
    control, appUpdater, directory: data,
    beforeUpdate: async () => { events.push('pause'); await beforeUpdate?.(); },
    afterUpdate: async () => { events.push('resume'); },
    spawnProcess: () => { throw new Error('no process'); }, fetcher: async () => Response.json({}), requests: () => [],
  });
  return { native, events };
}
const finish = async (native, id) => { for (let i = 0; i < 400; i++) { const job = native.state().jobs.find(j => j.id === id); if (job.state !== 'running') return job; await new Promise(r => setTimeout(r, 10)); } throw new Error('job did not finish'); };
const run = async f => { await f.native.refresh(true); return finish(f.native, f.native.operation('update-strata', {}).id); };

test('nothing new to install: the agent is resumed as well', async () => {
  const f = fixture();
  try {
    const job = await run(f);
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(f.events, ['pause', 'app-check', 'resume']);
    assert.equal(job.summary, 'The app is up to date.');
  } finally { await f.native.close(); }
});

test('a failed app feed check resumes the agent', async () => {
  const f = fixture({ appCheck: async () => { throw new Error('The download list could not be read.'); } });
  try {
    const job = await run(f);
    assert.equal(job.state, 'error');
    assert.deepEqual(f.events, ['pause', 'app-check', 'resume']);
  } finally { await f.native.close(); }
});

test('a pause that cannot be confirmed fails the job before anything is changed, and the agent is resumed', async () => {
  const f = fixture({ beforeUpdate: async () => { throw new Error('Helper stop unconfirmed'); } });
  try {
    const job = await run(f);
    assert.equal(job.state, 'error');
    assert.match(job.error, /unconfirmed/);
    assert.deepEqual(f.events, ['pause', 'resume'], 'neither updater ran');
  } finally { await f.native.close(); }
});

test('a cancelled update resumes the agent', async () => {
  let aborted = false;
  const f = fixture({
    appVerdict: { available: true, version: '0.2.2202' },
    appInstall: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(new Error('aborted'));
    }, { once: true })),
  });
  try {
    await f.native.refresh(true);
    const started = f.native.operation('update-strata', {});
    for (let i = 0; i < 200 && !f.events.includes('app-install'); i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(f.events, ['pause', 'app-check', 'app-install']);
    await f.native.cancel(started.id);
    const job = await finish(f.native, started.id);
    assert.equal(job.state, 'cancelled');
    assert.equal(aborted, true, 'cancellation reached the app installer');
    for (let i = 0; i < 200 && !f.events.includes('resume'); i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(f.events, ['pause', 'app-check', 'app-install', 'resume']);
  } finally { await f.native.close(); }
});

test('a new app is installed: the pause stays, the installer restarts Strata', async () => {
  const f = fixture({ appVerdict: { available: true, version: '0.2.2202' } });
  try {
    const job = await run(f);
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(f.events, ['pause', 'app-check', 'app-install'], 'no resume after the app installer took over');
    assert.match(job.summary, /Strata will restart/);
    assert.doesNotMatch(job.summary, /quit Strata/, 'the app restarts by itself: no instruction to quit');
  } finally { await f.native.close(); }
});

test('the app installer ends the app before it returns: the pause stays', async () => {
  const f = fixture({ appVerdict: { available: true, version: '0.2.2202' }, appInstall: () => new Promise(() => {}) });
  try {
    await f.native.refresh(true);
    const started = f.native.operation('update-strata', {});
    await new Promise(r => setTimeout(r, 100));
    assert.equal(f.native.state().jobs.find(j => j.id === started.id).state, 'running');
    assert.deepEqual(f.events, ['pause', 'app-check', 'app-install']);
  } finally { await f.native.close(); }
});

test('the app installer fails (nothing was installed, the app keeps running): the agent is resumed', async () => {
  const f = fixture({ appVerdict: { available: true, version: '0.2.2202' }, appInstall: async () => { throw new Error('signature mismatch'); } });
  try {
    const job = await run(f);
    assert.equal(job.state, 'error');
    assert.equal(job.details, 'signature mismatch');
    assert.deepEqual(f.events, ['pause', 'app-check', 'app-install', 'resume']);
  } finally { await f.native.close(); }
});

test('other jobs never touch the agent pause', async () => {
  const f = fixture();
  try {
    await f.native.refresh(true);
    const job = await finish(f.native, f.native.operation('update-engine', {}).id);
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(f.events, ['engine-update']);
  } finally { await f.native.close(); }
});

// ---------------------------------------------------------------------------------------------- the real bridge

function bridge() {
  const dir = mkdtempSync(join(ROOT, 'b-'));
  return createAgentBridge({ dataDir: dir, connections: () => [], localInstances: () => [] });
}
const turn = b => b.runTurn({ chatId: 'chat-1', message: 'hello', workspacePath: ROOT, mode: 'bypass', onFrame: () => {} });
const pausedCode = async b => { try { await turn(b); return null; } catch (error) { return error.code ?? String(error); } };

test('the bridge: resumeAfterUpdate lifts the pause, the cached preparation and the marker the Harness reads', async () => {
  const b = bridge();
  try {
    const report = await b.prepareForUpdate();
    const marker = join(dirname(report.checkpoint), 'paused');
    assert.ok(existsSync(marker), 'the Harness refuses its tools while this file exists');
    assert.equal(await pausedCode(b), 'update-paused');
    assert.deepEqual(await b.resumeAfterUpdate(), { resumed: true });
    assert.equal(existsSync(marker), false);
    assert.ok(existsSync(report.checkpoint), 'the saved checkpoint stays');
    assert.notEqual(await pausedCode(b), 'update-paused', 'the turn gets past the pause (without a Harness here it stops for another reason)');
    const again = await b.prepareForUpdate();
    assert.notEqual(again.checkpoint, undefined);
    assert.ok(existsSync(marker), 'a later update can pause again: the preparation is not cached any more');
    assert.equal(await pausedCode(b), 'update-paused');
  } finally { await b.close(); }
});

test('the bridge: resuming when nothing is paused does nothing', async () => {
  const b = bridge();
  try { assert.deepEqual(await b.resumeAfterUpdate(), { resumed: false }); } finally { await b.close(); }
});

test('end to end: an app-only update check through the real bridge leaves chat working', async () => {
  const b = bridge();
  let sawPause = false;
  // the native control with the real bridge wired as server/index.mjs does
  const root = mkdtempSync(join(ROOT, 'e-'));
  const install = join(root, 'install');
  mkdirSync(install, { recursive: true });
  process.env.STRATA_INSTALL_DIR = install;
  const control = {
    control: { dir: join(root, 'control') }, version: '0.1.67',
    async installedModels() { return { install_dir: install, models: [] }; },
    async engine() { return { usable: true, backend: 'cuda', components_dir: join(root, 'c'), previous: null, engine: { version: '0.1.67', platform: 'windows-x86_64', backend: 'cuda', exe: 'e', root: 'r' } }; },
    async saveProfile() { return {}; }, async start() { return { ok: true, state: 'ready' }; }, async stop() { return { ok: true }; },
    async update() { assert.fail('Control must not be downloaded separately'); },
  };
  const native = createNativeControl({ control, appUpdater: { check: async () => { sawPause = (await pausedCode(b)) === 'update-paused'; return { available: false }; }, install: async () => { throw new Error('never'); } }, directory: join(root, 'data'),
    beforeUpdate: () => b.prepareForUpdate(), afterUpdate: () => b.resumeAfterUpdate(),
    spawnProcess: () => { throw new Error('no process'); }, fetcher: async () => Response.json({}), requests: () => [] });
  try {
    const job = await run({ native });
    assert.equal(job.state, 'done', job.error);
    assert.equal(sawPause, true, 'the agent is paused while the app feed is checked');
    assert.notEqual(await pausedCode(b), 'update-paused', 'and works again once the update ended without an app install');
  } finally { await native.close(); await b.close(); }
});
