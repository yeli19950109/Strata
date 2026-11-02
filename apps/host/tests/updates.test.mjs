import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUpdates } from '../server/updates.mjs';
const installed = { appVersion: '0.1.0', engineVersion: 'strata-engine 0.1.0' };
const response = releases => async () => ({ ok: true, json: async () => releases });
const release = (tag, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/yeli19950109/Strata/releases/tag/${tag}`, ...extra });

test('release checks compare stable versions and preserve installer capability truth', async () => {
  const result = await checkUpdates(installed, response([release('v0.1.0'), release('v0.2.0'), release('v0.3.0', { prerelease: true }), release('v0.4.0', { draft: true })]));
  assert.equal(result.strata.status, 'available');
  assert.equal(result.strata.latestVersion, 'v0.2.0');
  assert.equal(result.strata.canInstall, false);
  assert.equal(result.engine.status, 'unavailable');
  assert.equal(result.engine.canInstall, false);
  assert.equal((await checkUpdates(installed, response([release('v0.1.0')]))).strata.status, 'current');
});
test('empty, failed and unknown release checks never claim up to date', async () => {
  assert.equal((await checkUpdates(installed, response([]))).strata.status, 'no-releases');
  assert.equal((await checkUpdates(installed, async () => ({ ok: false, status: 403 }))).strata.status, 'error');
  assert.equal((await checkUpdates({ ...installed, appVersion: 'development' }, response([release('v0.2.0')]))).strata.status, 'unavailable');
  assert.equal((await checkUpdates(installed, response({ invalid: true }))).strata.status, 'error');
});
test('release content cannot inject an external or script update link', async () => {
  const result = await checkUpdates(installed, response([release('v0.2.0', { html_url: 'javascript:alert(1)' })]));
  assert.equal(result.strata.status, 'available');
  assert.equal(result.strata.releaseUrl, undefined);
});

test('offline, "Check for updates" says there is no internet connection instead of "fetch failed"', async () => {
  const offline = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) }); };
  const result = await checkUpdates(installed, offline);
  assert.equal(result.strata.status, 'error');
  assert.equal(result.strata.message, "No internet connection. Try again when you're online.");
  for (const reason of ['EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH']) {
    const r = await checkUpdates(installed, async () => { throw Object.assign(new Error('connect failed'), { code: reason }); });
    assert.equal(r.strata.message, "No internet connection. Try again when you're online.", reason);
  }
  // a slow or broken server is not "offline"
  const slow = await checkUpdates(installed, async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
  assert.equal(slow.strata.message, 'The release check timed out. Try again.');
});


test('app release metadata uses the fork and rejects links to upstream', async () => {
  const calls=[];
  const result=await checkUpdates(installed, async url=>{calls.push(url);return {ok:true,json:async()=>[release('v0.2.0',{html_url:'https://github.com/Niko1221/Strata/releases/tag/v0.2.0'})]};});
  assert.deepEqual(calls,['https://api.github.com/repos/yeli19950109/Strata/releases?per_page=30']);
  assert.equal(result.strata.releaseUrl,undefined);
});

test('desktop app endpoint and release packager target the fork while engine feed remains upstream', async () => {
  const { readFile } = await import('node:fs/promises');
  const conf=JSON.parse(await readFile(new URL('../../desktop/src-tauri/tauri.conf.json',import.meta.url),'utf8'));
  assert.deepEqual(conf.plugins.updater.endpoints,['https://github.com/yeli19950109/Strata/releases/latest/download/latest.json']);
  assert.ok(conf.plugins.updater.pubkey.length > 30,'signed updater key remains present');
  const packager=await readFile(new URL('../../../packaging/feed_tool.py',import.meta.url),'utf8');
  assert.match(packager,/url = a\.url or f"https:\/\/github\.com\/yeli19950109\/Strata\/releases\/latest\/download\//);
  const engine=await readFile(new URL('../../../strata_cli/update_cmd.py',import.meta.url),'utf8');
  assert.match(engine,/DEFAULT_FEED = "https:\/\/github\.com\/Niko1221\/Strata\/releases\/latest\/download\/strata-feed\.json"/);
});
