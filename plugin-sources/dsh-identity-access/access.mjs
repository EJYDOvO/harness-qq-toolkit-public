import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const writers=new Set();
const presets=Object.freeze({owner:'character',contact:'character-contact',guest:'character-guest'});
const field=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const principal=(provider,subject)=>'principal-'+createHash('sha256').update(JSON.stringify([provider,subject])).digest('hex');

// Host-only service: provider.verify is installed by trusted Host code, never RPC/model data.
export function createIdentityAccess({stateFile,owner,now=Date.now,persist}={}){
 if(!path.isAbsolute(stateFile??'')||!field(owner?.provider)||!field(owner?.subject))throw Error('Explicit trusted state and Owner binding required');
 const key=path.resolve(stateFile);if(writers.has(key))throw Error('Identity state already owned');
 const ownerId=principal(owner.provider,owner.subject),fingerprint=createHash('sha256').update(ownerId).digest('hex');
 let state={schemaVersion:1,owner:fingerprint,epoch:0,accounts:{},audit:[]},closed=false,faulted=false;
 if(fs.existsSync(key))state=JSON.parse(fs.readFileSync(key,'utf8'));
 if(state.schemaVersion!==1||state.owner!==fingerprint||!Number.isSafeInteger(state.epoch)||state.epoch<0||!state.accounts||Array.isArray(state.accounts)||!Array.isArray(state.audit))throw Error('Identity state incompatible or damaged');
 for(const [id,row]of Object.entries(state.accounts))if(id===ownerId||!/^principal-[a-f0-9]{64}$/.test(id)||!row||!['contact',undefined].includes(row.role)||typeof row.blocked!=='boolean'||row.expires!==null&&!Number.isFinite(row.expires))throw Error('Invalid persisted role state');
 const providers=new Map(),identities=new WeakMap(),known=new Map(),leases=new Map();
 const save=persist??(next=>{fs.mkdirSync(path.dirname(key),{recursive:true});const tmp=key+'.'+randomUUID()+'.tmp';let fd;try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,key);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}});
 writers.add(key);
 function active(){if(closed||faulted)throw Error('Identity service unavailable');}
 function identity(handle){active();const row=identities.get(handle);if(!row||providers.get(row.provider)!==row.registration)throw Error('Untrusted or revoked platform identity');return row;}
 function policy(id){const row=state.accounts[id];return {principalId:id,role:id===ownerId?'owner':row?.role==='contact'&&(row.expires===null||now()<row.expires)?'contact':'guest',blocked:row?.blocked===true,expires:row?.expires??null};}
 function revoke(lease){lease.controller.abort();leases.delete(lease.handle);}
 function authorize(handle,{sessionId,operation='chat',preset}={}){
  active();const lease=leases.get(handle);if(!lease)throw Error('Unknown authorization');
  let current;try{identity(lease.identity);current=policy(lease.principalId);}catch(e){revoke(lease);throw e;}
  if(lease.epoch!==state.epoch||lease.role!==current.role||current.blocked||lease.sessionId!==sessionId||preset!==undefined&&preset!==presets[current.role]){revoke(lease);throw Error('Authorization revoked');}
  if(!['chat','reply','hitl'].includes(operation)&&current.role!=='owner')throw Error('Owner operation required');
  return Object.freeze({...current,preset:presets[current.role],sessionId,policyEpoch:state.epoch});
 }
 function issue(verified,{sessionId,preset}={}){const who=identity(verified),p=policy(who.principalId);if(p.blocked||!field(sessionId)||preset!==presets[p.role])throw Error('Preset authorization denied');const handle=Object.freeze({}),controller=new AbortController();leases.set(handle,{handle,controller,identity:verified,principalId:p.principalId,role:p.role,epoch:state.epoch,sessionId});return Object.freeze({handle,signal:controller.signal});}
 function admin(auth,sessionId){authorize(auth,{sessionId,operation:'roles'});}
 function change(auth,{sessionId,target,action,durationMs=null,expectedEpoch}={}){
  admin(auth,sessionId);const who=identity(target);if(who.principalId===ownerId)throw Error('Owner binding is immutable');
  if(expectedEpoch!==state.epoch)throw Error('Policy revision conflict');
  if(!['grant','revoke','block','unblock'].includes(action)||durationMs!==null&&(!Number.isSafeInteger(durationMs)||durationMs<=0||!Number.isSafeInteger(now()+durationMs)))throw Error('Invalid role mutation');
  const next=structuredClone(state),row=next.accounts[who.principalId]??{blocked:false,expires:null};
  if(action==='grant'){row.role='contact';row.expires=durationMs===null?null:now()+durationMs;}
  if(action==='revoke'){delete row.role;row.expires=null;}
  if(action==='block')row.blocked=true;if(action==='unblock')row.blocked=false;
  next.accounts[who.principalId]=row;next.epoch++;next.audit.push({id:randomUUID(),at:now(),actor:ownerId,target:who.principalId,action,expires:row.expires,epoch:next.epoch});
  try{save(next);}catch(error){faulted=true;for(const lease of [...leases.values()])revoke(lease);throw error;}state=next;for(const lease of [...leases.values()])revoke(lease);
  return Object.freeze({policyEpoch:state.epoch,...policy(who.principalId)});
 }
 return Object.freeze({contractVersion:1,
  registerProvider(id,verify){active();if(!field(id)||typeof verify!=='function'||providers.has(id))throw Error('Invalid identity Provider');const registration={verify};providers.set(id,registration);let removed=false;return Object.freeze({
   async resolve(evidence){active();if(removed)throw Error('Provider revoked');const result=await verify(evidence);active();if(removed||providers.get(id)!==registration||!field(result?.subject))throw Error('Unverified platform identity');const who=Object.freeze({provider:id,subject:result.subject,principalId:principal(id,result.subject),registration});const handle=Object.freeze({});identities.set(handle,who);known.set(who.principalId,handle);return handle;},
   close(){if(removed)return;removed=true;providers.delete(id);for(const lease of [...leases.values()])if(identities.get(lease.identity)?.registration===registration)revoke(lease);}
  });},
  resolve(verified){return Object.freeze(policy(identity(verified).principalId));},issue,authorize,change,
  show(auth,{sessionId,target}={}){admin(auth,sessionId);return Object.freeze(policy(identity(target).principalId));},
  list(auth,{sessionId}={}){admin(auth,sessionId);return Object.keys(state.accounts).map(id=>Object.freeze(policy(id)));},
  audit(auth,{sessionId}={}){admin(auth,sessionId);return structuredClone(state.audit);},
  reference(auth,{sessionId,principalId}={}){admin(auth,sessionId);const handle=known.get(principalId);identity(handle);return handle;},
  get policyEpoch(){active();return state.epoch;},
  close(){if(closed)return;closed=true;for(const lease of [...leases.values()])revoke(lease);providers.clear();known.clear();writers.delete(key);}
 });
}
