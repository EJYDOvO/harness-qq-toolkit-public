import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
// One writer per state file in this process, shared by every module instance (HMR reloads a fresh module).
const writers=globalThis[Symbol.for('dsh.identity-access.writers')]??=new Set();
const DEFAULT_PRESETS=Object.freeze({owner:'character',contact:'character-contact',guest:'character-guest'});
const NON_OWNER=Object.freeze(['chat','reply','hitl']);
const AUDIT_LIMIT=1000;
const field=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const presetName=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x);
const principal=(provider,subject)=>'principal-'+createHash('sha256').update(JSON.stringify([provider,subject])).digest('hex');
const mask=subject=>typeof subject==='string'?(subject.length<=6?'*'.repeat(subject.length):'…'+subject.slice(-6)):undefined;
const load=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));

// Host-only service: provider.verify is installed by trusted Host code, never RPC/model data.
export function createIdentityAccess({stateFile,owner,ownerFile,presets:names,legacyOwnerPresets=[],now=Date.now,persist}={}){
 if(owner===undefined&&ownerFile!==undefined){if(!path.isAbsolute(ownerFile))throw Error('Owner binding file must be absolute');owner=load(ownerFile);}
 if(!path.isAbsolute(stateFile??'')||!field(owner?.provider)||!field(owner?.subject))throw Error('Explicit trusted state and Owner binding required');
 const roles=Object.freeze({...DEFAULT_PRESETS,...names});
 if(!Object.values(roles).every(presetName)||new Set(Object.values(roles)).size!==3||!Array.isArray(legacyOwnerPresets)||!legacyOwnerPresets.every(presetName)||legacyOwnerPresets.some(id=>Object.values(roles).includes(id))||new Set(legacyOwnerPresets).size!==legacyOwnerPresets.length)throw Error('Invalid role Preset configuration');
 // The legacy Owner Preset name is accepted for the Owner only, never offered to another role.
 const accepted=Object.freeze({owner:Object.freeze([roles.owner,...legacyOwnerPresets]),contact:Object.freeze([roles.contact]),guest:Object.freeze([roles.guest])});
 const key=path.resolve(stateFile);if(writers.has(key))throw Error('Identity state already owned');
 const ownerId=principal(owner.provider,owner.subject),fingerprint=createHash('sha256').update(ownerId).digest('hex');
 let state={schemaVersion:1,owner:fingerprint,epoch:0,accounts:{},audit:[]},closed=false,faulted=false;
 if(fs.existsSync(key))state=load(key);
 if(state.schemaVersion!==1||state.owner!==fingerprint||!Number.isSafeInteger(state.epoch)||state.epoch<0||!state.accounts||Array.isArray(state.accounts)||!Array.isArray(state.audit))throw Error('Identity state incompatible or damaged');
 for(const [id,row]of Object.entries(state.accounts))if(id===ownerId||!/^principal-[a-f0-9]{64}$/.test(id)||!row||!['contact',undefined].includes(row.role)||typeof row.blocked!=='boolean'||row.expires!==null&&!Number.isFinite(row.expires)||row.provider!==undefined&&(!field(row.provider)||!field(row.subject)||principal(row.provider,row.subject)!==id))throw Error('Invalid persisted role state');
 const providers=new Map(),identities=new WeakMap(),known=new Map(),leases=new Map(),sessions=new Map(),revisions=new Map(),conversations=new Map();
 const save=persist??(next=>{fs.mkdirSync(path.dirname(key),{recursive:true});const tmp=key+'.'+randomUUID()+'.tmp';let fd;try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,key);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}});
 writers.add(key);
 function active(){if(closed||faulted)throw Error('Identity service unavailable');}
 function identity(handle){active();const row=identities.get(handle);if(!row||providers.get(row.provider)!==row.registration)throw Error('Untrusted or revoked platform identity');return row;}
 function policy(id){const row=state.accounts[id];return {principalId:id,role:id===ownerId?'owner':row?.role==='contact'&&(row.expires===null||now()<row.expires)?'contact':'guest',blocked:row?.blocked===true,expires:row?.role==='contact'?row.expires:null};}
 function revoke(lease){lease.controller.abort();leases.delete(lease.handle);if(sessions.get(lease.sessionId)===lease)sessions.delete(lease.sessionId);}
 function revokePrincipal(id){revisions.set(id,(revisions.get(id)??0)+1);for(const lease of [...leases.values()])if(lease.principalId===id)revoke(lease);}
 // Any persistence exception revokes all leases: no grant continues on assumed in-memory success.
 function commit(next){try{save(next);}catch(error){faulted=true;for(const lease of [...leases.values()])revoke(lease);throw error;}state=next;}
 function authorize(handle,{sessionId,operation='chat',preset}={}){
  active();const lease=leases.get(handle);if(!lease)throw Error('Unknown authorization');
  let current;try{identity(lease.identity);current=policy(lease.principalId);}catch(e){revoke(lease);throw e;}
  // Expiry, role change and blocking take effect at this check; the lease is not renewed.
  if(lease.revision!==(revisions.get(lease.principalId)??0)||lease.role!==current.role||current.blocked||lease.sessionId!==sessionId||!accepted[current.role].includes(lease.preset)||preset!==undefined&&preset!==lease.preset){revoke(lease);throw Error('Authorization revoked');}
  if(!NON_OWNER.includes(operation)&&current.role!=='owner')throw Error('Owner operation required');
  return Object.freeze({...current,preset:lease.preset,sessionId,policyEpoch:state.epoch});
 }
 function issue(verified,{sessionId,preset}={}){
  const who=identity(verified),p=policy(who.principalId);
  if(p.blocked||!field(sessionId)||!accepted[p.role].includes(preset))throw Error('Preset authorization denied');
  // A Session belongs to one Principal; another account cannot take over its authorization.
  const bound=sessions.get(sessionId);if(bound&&bound.principalId!==p.principalId)throw Error('Session belongs to another Principal');
  const handle=Object.freeze({}),controller=new AbortController(),lease={handle,controller,identity:verified,principalId:p.principalId,role:p.role,revision:revisions.get(p.principalId)??0,sessionId,preset};
  leases.set(handle,lease);sessions.set(sessionId,lease);return Object.freeze({handle,signal:controller.signal});
 }
 function admin(actor){const who=identity(actor);if(who.principalId!==ownerId)throw Error('Owner operation required');return who;}
 function view(id){const row=state.accounts[id];return Object.freeze({...policy(id),provider:row?.provider,account:mask(row?.subject)});}
 function change(actor,{target,action,durationMs=null,expectedEpoch}={}){
  admin(actor);const who=identity(target);if(who.principalId===ownerId)throw Error('Owner binding is immutable');
  if(expectedEpoch!==state.epoch)throw Error('Policy revision conflict');
  if(!['grant','revoke','block','unblock'].includes(action)||durationMs!==null&&(!Number.isSafeInteger(durationMs)||durationMs<=0||!Number.isSafeInteger(now()+durationMs)))throw Error('Invalid role mutation');
  const next=structuredClone(state),row=next.accounts[who.principalId]??{blocked:false,expires:null};
  if(action==='grant'){row.role='contact';row.expires=durationMs===null?null:now()+durationMs;}
  if(action==='revoke'){delete row.role;row.expires=null;}
  if(action==='block')row.blocked=true;if(action==='unblock')row.blocked=false;
  row.provider=who.provider;row.subject=who.subject;next.accounts[who.principalId]=row;next.epoch++;
  next.audit.push({id:randomUUID(),at:now(),actor:ownerId,target:who.principalId,action,expires:row.expires,epoch:next.epoch});
  if(next.audit.length>AUDIT_LIMIT)next.audit.splice(0,next.audit.length-AUDIT_LIMIT);
  commit(next);revokePrincipal(who.principalId);
  return Object.freeze({policyEpoch:state.epoch,...view(who.principalId)});
 }
 const service={contractVersion:1,
  registerProvider(id,verify){active();if(!field(id)||typeof verify!=='function'||providers.has(id))throw Error('Invalid identity Provider');const registration={verify};providers.set(id,registration);let removed=false;return Object.freeze({
   async resolve(evidence){active();if(removed)throw Error('Provider revoked');const result=await verify(evidence);active();if(removed||providers.get(id)!==registration||!field(result?.subject))throw Error('Unverified platform identity');const who=Object.freeze({provider:id,subject:result.subject,principalId:principal(id,result.subject),registration});const handle=Object.freeze({});identities.set(handle,who);known.set(who.principalId,handle);return handle;},
   close(){if(removed)return;removed=true;if(providers.get(id)===registration)providers.delete(id);for(const lease of [...leases.values()])if(identities.get(lease.identity)?.registration===registration)revoke(lease);}
  });},
  resolve(verified){return Object.freeze(policy(identity(verified).principalId));},
  presetsFor(role){if(!accepted[role])throw Error('Unknown role');return accepted[role];},
  // A verified non-Owner is remembered (provider and account, no role) so the Owner can reference it after restart.
  note(verified){const who=identity(verified);if(who.principalId===ownerId||state.accounts[who.principalId])return;const next=structuredClone(state);next.accounts[who.principalId]={provider:who.provider,subject:who.subject,blocked:false,expires:null};commit(next);},
  // Host-side check of an outbound target of a registered Provider (no lease involved).
  targetPolicy(providerId,subject){active();if(!providers.has(providerId)||!field(subject))throw Error('Unknown platform account');return Object.freeze(policy(principal(providerId,subject)));},
  issue,authorize,change,
  // The current lease of a native Session, if it is role-managed (Host-only).
  sessionLease(sessionId){active();return sessions.get(sessionId)?.handle;},
  show(actor,{target}={}){admin(actor);return view(identity(target).principalId);},
  list(actor){admin(actor);return Object.keys(state.accounts).map(view);},
  audit(actor){admin(actor);return structuredClone(state.audit);},
  reference(actor,{principalId}={}){
   admin(actor);let handle=known.get(principalId);
   // A handle from a closed or re-registered Provider is stale; rebuild from the stored verified account.
   if(handle){const row=identities.get(handle);if(!row||providers.get(row.provider)!==row.registration)handle=undefined;}
   if(!handle){const row=state.accounts[principalId],registration=providers.get(row?.provider);if(!registration||!field(row.subject)||principal(row.provider,row.subject)!==principalId)throw Error('No verified account reference');handle=Object.freeze({});identities.set(handle,Object.freeze({provider:row.provider,subject:row.subject,principalId,registration}));known.set(principalId,handle);}
   identity(handle);return handle;
  },
  // The management API bound to one verified Owner actor (each call re-checks it).
  manager(actor){admin(actor);return Object.freeze({list:()=>service.list(actor),show:target=>service.show(actor,{target}),change:options=>service.change(actor,options),reference:principalId=>service.reference(actor,{principalId}),get policyEpoch(){return service.policyEpoch;}});},
  conversation(spec){active();const id=JSON.stringify([spec?.platform,spec?.adapter,spec?.accountId]);let value=conversations.get(id);if(!value||value.closed){value=createConversation(spec);conversations.set(id,value);}return value.access;},
  get policyEpoch(){active();return state.epoch;},
  get roles(){return roles;},
  close(){if(closed)return;closed=true;for(const value of conversations.values())value.close();conversations.clear();for(const lease of [...leases.values()])revoke(lease);providers.clear();known.clear();writers.delete(key);}
 };
 // The Agent I/O Conversation access contract (Gate 2) of one platform account.
 // admit() is called by the Agent I/O only for inputs that came through its
 // inbound channel or command claim; the Provider trusts nothing else.
 function createConversation({platform,adapter,accountId}={}){
  if(![platform,adapter,accountId].every(field))throw Error('Conversation access requires platform, adapter and accountId');
  const providerId=platform+':'+adapter+':'+accountId,proofs=new WeakSet(),bindings=new Map(),listeners=new Set();
  const provider=service.registerProvider(providerId,input=>proofs.has(input)?{subject:input.sender.id}:undefined);
  const value={closed:false};
  const live=()=>!value.closed&&!closed&&!faulted;
  // The Owner of this account comes from local trusted configuration; a Session
  // restored without input (startup, Schedule) may be re-bound to the Owner
  // only, never to another role.
  function adopt(record){
   if(!live()||owner.provider!==providerId||record?.peerId!==owner.subject||!accepted.owner.includes(record.agentPreset))return false;
   const registration=providers.get(providerId);if(!registration)return false;
   const verified=Object.freeze({});identities.set(verified,Object.freeze({provider:providerId,subject:owner.subject,principalId:ownerId,registration}));
   try{bind(Object.freeze({principalId:ownerId,role:'owner',presets:accepted.owner,identity:verified}),record);return true;}catch{return false;}
  }
  async function admit(input){
   if(!live())return undefined;
   // v1: direct Conversations only, whose peer is the sender; a group Session would mix Principals.
   if(input?.conversation?.type!=='direct'||!field(input.sender?.id)||input.sender.id!==input.conversation.id)return undefined;
   proofs.add(input);let verified;try{verified=await provider.resolve(input);}finally{proofs.delete(input);}
   const p=service.resolve(verified);if(p.blocked)return undefined;
   if(p.role!=='owner')service.note(verified);
   // The Owner's admission carries the management API bound to that verified actor,
   // so a command registered once keeps using the current service after a reload.
   return Object.freeze({principalId:p.principalId,role:p.role,presets:accepted[p.role],identity:verified,...(p.role==='owner'?{manage:service.manager(verified)}:{})});
  }
  function bind(admission,record){
   if(!live())throw Error('Identity service unavailable');
   const current=bindings.get(record.sessionId);
   if(current?.principalId===admission.principalId){try{authorize(current.handle,{sessionId:record.sessionId,preset:record.agentPreset});return;}catch{}}
   const {handle,signal}=issue(admission.identity,{sessionId:record.sessionId,preset:record.agentPreset});
   bindings.set(record.sessionId,{handle,principalId:admission.principalId});
   signal.addEventListener('abort',()=>{if(bindings.get(record.sessionId)?.handle!==handle)return;bindings.delete(record.sessionId);for(const fn of listeners)try{fn(record.sessionId);}catch{}},{once:true});
  }
  function allows(sessionId,operation){const current=bindings.get(sessionId);if(!current||!live())return false;try{authorize(current.handle,{sessionId,operation});return true;}catch{return false;}}
  value.access=Object.freeze({contractVersion:1,admit,bind,adopt,authorize:allows,
   managed:sessionId=>bindings.has(sessionId),
   // Owner may run every registered command; other roles only those that declare them.
   command:(admission,spec)=>admission?.role==='owner'||Array.isArray(spec?.roles)&&spec.roles.includes(admission?.role),
   // Input replies may answer any non-blocked direct account; notifications reach the Owner only.
   outbound(target,{kind}={}){if(!live()||target?.type!=='direct')return false;let p;try{p=service.targetPolicy(providerId,target.id);}catch{return false;}return !p.blocked&&(kind==='reply'||p.role==='owner');},
   onRevoke(fn){listeners.add(fn);return()=>listeners.delete(fn);},
   commands:()=>[ROLE_COMMAND],
  });
  value.close=()=>{if(value.closed)return;value.closed=true;listeners.clear();bindings.clear();provider.close();};
  return value;
 }
 return Object.freeze(service);
}

const DURATION=/^(\d{1,6})(m|h|d)$/,UNIT={m:60000,h:3600000,d:86400000},MAX_DURATION=366*86400000;
function line(row){return [row.principalId,row.role,...(row.blocked?['blocked']:[]),...(row.expires!==null?['until '+new Date(row.expires).toISOString()]:[]),...(row.account?[row.account]:[])].join(' ');}
// Owner-only /role for the Agent I/O command router: the router's gate supplies
// call.access (the verified admission and, for the Owner, its management API);
// the return value is the reply text. Stateless, so it survives a service reload.
export const ROLE_COMMAND=roleCommandSpec();
export function roleCommandSpec(){
 return Object.freeze({name:'role',scopes:['direct'],hidden:true,category:'identity',description:'Owner 管理角色授权',usage:'/role list | show <principal> | grant contact <principal> [30m|12h|7d] | revoke|block|unblock <principal>',
  async execute(call){
   const manage=call.access?.manage;if(!manage||call.access.role!=='owner')throw Error('Owner operation required');
   const args=call.args??[],operation=args[0];
   if(operation==='list'&&args.length===1){const rows=manage.list();return rows.length?rows.map(line).join('\n'):'(no recorded accounts)';}
   const grant=operation==='grant';
   if(!['show','grant','revoke','block','unblock'].includes(operation))throw Error('Unknown role operation');
   if(grant&&args[1]!=='contact')throw Error('Only contact can be granted');
   let durationMs=null;
   if(grant&&args[3]!==undefined){const match=DURATION.exec(args[3]);if(!match)throw Error('Duration uses m/h/d');durationMs=Number(match[1])*UNIT[match[2]];if(durationMs>MAX_DURATION)throw Error('Duration too long');}
   if(args.length!==(grant?(args[3]===undefined?3:4):2))throw Error('Invalid role arguments');
   const target=manage.reference(args[grant?2:1]);
   if(operation==='show')return line(manage.show(target));
   return line(manage.change({target,action:operation,expectedEpoch:manage.policyEpoch,durationMs}));
  }});
}
