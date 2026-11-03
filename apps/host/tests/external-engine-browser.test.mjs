import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const executablePath=process.env.STRATA_TEST_CHROME || ['/usr/bin/chromium','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
test('external engine picker and update dialog keep confirmation visible and show real progress', {skip:!executablePath,timeout:120000}, async()=>{
 const vite=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react()],server:{host:'127.0.0.1',port:0,strictPort:false}});let browser;
 try {
  await vite.listen();browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:480,height:340}});
  const engine='X:\\example\\engine\\strata.exe';let checks=0,applies=0,doneApply,backupOpens=0;let backups=[{id:'external-engine-backup-12345678',path:'C:\\Strata\\backups\\external-engine-backup-12345678',version:'1',targetVersion:'2',bytes:100,modifiedAt:1700000000,openable:true}];
  await page.route('**/api/native/external-engine',route=>route.fulfill({json:{selected:true,usable:true,path:engine,notice:null}}));
  await page.route('**/api/native/external-engine/choose',route=>route.fulfill({json:{path:'X:\\新目录\\strata.exe'}}));
  await page.route('**/api/native/external-engine/backups',route=>route.fulfill({json:{backups,pendingRecovery:false}}));
  await page.route('**/api/native/external-engine/backups/open',route=>{backupOpens++;return route.fulfill({json:{ok:true}});});
  await page.route('**/api/native/external-engine/update/check',route=>{checks++;return route.fulfill({json:{path:engine+' very long'.repeat(80),currentVersion:'1',targetVersion:'2',downloadBytes:100,status:'available',source:'upstream',confirmationToken:'token'}})});
  await page.route('**/api/native/external-engine/update/status',route=>route.fulfill({json:{progress:{active:applies>0,done:25,total:100},pendingRecovery:false}}));
  await page.route('**/api/native/external-engine/update/apply',async route=>{applies++;await new Promise(resolve=>{doneApply=resolve;});await route.fulfill({status:500,json:{error:'download interrupted'}});});
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/external-engine-ui/`);
  await page.getByRole('button',{name:'Open engine settings'}).click();await page.getByRole('button',{name:'Choose engine file…'}).click();await page.getByText('X:\\新目录\\strata.exe').waitFor();
  assert.equal(await page.locator('input[type=text]').count(),0);await page.getByRole('button',{name:'Open backup folder'}).click();await page.waitForFunction(()=>true);assert.equal(backupOpens,1);assert.equal(await page.getByRole('button',{name:/Delete backup/}).count(),0);await page.getByRole('button',{name:'Cancel'}).click();
  await page.getByRole('button',{name:'Open engine update'}).click();const confirm=page.getByRole('button',{name:'Confirm external engine update'});await confirm.waitFor();
  const bottom=await confirm.boundingBox();assert.ok(bottom && bottom.y+bottom.height<=340,'confirmation is visible in short viewport');
  await page.locator('.dialog-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});const after=await confirm.boundingBox();assert.equal(after?.y,bottom.y,'footer stays fixed when the details scroll');
  await confirm.click();await page.getByRole('progressbar',{name:'Engine update download'}).waitFor();await page.waitForFunction(()=>document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')==='25');assert.equal(await confirm.isDisabled(),true);assert.equal(applies,1);doneApply();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/interrupted/i);assert.equal(await confirm.count(),0);await page.getByRole('button',{name:'Check external engine update',exact:true}).click();await confirm.waitFor();assert.equal(checks,2);
 } finally {if(browser)await browser.close();await vite.close();}
});
