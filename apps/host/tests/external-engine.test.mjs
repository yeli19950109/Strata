import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExternalEngine } from '../server/external-engine.mjs';

test('external selection persists across restarts and an offline drive without changing the executable', () => {
  const root=mkdtempSync(join(tmpdir(),'strata 外部 '));
  try {
    const exe=join(root,'引擎 with spaces'); writeFileSync(exe,'never execute'); chmodSync(exe,0o700);
    const state=join(root,'app'), a=createExternalEngine(state);
    assert.equal(a.status().selected,false);
    assert.equal(a.select(exe).usable,true);
    const b=createExternalEngine(state); assert.deepEqual(b.status(),{selected:true,usable:true,path:exe,notice:null});
    const moved=exe+'.offline'; renameSync(exe,moved);
    assert.equal(b.status().selected,true); assert.equal(b.status().usable,false); assert.match(b.status().notice,/reconnect/);
    renameSync(moved,exe); assert.equal(b.status().usable,true);
    b.clear(); assert.equal(b.status().selected,false); assert.equal(readFileSync(exe,'utf8'),'never execute');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('invalid and unavailable paths cannot replace an existing reference', () => {
  const root=mkdtempSync(join(tmpdir(),'strata-engine-'));
  try {
    const exe=join(root,'engine'); writeFileSync(exe,'x'); chmodSync(exe,0o700);
    const manager=createExternalEngine(join(root,'app')); manager.select(exe);
    for (const invalid of ['relative',root,join(root,'missing'),'bad\0path']) assert.throws(()=>manager.select(invalid));
    assert.equal(manager.status().path,exe);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
