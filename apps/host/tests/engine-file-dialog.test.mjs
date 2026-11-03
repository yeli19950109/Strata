import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseEngineFile } from '../server/engine-file-dialog.mjs';

test('Windows engine picker returns a Unicode path without executing the file',async()=>{
 let called;
 const result=await chooseEngineFile({platform:'win32',windowsDialog:async (shell,args)=>{called={shell,args};return {stdout:'READY\r\nY:\\模型 数据\\strata.exe'};}});
 assert.equal(result.path,'Y:\\模型 数据\\strata.exe');
 const script=Buffer.from(called.args.at(-1),'base64').toString('utf16le');
 assert.match(script,/OpenFileDialog/);assert.doesNotMatch(script,/Start-Process|Invoke-Expression/);
});
test('picker distinguishes cancellation from unavailable desktop',async()=>{
 assert.deepEqual(await chooseEngineFile({platform:'win32',windowsDialog:async()=>({stdout:'READY\n'})}),{cancelled:true});
 assert.deepEqual(await chooseEngineFile({platform:'win32',windowsDialog:async()=>({noDialog:true})}),{unavailable:true});
});
