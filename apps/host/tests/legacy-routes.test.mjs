import './helpers/isolate-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const root=resolve(import.meta.dirname,'..');
async function port() {const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function stopHost(child) {
 if (!child || child.exitCode !== null) return;
 const exited = new Promise(r => child.once('exit', r));
 if (process.platform === 'win32') {
  const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true,encoding:'utf8',timeout:15000});
  if (result.error || result.status !== 0) throw new Error(`Could not stop host process tree: ${result.error?.message || result.stderr}`);
 } else child.kill('SIGTERM');
 await exited;
}
test('preview, engine folder choice, offline status and dismissed setup persist without running the engine', {timeout:30000}, async()=>{
 const home=await mkdtemp(join(tmpdir(),'strata-旧配置 ')), engines=join(home,'my engines');
 await mkdir(engines,{recursive:true});
 const p=await port(), base=`http://127.0.0.1:${p}`; let child;
 const call=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 async function start(){child=spawn(process.execPath,['server/index.mjs'],{cwd:root,stdio:'ignore',env:{...process.env,STRATA_HOME:home,STRATA_MODELS_DIR:join(home,'models'),STRATA_PORT:String(p),STRATA_REAL_ENGINE:'0',STRATA_NO_ACQUIRE:'1'}});for(let i=0;i<100;i++){try{if((await call('/api/health')).status===200)return;}catch{} await wait(100);}throw new Error('host did not start');}
 async function stop(){await stopHost(child);child=null;}
 try {
  await start();
  const source='\ufeff'+JSON.stringify({exe:'Y:\\Strata\\engine\\strata.exe',cwd:'Y:\\Strata',args:['--pack','Y:\\模型 1\\pack'],tokenizer:'Y:\\模型 1\\tokenizer',lib_dirs:['Y:\\Strata\\rocm\\bin'],env:{STRATA_HIP_WMMA:'1'},port:8080});
  const preview=await call('/api/native/legacy/preview','POST',{text:source});assert.equal(preview.status,200);assert.equal(preview.body.config.exe,'Y:\\Strata\\engine\\strata.exe');assert.deepEqual(preview.body.config.args,['--pack','Y:\\模型 1\\pack']);
  assert.equal((await call('/api/native/legacy/preview','POST',{text:'{'})).status,400);
  const selected=await call('/api/native/engine-folder','POST',{path:engines});assert.equal(selected.status,200,JSON.stringify(selected.body));assert.equal(selected.body.path,engines);assert.equal(selected.body.usable,true);
  await call('/api/setup/step','POST',{step:1,flowVersion:2,dismissed:true});
  await stop();await start();
  let status=(await call('/api/control/status')).body.engineFolder;assert.equal(status.selected,true);assert.equal(status.path,engines);assert.equal((await call('/api/setup')).body.dismissed,true);
  await rm(engines,{recursive:true});status=(await call('/api/native/engine-folder')).body;assert.equal(status.selected,true);assert.equal(status.usable,false);assert.ok(status.notice);
  const cleared=await call('/api/native/engine-folder','DELETE');assert.equal(cleared.status,200);assert.equal(cleared.body.selected,false);
 } finally {await stop();await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});

test('packaged host previews and imports the confirmed snapshot, persists it and dismisses setup', {timeout:30000}, async()=>{
 const home=await mkdtemp(join(tmpdir(),'strata-packaged-legacy '));let child;
 const dir=join(home,'control'), py=process.platform==='win32'?join(dir,'python','python.exe'):join(dir,'python','bin','python3'), install=join(home,'install');
 await mkdir(join(dir,'python','bin'),{recursive:true});await mkdir(join(dir,'strata_control'),{recursive:true});await mkdir(join(dir,'tools'),{recursive:true});await mkdir(install,{recursive:true});
 await writeFile(join(dir,'strata.py'),'');await writeFile(join(dir,'tools','strata_mcp.py'),'');
 const stub=`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),readline=require('readline');const args=process.platform==='win32'?[process.argv[1],...process.argv.slice(2)]:process.argv.slice(2);
if(args[0].endsWith('strata_mcp.py')) {const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='tools/list')result={tools:[{name:'strata_status'},{name:'strata_models'}]};if(m.method==='tools/call')result={structuredContent:m.params.name==='strata_status'?{installed:{models:[]},hardware:{gpus:[]}}:{families:[],contexts:[],recommendation:{family:null,model:null}}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});}
else if(args.includes('models')&&args.includes('list')){const folder=args[args.indexOf('--install-dir')+1];const names=fs.readdirSync(folder).filter(x=>/^strata-.+\\.json$/.test(x));const models=names.map(n=>{const f=path.join(folder,n),c=JSON.parse(fs.readFileSync(f,'utf8').replace(/^\\uFEFF/,''));return{id:n.slice(7,-5),name:c.model_name,source_config:f,component_status:'missing_or_invalid',missing:[{part:'engine',file:'strata.exe',status:'missing'}]}});console.log(JSON.stringify({install_dir:folder,models}));}
else if(args.includes('engine'))console.log(JSON.stringify({usable:false,notice:'No engine',engine:null}));else console.log(JSON.stringify({ok:true}));
`;
 if(process.platform==='win32') {
  // Node can run a script with a .py extension; the fixture only simulates
  // Control and never runs an engine. The copied executable avoids a shell.
  await copyFile(process.execPath,py);
  await writeFile(join(dir,'strata.py'),stub);
  await writeFile(join(dir,'tools','strata_mcp.py'),stub);
 } else await writeFile(py,stub,{mode:0o755});
 const p=await port(), base=`http://127.0.0.1:${p}`;
 const call=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 async function start(){child=spawn(process.execPath,['server/index.mjs'],{cwd:root,stdio:'ignore',env:{...process.env,STRATA_HOME:home,STRATA_MODELS_DIR:join(home,'models'),STRATA_INSTALL_DIR:install,STRATA_CONTROL_DIR:dir,STRATA_COMPONENTS_DIR:join(home,'components'),STRATA_PORT:String(p),STRATA_REAL_ENGINE:'0',STRATA_PACKAGED:'1',STRATA_NO_ACQUIRE:'1',STRATA_NO_BUNDLED_ENGINE:'1'}});for(let i=0;i<100;i++){try{if((await call('/api/health')).status===200)return;}catch{}await wait(100);}throw new Error('host did not start');}
 async function stop(){await stopHost(child);child=null;}
 try {
  await start();const cfg={exe:'Y:\\Strata\\engine\\strata.exe',cwd:'Y:\\Strata',args:['--pack','Y:\\模型\\pack'],tokenizer:'Y:\\模型\\tokenizer',model_name:'Existing',env:{STRATA_HIP_WMMA:'1'},port:8080,before_load:['echo','inspect only']};const text='\ufeff'+JSON.stringify(cfg);
  const preview=await call('/api/native/legacy/preview','POST',{text});assert.equal(preview.status,200);assert.deepEqual(preview.body.config,cfg);
  const imported=await call('/api/native/legacy/import','POST',{text,id:'mine'});assert.equal(imported.status,200,JSON.stringify(imported.body));assert.equal(imported.body.installed.models.find(m=>m.model==='mine').imported,true);
  const duplicate=await call('/api/native/legacy/import','POST',{text,id:'mine'});assert.equal(duplicate.status,400);assert.match(duplicate.body.error,/already exists/);
  const invalid=await call('/api/native/legacy/import','POST',{text:'{',id:'other'});assert.equal(invalid.status,400);assert.ok(invalid.body.error);
  await call('/api/setup/step','POST',{step:1,flowVersion:2,dismissed:true});await stop();await start();
  assert.equal((await call('/api/setup')).body.dismissed,true);const status=await call('/api/native?refresh=1');assert.equal(status.body.installed.models.find(m=>m.model==='mine').imported,true);
  const saved=JSON.parse(await (await import('node:fs/promises')).readFile(join(install,'strata-mine.json'),'utf8'));assert.deepEqual(saved,{...cfg,ui_imported:true});
  assert.equal((await call('/api/native/legacy/mine/config')).status,404);
 } finally {await stop();await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
