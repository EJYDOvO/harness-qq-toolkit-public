// Character switch helper for the maintenance watchdog. manage.ps1 stays thin and asks this file
// what to do; it only knows the file formats the Character manager writes, never its code.
//   pending <root>                          0 request accepted and moved to character-switch.inprogress.json (printed) | 3 none | 4 invalid or expired (result written, request removed)
//   check <root>                            0 link at previous, ready | 5 link already at target | 1 refused (nothing was changed)
//   Every step after pending reads only the in-progress snapshot: neither the clock nor a newer request can change a started switch.
//   apply <root> | revert <root>            repoint data/character-current
//   verify <root> <startedAtMs> <pid,pid>   0 when the restarted Host serves the target's compiled persona
//   finish <root> ok|fail [reason] [true|false]   write the result, remove the in-progress snapshot
const fs=require('node:fs'),path=require('node:path');
const ID=/^[a-z0-9-]{1,48}$/,MAX_AGE_MS=15*60*1000,EXIT={none:3,rejected:4,already:5};
const paths=(root)=>{const data=path.join(root,'data'),state=path.join(data,'maintenance');return {data,link:path.join(data,'character-current'),registry:path.join(data,'characters','registry.json'),request:path.join(state,'character-switch.json'),inprogress:path.join(state,'character-switch.inprogress.json'),result:path.join(state,'character-switch-result.json'),health:path.join(data,'character-current','runtime-health.json')};};
const readJson=(file)=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));
function writeJsonAtomic(file,value){const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}
const sameFile=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const isInside=(parent,child)=>{const rel=path.relative(parent,child);return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
function validId(id){if(typeof id!=='string'||!ID.test(id)||id==='current')throw Error(`Invalid character id: ${id}`);return id;}

// The only two places a character directory may live, checked independently of the Character package.
function trustedDir(root,id){
 validId(id);const {data,registry}=paths(root);
 const entry=((readJson(registry).characters)||[]).find((c)=>c&&c.id===id);
 if(!entry||typeof entry.dir!=='string')throw Error(`Character ${id} is not registered`);
 if(!path.isAbsolute(entry.dir))throw Error(`Directory of ${id} is not an absolute path`);
 const dir=path.resolve(entry.dir);
 if(![path.join(data,'characters',id),path.join(data,`character-${id}`)].some((allowed)=>sameFile(allowed,dir)))throw Error(`Directory of ${id} is not an allowed location`);
 if(!fs.lstatSync(dir).isDirectory())throw Error(`Directory of ${id} is a link or not a directory`);
 const real=fs.realpathSync(dir);
 if(!isInside(fs.realpathSync(data),real))throw Error(`Directory of ${id} is outside data`);
 let binding;try{binding=readJson(path.join(real,'binding.json'));}catch{throw Error(`Directory of ${id} has no readable binding.json`);}
 if(!binding||binding.characterId!==id)throw Error(`binding.json of ${id} names another character`);
 return real;
}
// Replace a junction. unlink on a junction removes only the link, never the target's contents.
function repoint(link,expectedDir,nextDir){
 const stat=fs.lstatSync(link);if(!stat.isSymbolicLink())throw Error('character-current is not a link');
 if(!sameFile(fs.realpathSync(link),fs.realpathSync(expectedDir)))throw Error(`Link does not point at the expected directory ${expectedDir}`);
 fs.unlinkSync(link);
 try{fs.symlinkSync(nextDir,link,'junction');}catch(error){fs.symlinkSync(expectedDir,link,'junction');throw error;}
}
function checkHealth(health,{target,pids,startedAt}){
 const fail=(reason)=>({ok:false,reason});
 if(!health||typeof health!=='object')return fail('no runtime health');
 if(!pids.includes(health.pid))return fail('health is not from the restarted Host');
 if(typeof health.at!=='number'||health.at<startedAt)return fail('health predates the restart');
 if(health.characterId!==target)return fail(`Host runs ${health.characterId}, not ${target}`);
 if(health.personaSource!=='compiled')return fail(`persona source is ${health.personaSource}`);
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
 const parsed=validateRequest(raw);if(!parsed.request||now-parsed.request.requestedAt<=MAX_AGE_MS)return parsed;
 return {error:'expired',target:parsed.request.target,nonce:parsed.request.nonce};
}
const loadSwitch=(root)=>{const parsed=validateRequest(fs.readFileSync(paths(root).inprogress,'utf8'));if(!parsed.request)throw Error(`In-progress switch is ${parsed.error}`);return parsed.request;};
function writeResult(root,fields){writeJsonAtomic(paths(root).result,{...fields,at:Date.now()});}

const commands={
 pending(root){
  const {request,inprogress}=paths(root);let raw;try{raw=fs.readFileSync(request,'utf8');}catch(error){if(error.code==='ENOENT')return {code:EXIT.none};throw error;}
  const parsed=parseRequest(raw);
  if(parsed.request){fs.renameSync(request,inprogress);return {code:0,out:parsed.request};}
  writeResult(root,{ok:false,target:parsed.target,nonce:parsed.nonce,reason:parsed.error});fs.rmSync(request,{force:true});
  return {code:EXIT.rejected,out:{reason:parsed.error}};
 },
 // Everything that can refuse is decided here, while the Host is still running.
 check(root){
  const r=loadSwitch(root),link=fs.realpathSync(paths(root).link),previous=trustedDir(root,r.previous),target=trustedDir(root,r.target);
  if(sameFile(link,target))return {code:EXIT.already,out:{target:r.target}};
  if(!sameFile(link,previous))throw Error('character-current does not point at the previous character');
  return {code:0,out:{target:r.target}};
 },
 apply(root){const r=loadSwitch(root);repoint(paths(root).link,trustedDir(root,r.previous),trustedDir(root,r.target));return {code:0,out:{target:r.target}};},
 revert(root){
  const r=loadSwitch(root),previous=trustedDir(root,r.previous),link=paths(root).link;
  if(!sameFile(fs.realpathSync(link),previous))repoint(link,trustedDir(root,r.target),previous);
  return {code:0,out:{previous:r.previous}};
 },
 verify(root,startedAt,pidList){
  const r=loadSwitch(root),pids=String(pidList||'').split(',').filter(Boolean).map(Number);
  let health=null;try{health=readJson(paths(root).health);}catch{}
  const verdict=checkHealth(health,{target:r.target,pids,startedAt:Number(startedAt)});
  return {code:verdict.ok?0:1,out:verdict};
 },
 finish(root,outcome,reason,restored){
  let request={};try{request=loadSwitch(root);}catch{}
  const ok=outcome==='ok';
  // The snapshot goes even when the result cannot be written, so a finished switch is never replayed.
  try{writeResult(root,ok?{ok:true,target:request.target,nonce:request.nonce}:{ok:false,target:request.target,nonce:request.nonce,reason:reason||'failed',restored:restored==='true'});}
  finally{fs.rmSync(paths(root).inprogress,{force:true});}
  return {code:0,out:{ok}};
 },
};
function main(argv){
 const [name,root,...rest]=argv,command=commands[name];
 if(!command||!root){console.error('usage: character-switch.cjs pending|apply|revert|verify|finish <root> ...');return 2;}
 try{const {code,out}=command(path.resolve(root),...rest);if(out!==undefined)console.log(JSON.stringify(out));return code;}
 catch(error){console.log(JSON.stringify({error:error.message}));return 1;}
}
module.exports={trustedDir,repoint,checkHealth,parseRequest};
if(require.main===module)process.exitCode=main(process.argv.slice(2));
