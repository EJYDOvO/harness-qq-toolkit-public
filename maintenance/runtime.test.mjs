import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const {resolveRuntime}=createRequire(import.meta.url)('./runtime.cjs');
test('runtime selection keeps data separate, honors explicit override and refuses damaged state',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqtk-runtime-')),other=path.join(root,'Program Files','DSH rc3');
 assert.equal(resolveRuntime(root,{}).runtimeRoot,root);fs.mkdirSync(path.join(root,'data/maintenance'),{recursive:true});const state=path.join(root,'data/maintenance/host-runtime.json');
 fs.writeFileSync(state,'\uFEFF'+JSON.stringify({schemaVersion:1,runtimeRoot:other}));assert.equal(resolveRuntime(root,{}).runtimeRoot,other);assert.equal(resolveRuntime(root,{DSH_CHARACTER_HOST_ROOT:root}).runtimeRoot,root);
 fs.writeFileSync(state,'invalid');assert.throws(()=>resolveRuntime(root,{}));assert.equal(resolveRuntime(root,{DSH_RUNTIME_ROOT:other}).runtimeRoot,other);
 assert.throws(()=>resolveRuntime(root,{DSH_RUNTIME_ROOT:'relative'}),/absolute/);
});
test('maintenance composes and starts the candidate with the selected runtime, never the install root Host',()=>{
 // After a runtime move (host-runtime.json) the install root may still hold an
 // older Host, e.g. 0.2.1, which cannot compose a 0.2.2-only Character.
 const manage=fs.readFileSync(new URL('./manage.ps1',import.meta.url),'utf8'),cli=String.raw`'resources\runtime\cli\bin\dsh.cmd'`;
 assert(!manage.includes('(Join-Path $taskRoot '+cli),'composition must not use the install root CLI');
 assert(manage.includes('(Join-Path $taskRuntime '+cli+') --profile qqbot-validation --dump-config'));
 assert(manage.includes("$taskExe = Join-Path $taskRuntime 'DeepSeek Harness.exe'"));
});
