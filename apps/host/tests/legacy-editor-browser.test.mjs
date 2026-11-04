import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const executablePath=process.env.STRATA_TEST_CHROME || ['/usr/bin/chromium','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
test('an imported model is edited with the app’s own model settings and can be exported', {skip:!executablePath,timeout:120000},async()=>{
 const vite=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react()],server:{host:'127.0.0.1',port:0,strictPort:false}});let browser;
 try{await vite.listen();browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});const page=await browser.newPage();
  const native={available:true,engine:{usable:true},installed:{models:[{model:'sc117',model_name:'SC117 existing',imported:true,ready:false,missing:['engine']}]},jobs:[],instances:[]};let exports=0;
  await page.route('**/api/native/models/**',route=>route.fulfill({json:{model:'sc117',values:{},mcp:{},issues:[],path:'/x/strata-sc117.json',name:'strata-sc117.json',speedSwitches:[],capabilities:{}}}));
  await page.route('**/api/native/models/export',route=>{exports++;assert.deepEqual(route.request().postDataJSON(),{model:'sc117'});return route.fulfill({json:{path:'C:\\Users\\me\\Downloads\\strata-sc117.json'}});});
  await page.route('**/api/native',route=>route.fulfill({json:native}));await page.route('**/api/native?*',route=>route.fulfill({json:native}));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/legacy-editor-ui/`);await page.getByText('SC117 existing').waitFor();
  await page.getByRole('button',{name:'Edit configuration'}).click();assert.equal(await page.getByLabel('Run configuration JSON').count(),0,'no separate JSON editor for imported models');
  await page.getByRole('button',{name:'Export configuration'}).click();await page.getByText('strata-sc117.json',{exact:false}).first().waitFor();assert.equal(exports,1);
 }finally{if(browser)await browser.close();await vite.close();}
});
