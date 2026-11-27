// Character switch helper for the maintenance watchdog. manage.ps1 stays thin and asks this file
// what to do; it only knows the file formats the Character manager writes, never its code.
//   recover <root>                          0 interrupted snapshot (current link state printed) | 3 no rollback needed | 1 recovery blocked
//   pending <root>                          0 request accepted and snapshotted (printed) | 3 none | 4 invalid or expired | 1 journal still present
//   check <root>                            0 link at previous, ready | 5 link already at target | 1 refused (nothing was changed)
//   Every step after pending reads only the in-progress snapshot: neither the clock nor a newer request can change a started switch.
//   apply <root> | revert <root>            repoint data/character-current while the Host is stopped
//   verify <root> <startedAtMs> <pid,pid> [target|previous]   0 when the Host serves the requested role
//   finish <root> ok|fail|retry [reason] [true|false]   publish outcome; keep the journal on retry or write failure
const fs=require('node:fs'),path=require('node:path');
const ID=/^[a-z0-9-]{1,48}$/,MAX_AGE_MS=15*60*1000,EXIT={none:3,rejected:4,already:5};
const paths=(root)=>{const data=path.join(root,'data'),state=path.join(data,'maintenance');return {data,link:path.join(data,'character-current'),registry:path.join(data,'characters','registry.json'),request:path.join(state,'character-switch.json'),inprogress:path.join(state,'character-switch.inprogress.json'),result:path.join(state,'character-switch-result.json'),health:path.join(data,'character-current','runtime-health.json')};};
const readJson=(file)=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));
function writeJsonAtomic(file,value){
 const temp=`${file}.${process.pid}.tmp`;
 try{fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}
 finally{fs.rmSync(temp,{force:true});}
}
const sameFile=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const isInside=(parent,child)=>{const rel=path.relative(parent,child);return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
function validId(id){if(typeof id!=='string'||!ID.test(id)||id==='current')throw Error(`Invalid character id: ${id}`);return id;}
const allowedDirs=(data,id)=>[path.join(data,'characters',id),path.join(data,`character-${id}`)];

// The only two places a character directory may live, checked independently of the Character package.
function trustedDir(root,id){
 validId(id);const {data,registry}=paths(root);
 const entry=((readJson(registry).characters)||[]).find((c)=>c&&c.id===id);
 if(!entry||typeof entry.dir!=='string')throw Error(`Character ${id} is not registered`);
 if(!path.isAbsolute(entry.dir))throw Error(`Directory of ${id} is not an absolute path`);
 const dir=path.resolve(entry.dir);
 if(!allowedDirs(data,id).some((allowed)=>sameFile(allowed,dir)))throw Error(`Directory of ${id} is not an allowed location`);
 if(!fs.lstatSync(dir).isDirectory())throw Error(`Directory of ${id} is a link or not a directory`);
 const real=fs.realpathSync(dir);
 if(!isInside(fs.realpathSync(data),real))throw Error(`Directory of ${id} is outside data`);
 let binding;try{binding=readJson(path.join(real,'binding.json'));}catch{throw Error(`Directory of ${id} has no readable binding.json`);}
 if(!binding||binding.characterId!==id)throw Error(`binding.json of ${id} names another character`);
 return real;
}
// Replace a junction. unlink on a junction removes only the link, never the target's contents.
function repoint(link,expectedDir,nextDir){
 const current=readLink(link);
 if(!current||!sameFile(current,fs.realpathSync(expectedDir)))throw Error(`Link does not point at the expected directory ${expectedDir}`);
 fs.unlinkSync(link);
 try{fs.symlinkSync(nextDir,link,'junction');}catch(error){fs.symlinkSync(expectedDir,link,'junction');throw error;}
}
function readLink(link){
 const stat=fs.lstatSync(link,{throwIfNoEntry:false});
 if(!stat)return null;
 if(!stat.isSymbolicLink())throw Error('character-current is not a link');
 return fs.realpathSync(link);
}
function rollbackLink(root,request){
 const {link,data}=paths(root),previous=trustedDir(root,request.previous);
 let current;
 try{current=readLink(link);}catch(error){
  if(error.code!=='ENOENT')throw error;
  // After a target directory is moved, the raw junction still identifies it.
  const raw=fs.readlinkSync(link).replace(/^\\\\\?\\/,'');
  const destination=path.resolve(path.dirname(link),raw);
  if(!allowedDirs(fs.realpathSync(data),request.target).some(dir=>sameFile(dir,destination)))throw error;
  return {link,previous,state:'target',dangling:true};
 }
 if(!current)return {link,previous,state:'missing'};
 if(sameFile(current,previous))return {link,previous,state:'previous'};
 const target=trustedDir(root,request.target);
 if(sameFile(current,target))return {link,previous,target,state:'target'};
 throw Error('character-current does not point at either character in the journal');
}
function checkHealth(health,{target,pids,startedAt,allowNeutral=false}){
 const fail=(reason)=>({ok:false,reason});
 if(!health||typeof health!=='object')return fail('no runtime health');
 if(!pids.includes(health.pid))return fail('health is not from the restarted Host');
 if(!Number.isFinite(startedAt)||!Number.isFinite(health.at)||health.at<startedAt)return fail('health predates the restart');
 if(health.characterId!==target)return fail(`Host runs ${health.characterId}, not ${target}`);
 if(health.personaSource!=='compiled'&&!(allowNeutral&&health.personaSource==='neutral'))return fail(`persona source is ${health.personaSource}`);
 return {ok:true};
}
function validateRequest(raw){
 let request;try{request=JSON.parse(raw.replace(/^﻿/,''));}catch{return {error:'invalid'};}
 try{validId(request&&request.target);validId(request.previous);}catch{return {error:'invalid',target:request&&request.target};}
 if(request.target===request.previous||typeof request.requestedAt!=='number'||typeof request.nonce!=='string')return {error:'invalid',target:request.target};
 return {request};
}
// Only `pending` looks at age; a started switch must not expire halfway.
function parseRequest(raw,now=Date.now()){
 const parsed=validateRequest(raw);if(!parsed.request)return parsed;
 if(Object.hasOwn(parsed.request,'completion'))return {error:'invalid',target:parsed.request.target,nonce:parsed.request.nonce};
 if(now-parsed.request.requestedAt<=MAX_AGE_MS)return parsed;
 return {error:'expired',target:parsed.request.target,nonce:parsed.request.nonce};
}
function loadSwitch(root){
 const {request,error}=validateRequest(fs.readFileSync(paths(root).inprogress,'utf8'));
 if(!request)throw Error(`In-progress switch is ${error}`);
 const {completion}=request;
 if(Object.hasOwn(request,'completion')&&(!completion||typeof completion.ok!=='boolean'||!Number.isFinite(completion.at)))throw Error('In-progress switch has an invalid completion');
 return request;
}
function writeResult(root,fields){writeJsonAtomic(paths(root).result,{at:Date.now(),...fields});}
function publishCompletion(root,{target,nonce,completion}){
 writeResult(root,{...completion,target,nonce});
 fs.rmSync(paths(root).inprogress,{force:true});
}
const commands={
 recover(root){
  let request;try{request=loadSwitch(root);}catch(error){if(error.code==='ENOENT')return {code:EXIT.none};throw error;}
  if(request.completion){publishCompletion(root,request);return {code:EXIT.none};}
  return {code:0,out:{link:rollbackLink(root,request).state}};
 },
 pending(root){
  const {request,inprogress}=paths(root);
  if(fs.lstatSync(inprogress,{throwIfNoEntry:false}))throw Error('Character switch journal requires recovery');
  let raw;try{raw=fs.readFileSync(request,'utf8');}catch(error){if(error.code==='ENOENT')return {code:EXIT.none};throw error;}
  const parsed=parseRequest(raw);
  if(parsed.request){fs.renameSync(request,inprogress);return {code:0,out:parsed.request};}
  writeResult(root,{ok:false,target:parsed.target,nonce:parsed.nonce,reason:parsed.error});fs.rmSync(request,{force:true});
  return {code:EXIT.rejected,out:{reason:parsed.error}};
 },
 // Everything that can refuse is decided here, while the Host is still running.
 check(root){
  const r=loadSwitch(root),link=readLink(paths(root).link),previous=trustedDir(root,r.previous),target=trustedDir(root,r.target);
  if(link&&sameFile(link,target))return {code:EXIT.already,out:{target:r.target}};
  if(!link||!sameFile(link,previous))throw Error('character-current does not point at the previous character');
  return {code:0,out:{target:r.target}};
 },
 apply(root){const r=loadSwitch(root);repoint(paths(root).link,trustedDir(root,r.previous),trustedDir(root,r.target));return {code:0,out:{target:r.target}};},
 revert(root){
  const r=loadSwitch(root),{link,previous,target,state,dangling}=rollbackLink(root,r);
  if(dangling)fs.unlinkSync(link);
  if(state==='missing'||dangling)fs.symlinkSync(previous,link,'junction');
  else if(state==='target')repoint(link,target,previous);
  return {code:0,out:{previous:r.previous}};
 },
 verify(root,startedAt,pidList,role='target'){
  const r=loadSwitch(root),pids=String(pidList||'').split(',').filter(Boolean).map(Number);
  if(role!=='target'&&role!=='previous')throw Error('Unknown character verification role');
  const {link,health:healthFile}=paths(root),current=readLink(link);
  if(!current||!sameFile(current,trustedDir(root,r[role])))throw Error(`character-current does not point at the ${role} character`);
  let health=null;try{health=readJson(healthFile);}catch{}
  const verdict=checkHealth(health,{target:r[role],pids,startedAt:Number(startedAt),allowNeutral:role==='previous'});
  return {code:verdict.ok?0:1,out:verdict};
 },
 finish(root,outcome,reason,restored){
  const request=loadSwitch(root);
  if(outcome==='retry'){
   if(request.completion)throw Error('Character switch outcome is already recorded in the journal');
   writeResult(root,{ok:false,target:request.target,nonce:request.nonce,reason:reason||'rollback failed',restored:false});
   return {code:0,out:{ok:false}};
  }
  if(outcome!=='ok'&&outcome!=='fail')throw Error('Unknown character switch outcome');
  const ok=outcome==='ok';
  if(!request.completion){
   // Commit the outcome before publishing it so a retry cannot repeat Host or link changes.
   request.completion={ok,at:Date.now(),...(ok?{}:{reason:reason||'failed',restored:restored==='true'})};
   writeJsonAtomic(paths(root).inprogress,request);
  }
  publishCompletion(root,request);
  return {code:0,out:{ok:request.completion.ok}};
 },
};
function main(argv){
 const [name,root,...rest]=argv,command=commands[name];
 if(!command||!root){console.error('usage: character-switch.cjs recover|pending|check|apply|revert|verify|finish <root> ...');return 2;}
 try{const {code,out}=command(path.resolve(root),...rest);if(out!==undefined)console.log(JSON.stringify(out));return code;}
 catch(error){console.log(JSON.stringify({error:error.message}));return 1;}
}
module.exports={trustedDir,repoint,checkHealth,parseRequest};
if(require.main===module)process.exitCode=main(process.argv.slice(2));
