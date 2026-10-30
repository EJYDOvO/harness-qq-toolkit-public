// Unified Agent I/O outbound core with a fake platform adapter. No QQ SDK,
// Character or Interaction is loaded; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import * as plugin from '../plugin-sources/dsh-agent-io/index.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));
const target=(id='peer',accountId='app-a',platform='fake')=>({platform,accountId,conversation:{type:'direct',id}});
// Routes are the fake equivalent of trusted Conversation Manager records.
function fakeAdapter({platform='fake',accountId='app-a',parts=t=>[t],classify}={}){
 const sent=[],routes=new Map(),gates=[];
 const adapter={platform,accountId,
  resolve:(t,o)=>{const session=routes.get(t.conversation.id);return session===undefined?{ok:false,reason:'stale'}:session===o.sessionId?{ok:true,route:{peer:t.conversation.id}}:{ok:false,reason:'stale'};},
  split:parts,
  send:async(route,text,info)=>{const gate=gates.shift();sent.push({peer:route.peer,text,index:info.index,count:info.count});if(gate)await gate.promise;if(gate?.error)throw gate.error;return {receipt:'r-'+sent.length};},
  classify};
 return {adapter,sent,routes,gate(error){const d=deferred();d.error=error;gates.push(d);return d;}};
}
const setup=(options,adapterOptions)=>{const io=createAgentIO(options),f=fakeAdapter(adapterOptions);f.routes.set('peer','s1');io.registerAdapter(f.adapter);return {io,...f};};
const msg=(text='你好',extra={})=>({target:target(),origin:{sessionId:'s1'},message:{text},...extra});

test('a text message reaches the adapter once and multi-part sends stay one logical result',async()=>{
 const {io,sent}=setup({},{parts:t=>t.split('|')});
 const r=await io.sendMessage(msg('一|二|三',{id:'m1'}));
 assert.equal(r.status,'sent');assert.equal(r.id,'m1');
 assert.deepEqual(r.parts.map(p=>[p.index,p.status,p.receipt]),[[0,'sent','r-1'],[1,'sent','r-2'],[2,'sent','r-3']]);
 assert.deepEqual(sent.map(s=>[s.text,s.index,s.count]),[['一',0,3],['二',1,3],['三',2,3]]);
 assert(Object.isFrozen(r)&&Object.isFrozen(r.parts[0]));
});
test('the core is platform-neutral: no SDK, Character or Interaction import',()=>{
 for(const file of ['io.mjs','index.mjs']){
  const imports=[...fs.readFileSync(new URL('../plugin-sources/dsh-agent-io/'+file,import.meta.url),'utf8').matchAll(/^import .* from '([^']+)'/gm)].map(m=>m[1]);
  assert(imports.every(i=>i==='node:crypto'||i==='./io.mjs'),file+': '+imports);
 }
});
test('the same logical message id is never sent twice, even while the first send is in flight',async()=>{
 const {io,sent,gate}=setup();const g=gate();
 const first=io.sendMessage(msg('一次',{id:'bubble-1'})),again=io.sendMessage(msg('一次',{id:'bubble-1'}));
 await tick();g.resolve();const [a,b]=await Promise.all([first,again]);
 assert.equal(sent.length,1);assert.equal(a.status,'sent');assert.equal(b.status,'sent');assert.equal(b.duplicate,true);
 assert.equal((await io.sendMessage(msg('一次',{id:'bubble-1'}))).duplicate,true);assert.equal(sent.length,1);
 // Without an id each call is its own logical message.
 await io.sendMessage(msg('a'));await io.sendMessage(msg('a'));assert.equal(sent.length,3);
});
test('an explicit platform rejection is not-sent and stops before later parts',async()=>{
 const {io,sent,gate}=setup({},{parts:t=>t.split('|'),classify:()=>({outcome:'not-sent',reason:'platform-rejected'})});
 const g=gate(Object.assign(Error('400'),{status:400}));g.resolve();
 const r=await io.sendMessage(msg('a|b'));
 assert.equal(r.status,'not-sent');assert.equal(r.stage,'platform');assert.equal(r.reason,'platform-rejected');
 assert.deepEqual(r.parts.map(p=>p.status),['not-sent','skipped']);assert.equal(sent.length,1);
});
test('an unknown outcome is reported as unknown and never retried',async()=>{
 const {io,sent,gate}=setup({},{parts:t=>t.split('|'),classify:()=>({outcome:'unknown',reason:'timeout'})});
 const g=gate(Error('timeout'));g.resolve();
 const r=await io.sendMessage(msg('a|b|c'));
 assert.equal(r.status,'unknown');assert.equal(r.reason,'timeout');assert.deepEqual(r.parts.map(p=>p.status),['unknown','skipped','skipped']);assert.equal(sent.length,1);
 // Without a classifier, or with a throwing one, failure is unknown rather than success or rejection.
 const plain=setup();plain.gate(Error('x')).resolve();assert.equal((await plain.io.sendMessage(msg())).status,'unknown');
 const broken=setup({},{classify:()=>{throw Error('bad');}});broken.gate(Error('x')).resolve();assert.equal((await broken.io.sendMessage(msg())).status,'unknown');
 // A later part failing after earlier parts were accepted is partial, not success.
 const later=setup({},{parts:t=>t.split('|'),classify:()=>({outcome:'not-sent',reason:'rate-limited'})});
 later.gate().resolve();later.gate(Error('429')).resolve();
 const p=await later.io.sendMessage(msg('a|b|c'));assert.equal(p.status,'partial');assert.deepEqual(p.parts.map(x=>x.status),['sent','not-sent','skipped']);
});
test('messages of one Conversation are sent in submission order',async()=>{
 const {io,sent,gate}=setup();const g=gate();
 const order=[];const all=['一','二','三'].map(t=>io.sendMessage(msg(t)).then(r=>order.push([t,r.status])));
 await tick();assert.deepEqual(sent.map(s=>s.text),['一'],'second waits for the first');
 g.resolve();await Promise.all(all);
 assert.deepEqual(sent.map(s=>s.text),['一','二','三']);assert.deepEqual(order,[['一','sent'],['二','sent'],['三','sent']]);
});
test('different Conversations proceed independently, within a concurrency bound',async()=>{
 const {io,sent,routes,gate}=setup({maxConcurrent:2});for(const p of ['p2','p3'])routes.set(p,'s1');
 const g=gate();const blocked=io.sendMessage(msg('慢'));
 const other=await io.sendMessage({...msg('快'),target:target('p2')});
 assert.equal(other.status,'sent');assert.deepEqual(sent.map(s=>s.peer),['peer','p2']);
 g.resolve();await blocked;
 const a=gate(),b=gate();const runs=['peer','p2','p3'].map(p=>io.sendMessage({...msg(p),target:target(p)}));
 await tick();assert.equal(sent.length,4,'only two Conversations may be in flight');a.resolve();b.resolve();await Promise.all(runs);assert.equal(sent.length,5);
});
test('a queued message cancelled before it starts is not sent',async()=>{
 const {io,sent,gate}=setup();const g=gate(),abort=new AbortController();
 const first=io.sendMessage(msg('一')),second=io.sendMessage(msg('二',{signal:abort.signal}));
 await tick();abort.abort();g.resolve();
 assert.equal((await first).status,'sent');const r=await second;
 assert.equal(r.status,'not-sent');assert.equal(r.reason,'cancelled');assert.equal(r.stage,'before-platform');assert.deepEqual(sent.map(s=>s.text),['一']);
 const pre=new AbortController();pre.abort();assert.equal((await io.sendMessage(msg('三',{signal:pre.signal}))).reason,'cancelled');
 // Any object with a boolean `aborted` works, so a caller's own cancel flag can be adapted.
 assert.equal((await io.sendMessage(msg('四',{signal:{aborted:true}}))).reason,'cancelled');assert.equal(sent.length,1);
});
test('cancelling during an in-flight part keeps that part and skips the rest',async()=>{
 const {io,sent,gate}=setup({},{parts:t=>t.split('|')});const g=gate(),abort=new AbortController();
 const pending=io.sendMessage(msg('a|b',{signal:abort.signal}));await tick();
 abort.abort();g.resolve();const r=await pending;
 assert.equal(r.status,'partial');assert.equal(r.reason,'cancelled');assert.deepEqual(r.parts.map(p=>p.status),['sent','skipped']);assert.equal(sent.length,1);
 // A single in-flight part cannot be withdrawn: it is reported as sent.
 const h=gate(),late=new AbortController();const one=io.sendMessage(msg('c',{signal:late.signal}));await tick();late.abort();h.resolve();
 assert.equal((await one).status,'sent');
});
test('the route is re-checked when sending: a rotated Session or revoked access stops delivery',async()=>{
 const {io,sent,routes,gate}=setup({},{parts:t=>t.split('|')});const g=gate();
 const first=io.sendMessage(msg('一')),late=io.sendMessage(msg('旧会话尾巴'));
 await tick();routes.set('peer','s2');g.resolve();
 assert.equal((await first).status,'sent');const r=await late;
 assert.equal(r.status,'not-sent');assert.equal(r.reason,'stale');assert.equal(sent.length,1);
 // Rotation between parts stops the remaining parts.
 routes.set('peer','s1');const h=gate();const split=io.sendMessage(msg('a|b'));await tick();routes.delete('peer');h.resolve();
 const s=await split;assert.equal(s.status,'partial');assert.equal(s.reason,'stale');assert.equal(sent.length,2);
 // No origin, or a model-shaped claim the adapter does not recognise, is refused.
 assert.equal((await io.sendMessage({...msg(),origin:undefined})).reason,'unauthorized');
 routes.set('peer','s1');assert.equal((await io.sendMessage({...msg(),origin:{sessionId:'s-forged',owner:true}})).reason,'stale');
});
test('platform and account scope adapters: equal Conversation ids never share a target',async()=>{
 const io=createAgentIO(),a=fakeAdapter({accountId:'app-a'}),b=fakeAdapter({accountId:'app-b'}),c=fakeAdapter({platform:'other',accountId:'app-a'});
 for(const f of [a,b,c]){f.routes.set('peer','s1');io.registerAdapter(f.adapter);}
 await io.sendMessage(msg('给 A'));await io.sendMessage({...msg('给 B'),target:target('peer','app-b')});await io.sendMessage({...msg('给 other'),target:target('peer','app-a','other')});
 assert.deepEqual([a,b,c].map(f=>f.sent.map(s=>s.text)),[['给 A'],['给 B'],['给 other']]);
 assert.equal((await io.sendMessage({...msg(),target:target('peer','app-c')})).reason,'adapter-unavailable');
 assert.throws(()=>io.registerAdapter(fakeAdapter({accountId:'app-a'}).adapter),/already registered/);
 // Queues are per account too: a blocked account does not delay the other one.
 const g=a.gate();const slow=io.sendMessage(msg('慢'));assert.equal((await io.sendMessage({...msg('快'),target:target('peer','app-b')})).status,'sent');g.resolve();await slow;
});
test('unregistering an adapter stops its queued messages',async()=>{
 const io=createAgentIO(),f=fakeAdapter();f.routes.set('peer','s1');const release=io.registerAdapter(f.adapter);
 const g=f.gate();const first=io.sendMessage(msg('一')),second=io.sendMessage(msg('二'));await tick();release();g.resolve();
 assert.equal((await first).status,'sent');assert.equal((await second).reason,'adapter-unavailable');release();
 io.registerAdapter(fakeAdapter().adapter);// the slot is free again
});
test('requests are validated before queueing; unsupported content is refused, not dropped',async()=>{
 const {io,sent}=setup();
 const cases=[[{...msg(),message:{text:'图',attachments:[]}},'unsupported'],[{...msg(),message:{text:'引',replyTo:{id:'x'}}},'unsupported'],[msg('   '),'invalid-message'],
  [{...msg(),target:{platform:'fake',accountId:'app-a',conversation:{type:'channel',id:'peer'}}},'invalid-target'],[{...msg(),target:{platform:'fake',conversation:{type:'direct',id:'peer'}}},'invalid-target'],
  [msg('x'.repeat(11)),'too-large'],[undefined,'invalid-target']];
 const small=createAgentIO({maxTextLength:10});const f=fakeAdapter();f.routes.set('peer','s1');small.registerAdapter(f.adapter);
 for(const [request,reason] of cases){const r=await (reason==='too-large'?small:io).sendMessage(request);assert.equal(r.status,'not-sent');assert.equal(r.reason,reason);}
 assert.equal(sent.length+f.sent.length,0);
});
test('queues are bounded per Conversation and overall',async()=>{
 const {io,routes,gate}=setup({maxPendingPerConversation:2,maxPending:3});routes.set('p2','s1');routes.set('p3','s1');const g=gate(),h=gate();
 const a=io.sendMessage(msg('1')),b=io.sendMessage(msg('2'));
 assert.equal((await io.sendMessage(msg('3'))).reason,'queue-full');
 const c=io.sendMessage({...msg('4'),target:target('p2')});
 assert.equal((await io.sendMessage({...msg('5'),target:target('p3')})).reason,'queue-full');
 g.resolve();h.resolve();await Promise.all([a,b,c]);
 assert.equal((await io.sendMessage(msg('6'))).status,'sent','capacity is returned after sending');
});
test('close stops queued messages, lets the in-flight part finish and refuses new work',async()=>{
 const {io,sent,gate}=setup({},{parts:t=>t.split('|')});const g=gate();
 const inflight=io.sendMessage(msg('a|b')),queued=io.sendMessage(msg('c'));await tick();
 const closing=io.close();g.resolve();await closing;
 const r=await inflight;assert.equal(r.status,'partial');assert.equal(r.reason,'closed');assert.equal((await queued).reason,'closed');
 assert.equal((await io.sendMessage(msg('d'))).reason,'closed');assert.throws(()=>io.registerAdapter(fakeAdapter().adapter),/closed/);assert.equal(sent.length,1);
});
test('send events carry only enums and counts, never text, ids or targets',async()=>{
 const events=[];const {io,gate}=setup({onEvent:e=>events.push(e)});gate(Error('x')).resolve();
 await io.sendMessage(msg('秘密正文',{id:'bubble-secret'}));await io.sendMessage({...msg('x'),message:{text:'y',attachments:[]}});
 for(const e of events){assert.deepEqual(Object.keys(e).sort(),['elapsedMs','event','parts','platform','reason','status']);assert(!JSON.stringify(e).match(/秘密|bubble-secret|peer|app-a|s1/));}
 assert.deepEqual(events.map(e=>e.status),['unknown','not-sent']);
});
test('the Host plugin provides one frozen agentIO service and closes it with the context',async()=>{
 let service,cleanup;plugin.apply({provide:(name,value)=>{assert.equal(name,'agentIO');service=value;},effect:f=>{cleanup=f();},logger:{debug(){}}},{maxConcurrent:1});
 assert(Object.isFrozen(service));assert.deepEqual(Object.keys(service).sort(),['registerAdapter','sendMessage']);
 const f=fakeAdapter();f.routes.set('peer','s1');service.registerAdapter(f.adapter);assert.equal((await service.sendMessage(msg())).status,'sent');
 await cleanup();assert.equal((await service.sendMessage(msg())).reason,'closed');
 assert.deepEqual(plugin.inject,[]);assert.equal(plugin.name,'agent-io');
});
