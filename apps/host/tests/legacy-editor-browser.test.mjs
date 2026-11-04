import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const executablePath=process.env.STRATA_TEST_CHROME || ['/usr/bin/chromium','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
test('an imported model is visible and the JSON editor preserves untouched data', {skip:!executablePath,timeout:120000},async()=>{
 const vite=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react()],server:{host:'127.0.0.1',port:0,strictPort:false}});let browser;
 try{await vite.listen();browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});const page=await browser.newPage();
  const config={exe:'X:\\example\\engine\\strata.exe',args:['--spec','4','--kv','int8'],tokenizer:'X:\\example\\pack\\tokenizer',env:{STRATA_HIP_WMMA:'1'},extra:{keep:true}};let text=JSON.stringify(config,null,2),saveCount=0;
  const native={available:true,engine:{usable:true},installed:{models:[{model:'sc117',model_name:'SC117 existing',externalImport:true,ready:false,missing:['engine']}]},jobs:[],instances:[]};
  await page.route('**/api/native',route=>route.fulfill({json:native}));await page.route('**/api/native?*',route=>route.fulfill({json:native}));await page.route('**/api/native/legacy/sc117/config',async route=>{if(route.request().method()==='GET')return route.fulfill({json:{text,configHash:'a'.repeat(64)}});const body=route.request().postDataJSON();assert.equal(body.configHash,'a'.repeat(64));text=body.text;saveCount++;return route.fulfill({json:native});});
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/legacy-editor-ui/`);await page.getByText('SC117 existing').waitFor();await page.getByRole('button',{name:'Edit configuration'}).click();const editor=page.getByLabel('Run configuration JSON');await editor.waitFor();await editor.fill(text.replace('"4"','"5"'));await page.getByRole('button',{name:'Save configuration'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(saveCount,1);const result=JSON.parse(text);assert.deepEqual(result.args,['--spec','5','--kv','int8']);assert.deepEqual(result.env,config.env);assert.deepEqual(result.extra,config.extra);
 }finally{if(browser)await browser.close();await vite.close();}
});
