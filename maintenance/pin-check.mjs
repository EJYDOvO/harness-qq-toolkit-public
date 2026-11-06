// Read-only pre-switch candidate / post-switch instance pin check. Changes nothing (no install, update, policy or
// updater write). Fails unless the Host build, the exact QQ package versions,
// their pnpm patch pins and the patched installed files all match this checkout.
//
//   pre-switch: --phase pre-switch --runtime <target> --profile <isolated candidate> --instance-profile <actual>
//   post-switch: --phase post-switch --runtime <target> --profile <actual>
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),versions=require('../versions.json'),yaml=require('js-yaml');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex'),load=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^﻿/,''));

// The Host manifest lives in app.asar, readable only through the Host's own Electron.
function hostManifest(runtime){
 const exe=path.join(runtime,process.platform==='win32'?'DeepSeek Harness.exe':'deepseek-harness'),out=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'pin-check-')),'m.json');
 try{spawnSync(exe,['-e',`const m=require(${JSON.stringify(runtime+'/resources/app.asar/package.json')}),d=require(${JSON.stringify(runtime+'/resources/app.asar/dsh/package.json')});require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({desktop:m.version,dsh:d.version,channel:m.dshDesktopUpdateChannel,mandatoryPolicy:!!m.dshMandatoryUpdatePolicy}))`],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true});return load(out);}
 finally{fs.rmSync(path.dirname(out),{recursive:true,force:true});}
}
export function checkProfile({runtime,profile,phase,instanceProfile,host,updater}){
 const problems=[],warnings=[],facts={phase};const check=(ok,message)=>{if(!ok)problems.push(message);};
 try {
 check(['pre-switch','post-switch'].includes(phase),'Required phase: pre-switch or post-switch');
 if(phase==='pre-switch'){
  if(!instanceProfile)throw Error('pre-switch requires --instance-profile');
  const real=p=>fs.realpathSync(p).toLowerCase(),candidate=real(profile),instance=real(instanceProfile);
  check(candidate!==instance&&!candidate.startsWith(instance+path.sep)&&!instance.startsWith(candidate+path.sep),'Candidate Profile must be isolated from instance Profile');
 }
 host??=hostManifest(runtime);facts.host={...host,asarSha256:runtime?sha(runtime+'/resources/app.asar'):undefined};
check(host.dsh===versions.dsh,`Host DSH ${host.dsh} != pinned ${versions.dsh}`);
const pkg=load(profile+'/package.json'),deps={...pkg.dependencies,...pkg.devDependencies};
const workspace=fs.existsSync(profile+'/pnpm-workspace.yaml')?yaml.load(fs.readFileSync(profile+'/pnpm-workspace.yaml','utf8'))??{}:{};
const patched={...pkg.pnpm?.patchedDependencies,...workspace.patchedDependencies},overrides={...pkg.pnpm?.overrides,...workspace.overrides};
for(const [name,upstream,source] of [['dsh-qqbot','qqbot-upstream-0.5.2','qqbot-src'],['qqbot-nodejs','sdk-upstream-1.0.5','sdk-src']]){
 const id='@tencent-connect/'+name,version=versions[name],declared=deps[id]??overrides[id];
 check(declared===version,`${id} must be pinned exactly to ${version} (declared ${declared??'none'}); a range lets an update drop the version-keyed patch`);
 check(overrides[id]===undefined||overrides[id]===version,`${id} override must be exact ${version}`);
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
const policy=load(policyFile);
check(policy&&policy.schemaVersion===1&&typeof policy.profile==='string'&&policy.profile.length>0&&policy.targets&&typeof policy.targets==='object'&&!Array.isArray(policy.targets)&&policy.localPackages&&typeof policy.localPackages==='object'&&!Array.isArray(policy.localPackages),'Invalid plugin-policy schema');
for(const [name,entry] of Object.entries(policy.localPackages??{})){
 check(entry&&typeof entry.source==='string'&&entry.source.startsWith('file:')&&typeof entry.version==='string'&&/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(entry.version)&&/^[a-f0-9]{64}$/.test(entry.sha256),'Invalid local package policy '+name);
 if(!entry)continue;check(deps[name]===entry.source,'Local dependency policy mismatch '+name);
 check(load(path.join(profile,'node_modules',name,'package.json')).version===entry.version,'Local installed version mismatch '+name);
 check(sha(path.resolve(profile,entry.source.slice(5)))===entry.sha256,'Local artifact hash mismatch '+name);
}
check(policy.profile===path.basename(profile),'plugin-policy profile name mismatch');
check(Object.values(policy.targets??{}).every(v=>typeof v==='string'&&/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v)),'plugin-policy targets require exact versions');
facts.testedRuntime=policy.testedRuntime;check(policy.testedRuntime===host.dsh,'plugin-policy testedRuntime must match target Host');
for(const name of ['dsh-qqbot','qqbot-nodejs'])check(policy.targets?.['@tencent-connect/'+name]===versions[name],'plugin-policy target must pin '+name+' exactly');
check(typeof policy.qqPatch==='string'&&!!patched['@tencent-connect/dsh-qqbot@'+versions['dsh-qqbot']]&&path.resolve(profile,policy.qqPatch)===path.resolve(profile,patched['@tencent-connect/dsh-qqbot@'+versions['dsh-qqbot']]),'plugin-policy qqPatch must match installed patch pin');
// Desktop updates need an explicit user confirmation; report anything staged.
if(updater&&fs.existsSync(updater+'/pending/update-info.json')){const info=load(updater+'/pending/update-info.json');facts.stagedInstaller=info.fileName;const staged=/(\d+\.\d+\.\d+(?:-[\w.]+)?)-win/.exec(info.fileName)?.[1];if(staged&&staged!==host.desktop)warnings.push(`Desktop installer ${info.fileName} is staged; never confirm a Desktop update during the switch window`);}
 }catch(error){problems.push('Inspection failed: '+error.message);}
 return {readOnly:true,ok:problems.length===0,facts,problems,warnings};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2),options={};
 try{for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!['--runtime','--profile','--phase','--instance-profile','--updater'].includes(k)||!v||v.startsWith('--')||options[k])throw Error('Invalid/duplicate argument '+k);options[k]=v;}
 if(!options['--runtime']||!options['--profile']||!options['--phase'])throw Error('Required --phase pre-switch|post-switch --runtime --profile');
 const result=checkProfile({runtime:path.resolve(options['--runtime']),profile:path.resolve(options['--profile']),phase:options['--phase'],instanceProfile:options['--instance-profile']&&path.resolve(options['--instance-profile']),updater:options['--updater']&&path.resolve(options['--updater'])});console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
 }catch(error){console.log(JSON.stringify({readOnly:true,ok:false,problems:[error.message]}));process.exitCode=1;}
}
