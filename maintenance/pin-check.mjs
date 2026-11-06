// Read-only pre-switch pin check. Changes nothing (no install, update, policy or
// updater write). Fails unless the Host build, the exact QQ package versions,
// their pnpm patch pins and the patched installed files all match this checkout.
//
//   node maintenance/pin-check.mjs --runtime <DSH runtime root> --profile <Profile directory> [--updater <updater cache dir>]
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),versions=require('../versions.json'),yaml=require('js-yaml');
const args=process.argv.slice(2),opt=k=>{const i=args.indexOf('--'+k);return i<0?undefined:path.resolve(args[i+1]);},need=k=>{const v=opt(k);if(!v)throw Error('Required --'+k);return v;};
const runtime=need('runtime'),profile=need('profile'),updater=opt('updater');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex'),load=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^﻿/,''));
const problems=[],warnings=[],facts={};const check=(ok,message)=>{if(!ok)problems.push(message);};
// The Host manifest lives in app.asar, readable only through the Host's own Electron.
function hostManifest(){
 const exe=path.join(runtime,process.platform==='win32'?'DeepSeek Harness.exe':'deepseek-harness'),out=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'pin-check-')),'m.json');
 try{spawnSync(exe,['-e',`const m=require(${JSON.stringify(runtime+'/resources/app.asar/package.json')}),d=require(${JSON.stringify(runtime+'/resources/app.asar/dsh/package.json')});require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({desktop:m.version,dsh:d.version,channel:m.dshDesktopUpdateChannel,mandatoryPolicy:!!m.dshMandatoryUpdatePolicy}))`],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true});return load(out);}
 finally{fs.rmSync(path.dirname(out),{recursive:true,force:true});}
}
const host=hostManifest();facts.host={...host,asarSha256:sha(runtime+'/resources/app.asar')};
check(host.dsh===versions.dsh,`Host DSH ${host.dsh} != pinned ${versions.dsh}`);
const pkg=load(profile+'/package.json'),deps={...pkg.dependencies,...pkg.devDependencies};
const workspace=fs.existsSync(profile+'/pnpm-workspace.yaml')?yaml.load(fs.readFileSync(profile+'/pnpm-workspace.yaml','utf8'))??{}:{};
const patched={...pkg.pnpm?.patchedDependencies,...workspace.patchedDependencies},overrides={...pkg.pnpm?.overrides,...workspace.overrides};
for(const [name,upstream,source] of [['dsh-qqbot','qqbot-upstream-0.5.2','qqbot-src'],['qqbot-nodejs','sdk-upstream-1.0.5','sdk-src']]){
 const id='@tencent-connect/'+name,version=versions[name],declared=deps[id]??overrides[id];
 check(declared===version,`${id} must be pinned exactly to ${version} (declared ${declared??'none'}); a range lets an update drop the version-keyed patch`);
 const key=id+'@'+version,patchFile=patched[key];
 check(!!patchFile,`${key} has no pnpm patchedDependencies entry`);
 if(patchFile)check(fs.existsSync(path.join(profile,patchFile))&&sha(path.join(profile,patchFile))===sha(path.join(root,'maintenance/patches',name+'@'+version+'.patch')),`${key} patch file differs from this checkout`);
 for(const other of Object.keys(patched).filter(k=>k.startsWith(id+'@')&&k!==key))problems.push(`Stale patch pin ${other}`);
 const dir=path.join(profile,'node_modules',id);
 if(!fs.existsSync(dir+'/package.json')){problems.push(`${id} not installed`);continue;}
 const installed=load(dir+'/package.json').version;facts[name]=installed;check(installed===version,`${id} installed ${installed} != ${version}`);
 const manifest=load(path.join(root,'maintenance',upstream,'manifest.json'));let mismatched=0;
 for(const f of [...Object.keys(manifest.files),...(manifest.added??[])])if(!fs.existsSync(path.join(dir,f))||sha(path.join(dir,f))!==sha(path.join(root,'maintenance',source,f)))mismatched++;
 check(mismatched===0,`${id}: ${mismatched} installed files differ from the reviewed patched sources`);
}
const policyFile=profile+'/plugin-policy.json';
if(fs.existsSync(policyFile)){const p=load(policyFile);facts.testedRuntime=p.testedRuntime;check(p.testedRuntime===host.dsh,`plugin-policy testedRuntime ${p.testedRuntime} != Host ${host.dsh}`);}
// Desktop updates need an explicit user confirmation; report anything staged.
if(updater&&fs.existsSync(updater+'/pending/update-info.json')){const info=load(updater+'/pending/update-info.json');facts.stagedInstaller=info.fileName;const staged=/(\d+\.\d+\.\d+(?:-[\w.]+)?)-win/.exec(info.fileName)?.[1];if(staged&&staged!==host.desktop)warnings.push(`Desktop installer ${info.fileName} is staged; never confirm a Desktop update during the switch window`);}
console.log(JSON.stringify({readOnly:true,ok:problems.length===0,facts,problems,warnings},null,2));process.exitCode=problems.length?1:0;
