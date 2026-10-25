// Deterministic policy/persistence tests. Actual Agent/Session/Schedule behavior
// is covered separately by the rc.2 isolated Host probe in Character Agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
const source=file=>fs.readFileSync(new URL('./qqbot-src/dist/'+file,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export class /g,'class ')+'\n';
function factory(home,clock,durable=new Map()){
 const sandbox={...fs,resolve:path.resolve,dirname:path.dirname,homedir:()=>home,process:{pid:process.pid,env:{DSH_HOME:home}},structuredClone};
 const Prefs=vm.runInNewContext(source('model/prefs-store.js')+';PrefsStore;',sandbox);
 const live=new Map(),options=[],disposed=[];let creates=0;
 function handle(id,meta={agentPreset:'fixture'}){const agent={id,status:'idle',session:{header:{id,...meta},events:durable.get(id)?.events??[]},inbox:{hasPending:false},cancel(){this.cancelled=true;}};live.set(id,agent);return {agent,async dispose(){disposed.push(id);if(live.get(id)===agent)live.delete(id);}};}
 const agents={get:id=>live.get(id),async create(input){creates++;options.push(input);return handle(input.sessionId,input.meta);},async resume({resumeSessionId}){if(!durable.has(resumeSessionId))throw Object.assign(Error('absent'),{name:'SessionPersistenceNotFoundError'});return handle(resumeSessionId);}};
 class ModelResolver{constructor(_ctx,config){this.prefs=new Prefs();this.config=config;}getEffectiveRoute(k){return this.prefs.getOverride(k)??{provider:'fixture-provider',model:'fixture-model'};}getResumeRoute(k){return this.getEffectiveRoute(k);}getPreset(k){return this.prefs.getPreset(k);}getSessionId(k){return this.prefs.getSessionId(k);}setSessionId(k,v){this.prefs.setSessionId(k,v);}}
 class Clock extends Date{static now(){return clock.now;}}
 const timers=new Set(),IdleEvictor=vm.runInNewContext(source('session/idle-evictor.js')+';IdleEvictor;',{Date:Clock,setInterval:fn=>{timers.add(fn);return fn;},clearInterval:t=>timers.delete(t)});
 const Manager=vm.runInNewContext(source('session/session-manager.js')+';SessionManager;',{ModelResolver,IdleEvictor,SessionId:x=>x,createHash,randomUUID,Date:Clock,structuredClone,process:{cwd:()=>home}});
 let reminders=[];const ctx={on(){},get(name){if(name==='agentPresets')return {async resolve(id){if(id==='broken')throw Error('broken preset');return {id:id??'fixture'};},async mount(){}};if(name==='sessionPersistence')return {async open(id,access){assert.equal(access,'read');if(!durable.has(id))throw Object.assign(Error('absent'),{name:'SessionPersistenceNotFoundError'});return {header:durable.get(id).meta,read:async()=>({events:durable.get(id).events}),close:async()=>{}};}};if(name==='schedule')return {async list(){return reminders;}};if(name==='sessions')return {async flush(session){durable.set(session.header.id,{meta:{agentPreset:session.header.agentPreset},events:structuredClone(session.events)});return true;}};}};
 const config={appId:'fixture-app',preset:'fixture',cwd:home,sessionIdleTimeout:1,sessionLifecycle:{enabled:true,freshOnHostRestart:true,inactivityMs:43200000}},manager=new Manager(ctx,agents,config,{info(){},warn(){},debug(){}});
 const get=id=>manager.getOrCreate('c2c','owner','owner',{scope:'c2c',targetId:'owner',msgId:id});
 return {manager,get,config,live,durable,options,disposed,creates:()=>creates,setReminders:rows=>reminders=rows};
}
const fixture=()=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'qq-lifecycle-')),clock={now:Date.now()},f=factory(home,clock);return {...f,home,clock};};
test('opt-in restart rotation creates a blank root, preserves model/preset preferences and survives HMR in one process',async()=>{
 const f=fixture(),first=await f.get('first'),key=first.sessionKey,prefs=f.manager.modelResolver.prefs;
 prefs.setOverride(key,{provider:'selected',model:'selected-model'});prefs.setPreset(key,'fixture');first.agent.session.events.push({type:'user/message',data:{text:'old private history'}});await f.manager.ctx.get('sessions').flush(first.agent.session);
 await f.manager.disposeAll();const resumed=factory(f.home,f.clock,f.durable),second=await resumed.get('first');assert.notEqual(second.sessionId,first.sessionId);assert.equal(second.agent.session.events.length,0);
 const input=resumed.options[0];assert(!input.seed);assert(!input.meta.parentSession);assert.equal(input.agentOptions.model,'selected-model');assert.equal(input.meta.agentPreset,'fixture');
 // A manager reconstructed within the same VM keeps its module boot id.
 const Same=resumed.manager.constructor;await resumed.manager.disposeAll();const hmr=new Same(resumed.manager.ctx,resumed.manager.agents,resumed.config,{info(){},warn(){},debug(){}});
 assert.equal((await hmr.getOrCreate('c2c','owner','owner',{scope:'c2c',targetId:'owner',msgId:'hmr'})).sessionId,second.sessionId);
 await hmr.disposeAll();
});
test('12h idle is based on admitted user messages, distinct from Agent eviction',async()=>{
 const f=fixture(),first=await f.get('first');f.clock.now+=3600000;first.lastActivity=0;f.manager.evictor.check();assert.equal(f.manager.size,0);assert.equal(f.manager.currentSessionId(first.sessionKey),first.sessionId);
 const restored=await f.get('after-eviction');assert.equal(restored.sessionId,first.sessionId);
 f.clock.now+=43200001;const fresh=await f.get('after-12h');assert.notEqual(fresh.sessionId,first.sessionId);assert.equal(f.manager.modelResolver.prefs.getLifecycle(first.sessionKey).generation,2);await f.manager.disposeAll();
});
test('running work, inbox, approval and question wait prevent both eviction and rotation',async()=>{
 for(const blocker of ['running','inbox','approval','question']){const f=fixture(),old=await f.get('first');f.clock.now+=43200001;old.lastActivity=0;
  if(blocker==='running')old.agent.status='running';if(blocker==='inbox')old.agent.inbox.hasPending=true;
  f.manager.approvalChannel={pending:new Map(),cancelPending(){}};f.manager.questionChannel={pending:new Map(),cancelPending(){}};
  if(blocker==='approval')f.manager.approvalChannel.pending.set(old.sessionKey,{});if(blocker==='question')f.manager.questionChannel.pending.set(old.sessionKey,{});
  f.manager.evictor.check();assert.equal(f.manager.size,1);assert.equal((await f.get('while-blocked')).sessionId,old.sessionId);assert(!old.agent.cancelled);
  old.agent.status='idle';old.agent.inbox.hasPending=false;f.manager.approvalChannel.pending.clear();f.manager.questionChannel.pending.clear();assert.notEqual((await f.get('after-release')).sessionId,old.sessionId);await f.manager.disposeAll();}
});
test('uncompleted durable input delays restart rotation, but ordinary settled history does not',async()=>{
 const f=fixture(),old=await f.get('first');old.agent.session.events.push({type:'turn/start',data:{turn:1}});await f.manager.ctx.get('sessions').flush(old.agent.session);await f.manager.disposeAll();
 const second=factory(f.home,f.clock,f.durable),restored=await second.get('restarted');assert.equal(restored.sessionId,old.sessionId);assert.equal(second.creates(),0);
 restored.agent.session.events.push({type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});assert.notEqual((await second.get('next')).sessionId,old.sessionId);await second.manager.disposeAll();
});
test('concurrent admission creates exactly one fresh Session, and a failed preset cannot replace its route',async()=>{
 const f=fixture(),all=await Promise.all(Array.from({length:10},(_,i)=>f.get('msg-'+i)));assert.equal(new Set(all.map(r=>r.sessionId)).size,1);assert.equal(f.creates(),1);
 const old=all[0],key=old.sessionKey;f.clock.now+=43200001;old.agentPreset='broken';await assert.rejects(()=>f.get('bad'),/broken preset/);assert.equal(f.manager.currentSessionId(key),old.sessionId);assert(!f.disposed.includes(old.sessionId));await f.manager.disposeAll();
});
test('existing reminders defer generic QQ rotation unless a trusted stable-conversation bridge accepts the old root',async()=>{
 const f=fixture(),old=await f.get('first');f.setReminders([{id:'existing'}]);f.clock.now+=43200001;assert.equal((await f.get('without-bridge')).sessionId,old.sessionId);assert.equal(f.manager.modelResolver.prefs.getLifecycle(old.sessionKey).blocker,'existing_schedule');
 f.manager.preserveScheduledSession=id=>id===old.sessionId;assert.notEqual((await f.get('with-bridge')).sessionId,old.sessionId);await f.manager.disposeAll();
});
test('prefs write failure, corruption and stale writers cannot publish or overwrite routing',async()=>{
 const f=fixture(),old=await f.get('first'),prefs=f.manager.modelResolver.prefs,original=prefs.persist.bind(prefs);f.clock.now+=43200001;let writes=0;prefs.persist=data=>{if(++writes===2)throw Error('disk full');original(data);};
 await assert.rejects(()=>f.get('disk-failure'),/disk full/);assert.equal(f.manager.currentSessionId(old.sessionKey),old.sessionId);assert.equal(f.manager.getSessionRecord('c2c','owner').sessionId,old.sessionId);assert.equal(f.disposed.length,1);
 const file=prefs.prefsPath,valid=fs.readFileSync(file,'utf8');fs.writeFileSync(file,'{broken');prefs.persist=original;await assert.rejects(()=>f.get('stale'),/changed externally/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
 const corrupt=factory(f.home,f.clock,f.durable);await assert.rejects(()=>corrupt.get('corrupt'),/could not be loaded/);fs.writeFileSync(file,valid);await corrupt.manager.disposeAll();await f.manager.disposeAll();
});
test('default-disabled policy preserves legacy resume behavior',async()=>{
 const f=fixture();f.config.sessionLifecycle.enabled=false;const first=await f.get('first');await f.manager.ctx.get('sessions').flush(first.agent.session);await f.manager.disposeAll();const next=factory(f.home,f.clock,f.durable);next.config.sessionLifecycle.enabled=false;assert.equal((await next.get('restarted')).sessionId,first.sessionId);await next.manager.disposeAll();
});
test('manual reset is serialized behind a pending rotation and cannot publish a stale Agent route',async()=>{
 const f=fixture(),old=await f.get('first');f.clock.now+=43200001;
 const create=f.manager.agents.create;let release,entered;const started=new Promise(r=>entered=r);
 f.manager.agents.create=async input=>{entered();await new Promise(r=>release=r);return create(input);};
 const rotating=f.get('rotate');await started;const resetting=f.manager.remove('c2c','owner');release();const fresh=await rotating;await resetting;
 assert.notEqual(fresh.sessionId,old.sessionId);assert.equal(f.manager.size,0);assert.notEqual(f.manager.currentSessionId(old.sessionKey),fresh.sessionId);assert(fresh.agent.cancelled);await f.manager.disposeAll();
});
test('work starting or shutdown during the final durable flush cannot be interrupted by rotation',async()=>{
 for(const closing of [false,true]){
  const f=fixture(),old=await f.get('first');f.clock.now+=43200001;const get=f.manager.ctx.get.bind(f.manager.ctx);let release,entered;const started=new Promise(r=>entered=r);
  f.manager.ctx.get=name=>name==='sessions'?{async flush(){entered();await new Promise(r=>release=r);return true;}}:get(name);
  const rotation=f.get('race');await started;
  if(closing){const disposed=f.manager.disposeAll();release();await assert.rejects(()=>rotation,/closed during rotation/);await disposed;}
  else{old.agent.status='running';release();assert.equal((await rotation).sessionId,old.sessionId);assert(!old.agent.cancelled);assert.equal(f.manager.currentSessionId(old.sessionKey),old.sessionId);old.agent.status='idle';await f.manager.disposeAll();}
 }
});
