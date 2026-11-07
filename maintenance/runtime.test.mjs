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
test('DeployValidated is unattended and waits for Gateway readiness of the new Host process',()=>{
 const manage=fs.readFileSync(new URL('./manage.ps1',import.meta.url),'utf8');
 // A renamed Profile's modules directory must be rebuilt without a TTY prompt.
 assert(manage.includes('install --frozen-lockfile --ignore-scripts --offline --config.confirm-modules-purge=false'));
 // DSH 0.2.2 prints no QQ ready line; Remote Ops records readiness with the Host pid.
 assert(manage.includes("$taskHealthFile = Join-Path $taskState 'qq-health.json'"));
 assert(manage.includes("$taskHealth.detail -eq 'ready'")&&manage.includes('[int64]$taskHealth.at -ge $taskStartedAt'),'a health record from before this start is stale');
 assert(manage.includes('($taskPids -contains [int]$taskHealth.pid)'),'the record must come from a process of the selected Host');
 const start=manage.indexOf('function Start-TaskHost'),stamp=manage.indexOf('$taskStartedAt =',start),launch=manage.indexOf('Start-Process -FilePath $taskExe',start);
 assert(start>0&&stamp>start&&stamp<launch,'the start time is taken before launching');
});
test('maintenance scripts decode Node JSON output as UTF-8 before parsing it',()=>{
 // A Chinese Preset name in `ops.cjs health` made Windows PowerShell 5.1 (GBK console)
 // fail ConvertFrom-Json; the readiness loop swallowed it and rolled back a ready Host.
 for(const name of ['manage.ps1','watchdog.ps1']){
  const s=fs.readFileSync(new URL('./'+name,import.meta.url),'utf8'),set=s.indexOf('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false'),parse=s.indexOf('ConvertFrom-Json');
  assert(set>0&&parse>set,name+' sets UTF-8 before its first JSON parse');
 }
});
