import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngineFolder, engineFolderOf } from '../server/engine-folder.mjs';

test('the chosen engine folder persists and is handed to Control as its engine folder', () => {
  const root=mkdtempSync(join(tmpdir(),'strata 引擎 ')), env={};
  try {
    const engines=join(root,'my engines');mkdirSync(engines);
    const a=createEngineFolder(join(root,'app'),{env});
    assert.equal(a.status().selected,false);assert.equal(env.STRATA_ENGINE_DIR,undefined);
    assert.equal(a.select(engines).usable,true);assert.equal(env.STRATA_ENGINE_DIR,engines);
    const env2={},b=createEngineFolder(join(root,'app'),{env:env2});b.apply();assert.equal(env2.STRATA_ENGINE_DIR,engines);
    assert.deepEqual(b.status(),{selected:true,usable:true,path:engines,notice:null});
    /* A folder on a drive that is not connected: the saved path names a folder that is not there (deleting one is not immediate on Windows). */
    const offline=createEngineFolder(join(root,'offline'),{env:{}});mkdirSync(join(root,'offline'));writeFileSync(join(root,'offline','engine-folder.json'),JSON.stringify({path:join(root,'not connected')}));
    assert.equal(offline.status().selected,true);assert.equal(offline.status().usable,false);assert.match(offline.status().notice,/Reconnect/);
    b.clear();assert.equal(b.status().selected,false);assert.equal(env2.STRATA_ENGINE_DIR,undefined);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('an engine package is the engine folder as it is; a component folder or a checkout means its engine folder', () => {
  const root=mkdtempSync(join(tmpdir(),'strata-engine-'));
  try {
    const components=join(root,'components'),engines=join(components,'engine'),pkg=join(engines,'0.1.56-windows-x86_64-hip');
    mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'engine-component.json'),'{}');
    assert.equal(engineFolderOf(pkg),pkg);assert.equal(engineFolderOf(engines),engines);assert.equal(engineFolderOf(components),engines);
    const checkout=join(root,'Strata'),own=join(checkout,'engine');mkdirSync(own,{recursive:true});writeFileSync(join(own,'engine-component.json'),'{}');for(const d of ['tools','tmp','tests'])mkdirSync(join(checkout,d));
    assert.equal(engineFolderOf(checkout),own,'a checkout above its engine folder is not taken for a folder of engines');assert.equal(engineFolderOf(own),own);
    const empty=join(root,'empty');mkdirSync(empty);assert.equal(engineFolderOf(empty),empty);
    const manager=createEngineFolder(join(root,'app'),{env:{}});
    for (const invalid of ['relative',join(root,'missing'),'bad\0path']) assert.throws(()=>manager.select(invalid));
    assert.equal(manager.select(pkg).path,pkg);
    writeFileSync(join(root,'app','engine-folder.json'),JSON.stringify({path:checkout}));assert.equal(manager.status().path,own,'a folder saved by the earlier rule is read as its engine folder');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('an engine executable kept by an earlier version becomes its folder', () => {
  const root=mkdtempSync(join(tmpdir(),'strata-engine-'));
  try {
    const pkg=join(root,'engine','0.1.56-linux-x86_64-cuda');mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'engine-component.json'),'{}');
    const app=join(root,'app');mkdirSync(app);writeFileSync(join(app,'external-engine.json'),JSON.stringify({path:join(pkg,'strata')}));
    const env={};assert.equal(createEngineFolder(app,{env}).apply().path,pkg);assert.equal(env.STRATA_ENGINE_DIR,pkg);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
