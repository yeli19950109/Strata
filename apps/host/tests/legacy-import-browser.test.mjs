import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { previewLegacyRunConfig, saveLegacyRunConfig } from '../server/legacy-run-config.mjs';

const executablePath=process.env.STRATA_TEST_CHROME || ['/usr/bin/chromium','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);

test('browser file selection previews and saves a UTF-8 BOM and original JSON bytes', {skip:!executablePath,timeout:120000}, async()=>{
 const dir=mkdtempSync(join(tmpdir(),'strata-browser-import-'));
 const vite=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react()],server:{host:'127.0.0.1',port:0,strictPort:false}});
 let browser;
 try {
  await vite.listen(); const port=vite.httpServer.address().port;
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();let previewText,importText;
  page.setDefaultTimeout(90000);
  await page.route('**/api/native/legacy/preview',async route=>{const {text}=route.request().postDataJSON();previewText=text;const data=previewLegacyRunConfig(text);await route.fulfill({json:{config:data.config,issues:data.issues,overrides:data.overrides}});});
  await page.route('**/api/native/legacy/import',async route=>{const {text,id}=route.request().postDataJSON();importText=text;saveLegacyRunConfig(dir,id,text);await route.fulfill({json:{ok:true}});});
  await page.route('**/api/native?*',async route=>route.fulfill({json:{}}));
  const source='\ufeff'+JSON.stringify({exe:'Y:\\Strata\\engine\\strata.exe',cwd:'Y:\\Strata',tokenizer:'Y:\\模型\\tokenizer',args:['--pack','Y:\\模型\\pack'],env:{STRATA_HIP_WMMA:'1'}},null,2)+'\r\n';
  await page.goto(`http://127.0.0.1:${port}/tests/fixtures/legacy-import-ui/`);
  await page.locator('input[type=file]').setInputFiles({name:'strata-legacy.json',mimeType:'application/json',buffer:Buffer.from(source,'utf8')});
  const saved=page.waitForResponse(response=>response.url().endsWith('/api/native/legacy/import'));
  await page.getByRole('button',{name:'Import configuration'}).click();
  await saved;
  assert.equal(previewText,source);assert.equal(importText,source);assert.deepEqual(readFileSync(join(dir,'strata-legacy.json')),Buffer.from(source,'utf8'));
  previewText=undefined;
  await page.locator('input[type=file]').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from([0xff,0xfe,0x7b])});
  await page.getByRole('alert').waitFor();
  assert.equal(previewText,undefined,'invalid UTF-8 is rejected before preview or import');
 } finally {if(browser)await browser.close();await vite.close();rmSync(dir,{recursive:true,force:true});}
});
