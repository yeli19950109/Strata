import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createExternalEngineUpdate, runModule, openBackupFolder } from '../server/external-engine-update-api.mjs';
const hash = c=>c.repeat(64);
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'strata external 更新 '));let path=join(directory,'own engine'),busy=false;const calls=[];
 const service=createExternalEngineUpdate({control:{control:{python:'python',dir:directory}},directory,selected:()=>({selected:true,usable:true,path}),exclusive:async f=>{if(busy)throw new Error('busy');busy=true;try{return await f();}finally{busy=false;}},run:async (_control,args)=>{calls.push(args);if(args.includes('--apply'))return{ok:true,path};if(args.includes('--recover'))return{ok:true,path};return{ok:true,path,currentVersion:'1.0',targetVersion:'2.0',status:'available',currentManifestSha256:hash('a'),manifestSha256:hash('b'),downloadBytes:100};}});
 return {service,directory,calls,setPath:p=>{path=p;},close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('explicit check gives a one-use confirmation bound to path and two manifests',async()=>{const f=fixture();try{const plan=await f.service.check();assert.equal(f.calls.length,1);assert.equal(f.calls[0].includes('--apply'),false);await assert.rejects(f.service.apply('wrong'),/again/);const next=await f.service.check();await f.service.apply(next.confirmationToken);assert.deepEqual(f.calls.at(-1).slice(-5),['--apply','--old-sha',hash('a'),'--new-sha',hash('b')]);await assert.rejects(f.service.apply(next.confirmationToken),/again/);const newer=await f.service.check();f.setPath(join(f.directory,'different'));await assert.rejects(f.service.apply(newer.confirmationToken),/changed/);}finally{f.close();}});
test('pending recovery survives restart; recovery is explicitly invoked and guarded',async()=>{const f=fixture();try{const p=join(f.directory,'external-engine-updates','backups');mkdirSync(p,{recursive:true});const file=join(p,'pending.json');writeFileSync(file,JSON.stringify({root:f.directory,entrypoint:'own engine'}));assert.equal(f.service.pending(),true);await f.service.recover();assert.ok(f.calls.at(-1).includes('--recover'));unlinkSync(file);assert.equal(f.service.pending(),false);}finally{f.close();}});
test('failed verification never issues a confirmation token or apply',async()=>{const dir=mkdtempSync(join(tmpdir(),'strata extfail '));try{const service=createExternalEngineUpdate({control:{control:{}},directory:dir,selected:()=>({selected:true,usable:true,path:'/engine'}),exclusive:f=>f(),run:async()=>({ok:true,path:'/other',currentManifestSha256:hash('a'),manifestSha256:hash('b')})});await assert.rejects(service.check(),/matching/);await assert.rejects(service.apply('invalid'),/again/);}finally{rmSync(dir,{recursive:true,force:true});}});
test('after restart recovery uses the saved journal path even if the selection was lost',async()=>{const dir=mkdtempSync(join(tmpdir(),'strata recovery '));try{const base=join(dir,'external-engine-updates','backups');mkdirSync(base,{recursive:true});writeFileSync(join(base,'pending.json'),JSON.stringify({root:dir,entrypoint:'engine'}));let args;const service=createExternalEngineUpdate({control:{control:{}},directory:dir,selected:()=>({selected:false,path:null}),exclusive:f=>f(),run:async(_c,a)=>{args=a;return{ok:true}}});await service.recover();assert.equal(args[1],join(dir,'engine'));assert.ok(args.includes('--recover'));}finally{rmSync(dir,{recursive:true,force:true});}});
test('reports real download bytes while applying, rejects concurrent operations and resets after failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'strata progress '));let finish, onProgress, busy=false, count=0;
 try {
  const service=createExternalEngineUpdate({control:{control:{}},directory:dir,selected:()=>({selected:true,usable:true,path:'/engine'}),exclusive:async fn=>{if(busy)throw new Error('busy');busy=true;try{return await fn();}finally{busy=false;}},run:async(_c,args,opts)=>{
   if(!args.includes('--apply'))return{ok:true,path:'/engine',status:'available',currentManifestSha256:hash('a'),manifestSha256:hash('b')};
   count++;onProgress=opts.onProgress;return new Promise((resolve,reject)=>{finish={resolve,reject};});
  }});
  const plan=await service.check(), applying=service.apply(plan.confirmationToken);
  assert.equal(service.status().progress.active,true);onProgress({done:25,total:100});assert.deepEqual(service.status().progress,{active:true,done:25,total:100});
  onProgress({done:101,total:100});assert.equal(service.status().progress.done,25);await assert.rejects(service.check(),/busy/);
  finish.reject(new Error('network disconnected'));await assert.rejects(applying,/disconnected/);assert.equal(service.status().progress.active,false);
  await assert.rejects(service.apply(plan.confirmationToken),/again/);const retry=await service.check();const second=service.apply(retry.confirmationToken);assert.equal(service.status().progress.done,0);finish.resolve({ok:true});await second;assert.equal(count,2);assert.equal(service.status().progress.active,false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('reads split download progress from Control stderr without mixing it into the final JSON',async()=>{
 const events=[];
 const spawnProcess=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};queueMicrotask(()=>{child.stderr.emit('data',Buffer.from('STRATA_PRO'));child.stderr.emit('data',Buffer.from('GRESS {"done":25,"total":100}\n'));child.stdout.emit('data',Buffer.from('{"ok":true}'));child.emit('close',0);});return child;};
 assert.deepEqual(await runModule({python:'python',dir:'.'},[],{spawnProcess,onProgress:e=>events.push(e)}),{ok:true});assert.deepEqual(events,[{done:25,total:100}]);
});
test('opening backup folders requires a verified ID within the app root and never uses a shell',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'strata backups '))),id='external-engine-backup-abcdefgh';
 try {const root=join(dir,'external-engine-updates','backups'),folder=join(root,id);mkdirSync(folder,{recursive:true});const records=[{id,path:folder,openable:true}];let calls=[];const launch=async(...args)=>{calls.push(args);};
  await openBackupFolder(dir,id,records,{platform:'win32',launch});assert.match(calls[0][0],/\\explorer\.exe$/i);assert.deepEqual(calls[0][1],[folder]);
  await assert.rejects(openBackupFolder(dir,'../outside',records,{launch}),/app-managed/);
  await assert.rejects(openBackupFolder(dir,id,[{id,path:folder,openable:false}],{launch}),/unavailable/);
  await assert.rejects(openBackupFolder(dir,id,[{id,path:dir,openable:true}],{launch}),/link/);
  await assert.rejects(openBackupFolder(dir,id,records,{launch:async()=>{throw Error('denied')}}),/permissions/);
  rmSync(folder,{recursive:true});await assert.rejects(openBackupFolder(dir,id,records,{launch}),/unavailable/);
  symlinkSync(dir,folder,process.platform==='win32'?'junction':'dir');await assert.rejects(openBackupFolder(dir,id,records,{launch}),/link/);
  assert.equal(calls.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
