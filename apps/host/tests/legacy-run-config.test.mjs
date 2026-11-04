import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync, existsSync, readdirSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { identifySc117, previewLegacyRunConfig, saveLegacyRunConfig, updateLegacyRunConfig } from '../server/legacy-run-config.mjs';

const sample = {exe:'Y:\\Strata\\engine\\strata.exe',args:['--pack','Y:\\Strata-data\\packs\\sc117-iq3_xxs','--native','Y:\\Strata-data\\models\\sc117-iq3_xxs\\IQ3_XXS\\Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00001-of-00002.gguf','--ple-gguf','Y:\\Strata-data\\models\\sc117-iq3_xxs\\IQ3_XXS\\Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00002-of-00002.gguf','--expert-profile','Y:\\Strata\\data\\expert-profile.bin','--expert-cache','auto','--vram-reserve-mib','1200','--prefill','auto:8192','--spec','4','--spec-min-p','0.7','--mtp','Y:\\Strata-data\\mtp\\rt','--max-context','262144','--kv','int8','--kv-resident','32768','--adapt-async','1'],cwd:'Y:\\Strata',tokenizer:'Y:\\Strata-data\\packs\\sc117-iq3_xxs\\tokenizer',model_name:'sc117-qwen3.8-flash-next-gsq-rco-abliterated-iq3_xxs',log:'Y:\\Strata\\strata-sc117-iq3_xxs.log',lib_dirs:['Y:\\Strata\\engine\\rocm\\bin'],port:8080,backend:'hip',env:{STRATA_HIPBLASLT_TUNING:'Y:\\Strata\\tools\\hip\\gfx1201-hipblaslt-100500.txt',STRATA_HIP_WMMA:'1',STRATA_ROUTE_RESIDENT:'0.25',STRATA_PIN_BY_NEED:'1',STRATA_PCIE_MIN1:'1'}};

test('editing saves only the app copy and preserves the edited text, unknown fields and argument order',()=>{
 const dir=mkdtempSync(join(tmpdir(),'strata-edit-'));try{const original=join(dir,'original.json'), text='\ufeff'+JSON.stringify({...sample,custom:{nested:['keep',7]}});writeFileSync(original,text);const target=saveLegacyRunConfig(dir,'test',text), hash=createHash('sha256').update(text).digest('hex');
  const edited=text.replace('"1200"','"1300"');updateLegacyRunConfig(dir,'test',edited,hash);assert.equal(readFileSync(original,'utf8'),text);assert.equal(readFileSync(target,'utf8'),edited);assert.deepEqual(JSON.parse(edited.slice(1)).custom,{nested:['keep',7]});
  assert.throws(()=>updateLegacyRunConfig(dir,'test',text,hash),/changed since/);assert.equal(readFileSync(target,'utf8'),edited);assert.throws(()=>updateLegacyRunConfig(dir,'test','{',createHash('sha256').update(edited).digest('hex')));assert.equal(readFileSync(target,'utf8'),edited);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('preview accepts BOM and Windows paths on Linux without modifying content', () => {
  const text='\ufeff'+JSON.stringify(sample, null, 2); const result=previewLegacyRunConfig(text);
  assert.equal(result.text,text); assert.deepEqual(result.config,sample); assert.ok(result.overrides.length);
  assert.equal(result.knownModel.quant,'IQ3_XXS');assert.equal(result.knownModel.shardsMatch,true);assert.equal(result.knownModel.pack,sample.args[sample.args.indexOf('--pack')+1]);assert.equal(result.knownModel.mtp,sample.args[sample.args.indexOf('--mtp')+1]);
});
test('SC117 recognition requires the real first shard and reports a mismatched second shard',()=>{
 const bad={...sample,args:[...sample.args]};bad.args[bad.args.indexOf('--ple-gguf')+1]='Y:\\other\\not-the-second.gguf';assert.equal(identifySc117(bad).shardsMatch,false);
 bad.args[bad.args.indexOf('--native')+1]='Y:\\other\\another-model.gguf';assert.equal(identifySc117(bad),null);
});
test('rejects invalid JSON, types and relative paths', () => {
  for (const value of ['{', JSON.stringify({...sample,args:['--native',3]}), JSON.stringify({...sample,env:{X:1}}), JSON.stringify({...sample,lib_dirs:'bad'}), JSON.stringify({...sample,cwd:'relative',exe:'engine/strata.exe'}), JSON.stringify({...sample,cwd:undefined,args:['--pack','relative']})]) assert.throws(()=>previewLegacyRunConfig(value));
});
test('saves a copy once, without touching existing source or names outside the folder', () => {
 const dir=mkdtempSync(join(tmpdir(),'strata 导入 ')); try {const text=JSON.stringify(sample); const target=saveLegacyRunConfig(dir,'test',text); assert.equal(readFileSync(target,'utf8'),text); assert.throws(()=>saveLegacyRunConfig(dir,'test',text),/already exists/); assert.throws(()=>saveLegacyRunConfig(dir,'../oops',text)); assert.equal(readFileSync(target,'utf8'),text);} finally {rmSync(dir,{recursive:true,force:true});}
});

test('keeps relative paths when an absolute cwd fixes their meaning, and accepts numeric MTP depth', () => {
 const config={...sample,exe:'engine/strata.exe',args:['--pack','packs/model','--mtp','2']};
 assert.deepEqual(previewLegacyRunConfig(JSON.stringify(config)).config,config);
});

test('refuses a linked import directory and does not create a file outside the app', () => {
 const dir=mkdtempSync(join(tmpdir(),'strata-link-'));
 try { const outside=join(dir,'outside'), link=join(dir,'legacy-models');mkdirSync(outside);symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
   assert.throws(()=>saveLegacyRunConfig(link,'model',JSON.stringify(sample)),/not a private directory/);
   assert.equal(existsSync(join(outside,'strata-model.json')),false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a failed or unsupported commit leaves no partial record and can be retried', () => {
 const dir=mkdtempSync(join(tmpdir(),'strata-atomic-')), text=JSON.stringify(sample), io={openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync};
 try {
  assert.throws(()=>saveLegacyRunConfig(dir,'test',text,{...io,writeFileSync(fd){writeFileSync(fd,'partial');const e=new Error('disk full');e.code='ENOSPC';throw e;}}),/disk full/);
  assert.deepEqual(readdirSync(dir),[]);
  assert.throws(()=>saveLegacyRunConfig(dir,'test',text,{...io,linkSync(){const e=new Error('unsupported');e.code='ENOTSUP';throw e;}}),/cannot safely save/);
  assert.deepEqual(readdirSync(dir),[]);
  const path=saveLegacyRunConfig(dir,'test',text);assert.equal(readFileSync(path,'utf8'),text);
  assert.throws(()=>saveLegacyRunConfig(dir,'test',text),/already exists/);assert.equal(readFileSync(path,'utf8'),text);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('an existing target symlink is never followed or replaced', {skip:process.platform==='win32'}, () => {
 const dir=mkdtempSync(join(tmpdir(),'strata-target-'));try {const outside=join(dir,'outside');writeFileSync(outside,'keep');symlinkSync(outside,join(dir,'strata-test.json'));
  assert.throws(()=>saveLegacyRunConfig(dir,'test',JSON.stringify(sample)),/already exists/);assert.equal(readFileSync(outside,'utf8'),'keep');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('editing a linked record never changes the linked file', {skip:process.platform==='win32'}, () => {
 const dir=mkdtempSync(join(tmpdir(),'strata-edit-link-'));try{const outside=join(dir,'outside.json'), text=JSON.stringify(sample);writeFileSync(outside,text);symlinkSync(outside,join(dir,'strata-linked.json'));
  const hash=createHash('sha256').update(text).digest('hex');assert.throws(()=>updateLegacyRunConfig(dir,'linked',text,hash),/not a regular/);assert.equal(readFileSync(outside,'utf8'),text);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
