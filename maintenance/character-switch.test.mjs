import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const sw=createRequire(import.meta.url)('./character-switch.cjs'),script=fileURLToPath(new URL('./character-switch.cjs',import.meta.url));
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
// An install with characters alpha, beta and gamma under data/characters and a junction pointing at alpha.
function install(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqtk-switch-')),data=path.join(root,'data');
 const dirs={};for(const id of ['alpha','beta','gamma']){dirs[id]=path.join(data,'characters',id);write(path.join(dirs[id],'binding.json'),{characterId:id});write(path.join(dirs[id],'marker.txt'),id);}
 write(path.join(data,'characters/registry.json'),{version:1,characters:Object.entries(dirs).map(([id,dir])=>({id,dir,addedAt:'2026-01-01',archived:false}))});
 const link=path.join(data,'character-current');fs.symlinkSync(dirs.alpha,link,'junction');
 const request=path.join(data,'maintenance/character-switch.json'),result=path.join(data,'maintenance/character-switch-result.json');fs.mkdirSync(path.dirname(request),{recursive:true});
 const ask=(over={})=>write(request,{target:'beta',previous:'alpha',requestedAt:Date.now(),nonce:'n1',...over});
 const inprogress=path.join(data,'maintenance/character-switch.inprogress.json');
 const begin=(over)=>{ask(over);const r=spawnSync(process.execPath,[script,'pending',root],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 const readResult=()=>JSON.parse(fs.readFileSync(result,'utf8'));
 return {root,data,dirs,link,request,result,inprogress,ask,begin,readResult,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
const run=(args)=>{const r=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});return {code:r.status,json:r.stdout.trim()?JSON.parse(r.stdout.trim().split('\n').pop()):null,stderr:r.stderr};};
const marker=(dir)=>fs.readFileSync(path.join(dir,'marker.txt'),'utf8');

test('apply and revert repoint the junction without touching either character directory',()=>{
 const i=install();try{
  i.begin();
  assert.equal(run(['check',i.root]).code,0);
  assert.equal(run(['apply',i.root]).code,0);assert.equal(marker(i.link),'beta');
  assert.equal(run(['revert',i.root]).code,0);assert.equal(marker(i.link),'alpha');
  for(const id of ['alpha','beta']){assert.equal(marker(i.dirs[id]),id);assert(fs.existsSync(path.join(i.dirs[id],'binding.json')));}
 }finally{i.cleanup();}
});
test('apply refuses when the link does not point at the previous character',()=>{
 const i=install();try{
  i.begin({previous:'alpha',target:'beta'});fs.unlinkSync(i.link);fs.symlinkSync(i.dirs.gamma,i.link,'junction');
  for(const step of ['check','apply','revert']){const r=run([step,i.root]);assert.notEqual(r.code,0,step);assert.equal(marker(i.link),'gamma');}
 }finally{i.cleanup();}
});
test('untrusted character directories are refused',()=>{
 const i=install();try{
  const setDir=(id,dir)=>{const file=path.join(i.data,'characters/registry.json'),reg=JSON.parse(fs.readFileSync(file,'utf8'));reg.characters.find(c=>c.id===id).dir=dir;write(file,reg);};
  assert.equal(sw.trustedDir(i.root,'beta'),fs.realpathSync(i.dirs.beta));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'qqtk-outside-'));write(path.join(outside,'binding.json'),{characterId:'beta'});
  try{setDir('beta',outside);assert.throws(()=>sw.trustedDir(i.root,'beta'),/not an allowed/);}finally{fs.rmSync(outside,{recursive:true,force:true});}
  setDir('beta',i.link);assert.throws(()=>sw.trustedDir(i.root,'beta'));
  setDir('beta',i.dirs.beta);write(path.join(i.dirs.beta,'binding.json'),{characterId:'other'});assert.throws(()=>sw.trustedDir(i.root,'beta'),/binding/);
  fs.rmSync(path.join(i.dirs.beta,'binding.json'));assert.throws(()=>sw.trustedDir(i.root,'beta'),/binding/);
  assert.throws(()=>sw.trustedDir(i.root,'current'),/id/);assert.throws(()=>sw.trustedDir(i.root,'../x'),/id/);
 }finally{i.cleanup();}
});
test('the legacy data/character-<id> location is trusted, a junction at the new location is not',()=>{
 const i=install();try{
  const legacy=path.join(i.data,'character-delta');write(path.join(legacy,'binding.json'),{characterId:'delta'});
  const file=path.join(i.data,'characters/registry.json'),reg=JSON.parse(fs.readFileSync(file,'utf8'));reg.characters.push({id:'delta',dir:legacy,addedAt:'x',archived:false});write(file,reg);
  assert.equal(sw.trustedDir(i.root,'delta'),fs.realpathSync(legacy));
  fs.rmSync(i.dirs.gamma,{recursive:true,force:true});fs.symlinkSync(i.dirs.beta,i.dirs.gamma,'junction');assert.throws(()=>sw.trustedDir(i.root,'gamma'));
 }finally{i.cleanup();}
});
test('a stale request expires without switching (review focus 4)',()=>{
 const i=install();try{
  i.ask({requestedAt:Date.now()-16*60*1000});
  const r=run(['pending',i.root]);assert.equal(r.code,4);
  assert.equal(i.readResult().ok,false);assert.equal(i.readResult().reason,'expired');assert.equal(i.readResult().target,'beta');
  assert(!fs.existsSync(i.request));assert.equal(marker(i.link),'alpha');
 }finally{i.cleanup();}
});
test('pending reports a valid request, an absent one and an invalid one',()=>{
 const i=install();try{
  assert.equal(run(['pending',i.root]).code,3);
  i.ask();const ok=run(['pending',i.root]);assert.equal(ok.code,0);assert.equal(ok.json.target,'beta');assert(!fs.existsSync(i.request)&&fs.existsSync(i.inprogress),'the request becomes the in-progress snapshot');
  assert.equal(run(['pending',i.root]).code,3);
  write(i.request,{target:'current',previous:'alpha',requestedAt:Date.now(),nonce:'n'});
  assert.equal(run(['pending',i.root]).code,4);assert.equal(i.readResult().reason,'invalid');assert(!fs.existsSync(i.request));
  write(i.request,'{not json');assert.equal(run(['pending',i.root]).code,4);assert.equal(i.readResult().reason,'invalid');
 }finally{i.cleanup();}
});
test('health check accepts only a fresh compiled persona of the target from a started process (review focus 2)',()=>{
 const ctx={target:'beta',pids:[10,11],startedAt:1000},good={pid:11,characterId:'beta',personaSource:'compiled',compiledRevision:'r',at:1500};
 assert.equal(sw.checkHealth(good,ctx).ok,true);
 assert.equal(sw.checkHealth({...good,pid:99},ctx).ok,false);
 assert.equal(sw.checkHealth({...good,at:999},ctx).ok,false);
 assert.equal(sw.checkHealth({...good,characterId:'alpha'},ctx).ok,false);
 assert.equal(sw.checkHealth({...good,personaSource:'neutral'},ctx).ok,false);
 assert.equal(sw.checkHealth(null,ctx).ok,false);assert.equal(sw.checkHealth({...good,at:'x'},ctx).ok,false);
});
test('verify reads runtime-health.json through the junction',()=>{
 const i=install();try{
  i.begin();run(['apply',i.root]);const now=Date.now();
  assert.notEqual(run(['verify',i.root,String(now),'5']).code,0);
  write(path.join(i.link,'runtime-health.json'),{pid:5,characterId:'beta',personaSource:'neutral',compiledRevision:'r',at:now+1});
  assert.notEqual(run(['verify',i.root,String(now),'4,5']).code,0);
  write(path.join(i.link,'runtime-health.json'),{pid:5,characterId:'beta',personaSource:'compiled',compiledRevision:'r',at:now+1});
  assert.equal(run(['verify',i.root,String(now),'4,5']).code,0);
 }finally{i.cleanup();}
});
test('finish writes the result atomically and removes the request',()=>{
 const i=install();try{
  i.begin();assert.equal(run(['finish',i.root,'ok']).code,0);
  assert.deepEqual([i.readResult().ok,i.readResult().target,i.readResult().nonce],[true,'beta','n1']);assert(!fs.existsSync(i.inprogress));
  i.begin();run(['finish',i.root,'fail','host did not start','true']);
  assert.deepEqual([i.readResult().ok,i.readResult().reason,i.readResult().restored],[false,'host did not start',true]);
  assert(!fs.readdirSync(path.dirname(i.request)).some(n=>n.endsWith('.tmp')));
 }finally{i.cleanup();}
});
test('a switch that pending accepted never expires, and a newer request cannot hijack it',()=>{
 const i=install();try{
  i.begin();
  // Time passes (idle waits, Host start) and the restarted Host files a new request for another character.
  const snapshot=JSON.parse(fs.readFileSync(i.inprogress,'utf8'));write(i.inprogress,{...snapshot,requestedAt:Date.now()-60*60*1000});
  i.ask({target:'gamma',previous:'beta',nonce:'n2'});
  assert.equal(run(['check',i.root]).code,0);assert.equal(run(['apply',i.root]).code,0);assert.equal(marker(i.link),'beta');
  const now=Date.now();write(path.join(i.link,'runtime-health.json'),{pid:5,characterId:'beta',personaSource:'compiled',compiledRevision:'r',at:now+1});
  assert.equal(run(['verify',i.root,String(now),'5']).code,0);
  assert.equal(run(['revert',i.root]).code,0);assert.equal(marker(i.link),'alpha');
  assert.equal(run(['finish',i.root,'fail','x','true']).code,0);
  assert.deepEqual([i.readResult().target,i.readResult().nonce],['beta','n1']);
  assert.equal(JSON.parse(fs.readFileSync(i.request,'utf8')).nonce,'n2','the newer request is left for the next cycle');assert(!fs.existsSync(i.inprogress));
 }finally{i.cleanup();}
});
test('check refuses bad switches and recognises one that is already applied',()=>{
 const i=install();try{
  i.begin();assert.equal(run(['check',i.root]).code,0);
  run(['apply',i.root]);assert.equal(run(['check',i.root]).code,5);
  write(path.join(i.dirs.beta,'binding.json'),{characterId:'other'});assert.notEqual(run(['check',i.root]).code,0);
 }finally{i.cleanup();}
});
test('finish removes the snapshot and fails loudly when the result cannot be written',()=>{
 const i=install();try{
  i.begin();fs.mkdirSync(i.result);
  const r=run(['finish',i.root,'ok']);assert.notEqual(r.code,0);assert(!fs.existsSync(i.inprogress),'a finished switch is never replayed');
  assert.equal(run(['pending',i.root]).code,3);
 }finally{i.cleanup();}
});
test('relative registry directories are refused',()=>{
 const i=install();try{
  const file=path.join(i.data,'characters/registry.json'),reg=JSON.parse(fs.readFileSync(file,'utf8'));reg.characters.find(c=>c.id==='beta').dir='characters/beta';write(file,reg);
  assert.throws(()=>sw.trustedDir(i.root,'beta'),/absolute/);
 }finally{i.cleanup();}
});
test('repoint never deletes recursively',()=>{
 const i=install();try{
  sw.repoint(i.link,i.dirs.alpha,i.dirs.beta);
  assert.equal(marker(i.dirs.alpha),'alpha');assert(fs.existsSync(path.join(i.dirs.alpha,'binding.json')));assert.equal(marker(i.link),'beta');
  assert.throws(()=>sw.repoint(i.link,i.dirs.alpha,i.dirs.gamma),/expected/);
  const plain=path.join(i.data,'plain');fs.mkdirSync(plain);assert.throws(()=>sw.repoint(plain,plain,i.dirs.beta),/link/);assert(fs.existsSync(plain));
 }finally{i.cleanup();}
});
