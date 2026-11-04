import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const executablePath=process.env.STRATA_TEST_CHROME || ['/usr/bin/chromium','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/opt/pw-browsers/chromium'].find(existsSync);
test('engine folder dialog picks a folder and goes back to the app folder, with no separate engine update', {skip:!executablePath,timeout:120000}, async()=>{
 const vite=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react()],server:{host:'127.0.0.1',port:0,strictPort:false}});let browser;
 try {
  await vite.listen();browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:480,height:400}});
  let state={selected:false,usable:false,path:null,notice:null},posts=0,deletes=0;
  await page.route('**/api/native**',route=>route.fulfill({json:{}}));
  await page.route('**/api/native/engine-folder',route=>{const m=route.request().method();if(m==='POST'){posts++;state={selected:true,usable:true,path:'X:\\新目录\\engine',notice:null};}if(m==='DELETE'){deletes++;state={selected:false,usable:false,path:null,notice:null};}return route.fulfill({json:state});});
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/engine-folder-ui/`);
  await page.getByRole('button',{name:'Open engine settings'}).click();await page.getByText('Strata uses its own engine folder.').waitFor();
  assert.equal(await page.getByRole('button',{name:/update/i}).count(),0);assert.equal(await page.getByRole('button',{name:/backup/i}).count(),0);
  await page.getByRole('button',{name:'Choose engine folder…'}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));assert.equal(posts,1);
  await page.getByRole('button',{name:'Open engine settings'}).click();await page.getByText('X:\\新目录\\engine',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Use Strata’s own engine folder'}).click();await page.getByText('Strata uses its own engine folder.').waitFor();assert.equal(deletes,1);
 } finally {if(browser)await browser.close();await vite.close();}
});
