// Iteration 07 Notification on the QQTK side: the Agent I/O notifier
// (conversation.openNotifications) behind the reviewed Gateway Conversation
// wiring and QQ text adapter, and Remote Ops' ledger with exactly one sender per
// event. Fake QQ API and fake Agents; nothing connects to QQ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {apply} from '../plugin-sources/dsh-remote-ops/index.js';
import {qqAdapter,qqConversation} from './qq-conversation-fixture.mjs';

const tick=async(n=10)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const plain=v=>JSON.parse(JSON.stringify(v));
class ApiError extends Error{name='ApiError';constructor(s){super('API');this.httpStatus=s;}}

function gateway({send,split=t=>[t],access={c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'disabled',groupAllow:[]},io=createAgentIO(),appId='app'}={}){
 const sessions=new Map(),sent=[];
 const manager={getOrCreate:async()=>{throw Error('unused');},getSessionRecord:(s,p)=>sessions.get(s+':'+p),isCurrentSession:r=>sessions.get(r.scope+':'+r.peerId)===r};
 const config={appId,access};
 const conversation=qqConversation({io,manager,config});
 conversation.registerAdapter(qqAdapter.createQQTextAdapter({split,limit:4500,send:async(target,text,info)=>{const m={target:plain(target),text,notification:!!info.notification};sent.push(m);return send?send(m,sent.length):{id:'r'+sent.length};}}));
 const record=(peer,id)=>{const r={scope:'c2c',peerId:peer,sessionId:id,senderId:peer,replyTarget:{scope:'c2c',targetId:peer,msgId:'in-'+id},agent:{}};sessions.set('c2c:'+peer,r);return r;};
 return {io,conversation,manager,config,sent,record,notifier:conversation.openNotifications()};
}
const owner={type:'direct',id:'owner'};

test('a notification reaches its stable Conversation without a current Session; a chat reply of a rotated Session stays refused',async()=>{
 const g=gateway(),old=g.record('owner','s-old');g.record('owner','s-new');
 const chat=await g.io.sendMessage({target:g.conversation.target(old),origin:{sessionId:'s-old'},message:{text:'旧会话的聊天回复'}});
 assert.deepEqual([chat.status,chat.reason],['not-sent','stale'],'chat keeps the current-Session check');
 const seen=[];
 const r=await g.notifier.send({id:'n1',conversation:owner,text:'[提醒到期]\n喝水',authorize:target=>{seen.push(plain(target));return true;}});
 assert.equal(r.status,'sent');assert.deepEqual(seen,[{type:'direct',id:'owner'}],'the authority checks the exact target');
 assert.deepEqual(g.sent.map(m=>[m.text,m.target,m.notification]),[['[提醒到期]\n喝水',{scope:'c2c',targetId:'owner'},true]],'stable target, no reply id of an old input');
 const again=await g.notifier.send({id:'n1',conversation:owner,text:'[提醒到期]\n喝水',authorize:()=>true});
 assert.equal(again.duplicate,true);assert.equal(g.sent.length,1,'the same id is not sent twice');
});
test('only an issued grant opens the notification route; authority, admission, account and closing are checked before every part',async()=>{
 const g=gateway({split:t=>t.split('|')});
 const forged=await g.io.sendMessage({target:{platform:'qq-official',accountId:'app',conversation:owner},origin:{notification:{authorize:()=>true,closed:()=>false}},message:{text:'伪造'}});
 assert.deepEqual([forged.status,forged.reason],['not-sent','unauthorized'],'a self-made grant is not a notification');
 assert.equal((await g.notifier.send({id:'a1',conversation:owner,text:'x',authorize:()=>false})).reason,'unauthorized');
 assert.equal((await g.notifier.send({id:'a2',conversation:owner,text:'x',authorize:()=>{throw Error('boom');}})).reason,'unauthorized');
 assert.equal((await g.notifier.send({id:'a3',conversation:{type:'direct',id:'stranger'},text:'x',authorize:()=>true})).reason,'unauthorized','the Gateway admission still applies');
 assert.equal((await g.notifier.send({id:'a4',conversation:{type:'channel',id:'owner'},text:'x',authorize:()=>true})).reason,'invalid-target');
 assert.equal((await g.notifier.send({id:'a5',conversation:owner,text:'x'})).reason,'invalid-message','no authority, no send');
 let allowed=true;const parts=await g.notifier.send({id:'a6',conversation:owner,text:'一|二|三',authorize:()=>{const ok=allowed;allowed=false;return ok;}});
 assert.equal(parts.status,'partial');assert.deepEqual(parts.parts.map(p=>p.status),['sent','skipped','skipped'],'revoked between parts: the rest is not sent');
 g.notifier.close();assert.equal((await g.notifier.send({id:'a7',conversation:owner,text:'x',authorize:()=>true})).reason,'closed');
 assert.deepEqual(g.sent.map(m=>m.text),['一']);
});
test('notifications share the Conversation queue with chat: FIFO order, bounded queue, cancellation, honest platform outcomes',async()=>{
 let release;const gate=new Promise(r=>{release=r;});
 const results={timeout:()=>{throw new ApiError(0);},server:()=>{throw new ApiError(502);},refused:()=>{throw new ApiError(403);}};
 const g=gateway({send:m=>m.text==='chat-1'?gate.then(()=>({id:'c'})):results[m.text]?results[m.text]():{id:'ok'},io:createAgentIO({maxPendingPerConversation:3})});
 const current=g.record('owner','s1');
 const chat1=g.io.sendMessage({target:g.conversation.target(current),origin:{sessionId:'s1'},message:{text:'chat-1'}});
 const n1=g.notifier.send({id:'q1',conversation:owner,text:'notice-1',authorize:()=>true});
 const chat2=g.io.sendMessage({target:g.conversation.target(current),origin:{sessionId:'s1'},message:{text:'chat-2'}});
 const full=await g.notifier.send({id:'q2',conversation:owner,text:'notice-2',authorize:()=>true});
 assert.deepEqual([full.status,full.reason,full.stage],['not-sent','queue-full','before-platform'],'a full queue refuses before the platform');
 const stop=new AbortController();const cancelled=g.notifier.send({id:'q3',conversation:owner,text:'notice-3',authorize:()=>true,signal:stop.signal});
 stop.abort();release();await Promise.all([chat1,n1,chat2]);
 assert.deepEqual((await cancelled).reason,'queue-full');
 assert.deepEqual(g.sent.map(m=>m.text),['chat-1','notice-1','chat-2'],'one physical order per Conversation');
 const s=createAgentIO(),h=gateway({io:s,send:m=>results[m.text]?results[m.text]():{id:'ok'}});
 const timeout=await h.notifier.send({id:'t',conversation:owner,text:'timeout',authorize:()=>true});
 const server=await h.notifier.send({id:'s',conversation:owner,text:'server',authorize:()=>true});
 const refused=await h.notifier.send({id:'r',conversation:owner,text:'refused',authorize:()=>true});
 assert.deepEqual([timeout.status,server.status,refused.status,refused.stage],['unknown','unknown','not-sent','platform']);
 const stop2=new AbortController();stop2.abort();
 assert.equal((await h.notifier.send({id:'x',conversation:owner,text:'x',authorize:()=>true,signal:stop2.signal})).reason,'cancelled');
});
test('the Gateway opens one notifier for its notification authorities only; notifications.enabled:false opens none',()=>{
 const read=f=>fs.readFileSync(new URL('./qqbot-src/dist/'+f,import.meta.url),'utf8');
 const bootstrap=read('gateway/bootstrap.js');
 assert.match(bootstrap,/const notifications = config\.notifications\?\.enabled === false \? undefined : conversation\.openNotifications\(\);/);
 assert.match(bootstrap,/qqRemoteOps'\)\?\.attach\(\{ bot, manager, sender, config, \.\.\.\(notifications \? \{ notifications \} : \{\}\) \}\)/);
 assert.match(bootstrap,/ctx\.provide\('qqGateway', Object\.freeze\(\{ bot, manager, sender \}\)\)/,'the general Gateway service does not hand out the notifier');
 const ops=fs.readFileSync(new URL('../plugin-sources/dsh-remote-ops/index.js',import.meta.url),'utf8');
 assert(!/sender\.sendMarkdown/.test(ops),'Remote Ops has no direct Gateway send');
});

// ── Remote Ops ledger ──
function remoteOps(t,{features={notifications:{enabled:true}}}={}){
 const root=fs.mkdtempSync(path.resolve('tmp/remote-notify-')),state=path.join(root,'data/maintenance');
 fs.mkdirSync(path.join(root,'maintenance'));fs.mkdirSync(path.join(state,'jobs'),{recursive:true});
 fs.writeFileSync(path.join(state,'owner.json'),JSON.stringify({openid:'owner'}));
 fs.writeFileSync(path.join(root,'maintenance/remote.cjs'),`module.exports={setFeature(){},tasks(){},jobs(){},queue(){},features:()=>(${JSON.stringify({remoteOps:{enabled:true,notifyAfterSeconds:120,staleAfterSeconds:300,maxTurnSeconds:1800},...features})}),stop:async()=>{}};`);
 fs.writeFileSync(path.join(root,'maintenance/ops.cjs'),`module.exports={atomic:(file,value)=>require('fs').writeFileSync(file,value)};`);
 let tick,service;const cleanup=[];
 t.mock.method(globalThis,'setInterval',f=>{tick=f;return 1;});t.mock.method(globalThis,'clearInterval',()=>{});
 apply({agents:{get:()=>undefined},on(){},provide:(_,v)=>service=v,effect:f=>cleanup.push(f())},{root});
 t.after(()=>cleanup.forEach(f=>f()));
 const job=(name,ok=true)=>fs.writeFileSync(path.join(state,'jobs',name+'.result.json'),JSON.stringify({action:'Backup',ok,finishedAt:new Date(Date.now()+1000).toISOString()}));
 const ledger=()=>JSON.parse(fs.readFileSync(path.join(state,'qq-notifications.json'),'utf8')).deliveries;
 const poll=async()=>{tick();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
 return {root,state,service:()=>service,job,ledger,poll,reload:({overlap=false}={})=>{if(!overlap){cleanup.forEach(f=>f());cleanup.length=0;}apply({agents:{get:()=>undefined},on(){},provide:(_,v)=>service=v,effect:f=>cleanup.push(f())},{root});}};
}
const runtimeOf=extra=>({config:{access:{c2cMode:'allowlist',c2cAllow:['owner']}},bot:{on(){},off(){}},manager:{getOrCreate:async()=>{},findBySessionId:()=>undefined},sender:{sendMarkdown:async()=>{throw Error('no direct Gateway send');}},...extra});
function stubNotifier(result){const n={calls:[],async send(r){n.calls.push(r);if(r.authorize({type:r.conversation.type,id:r.conversation.id})!==true)return {status:'not-sent',reason:'unauthorized'};return typeof result==='function'?result(r):result;}};return n;}

test('standalone Remote Ops: the notifier sends each key once, records the I/O outcome and never replays unknown or an interrupted send',async t=>{
 const r=remoteOps(t),n=stubNotifier({status:'unknown',reason:'timeout-or-network'});
 r.service().attach(runtimeOf({notifications:n}));
 r.job('job-1');await r.poll();await r.poll();
 assert.equal(n.calls.length,1);assert.equal(n.calls[0].id,'qqtk:job:job-1.result.json');assert.deepEqual(n.calls[0].conversation,{type:'direct',id:'owner'});
 assert.deepEqual(r.ledger()['job:job-1.result.json'].status,'unknown');
 // A send interrupted by a crash is left 'sending' in the ledger: never replayed after restart.
 const file=path.join(r.state,'qq-notifications.json'),l=JSON.parse(fs.readFileSync(file,'utf8'));l.deliveries['job:job-2.result.json']={status:'sending',at:Date.now()};fs.writeFileSync(file,JSON.stringify(l));
 r.job('job-2');r.reload();const m=stubNotifier({status:'sent'});r.service().attach(runtimeOf({notifications:m}));await r.poll();
 assert.equal(m.calls.length,0);assert.equal(r.ledger()['job:job-2.result.json'].status,'sending');
 r.job('job-3',false);await r.poll();await r.poll();assert.equal(m.calls.length,1);assert.equal(r.ledger()['job:job-3.result.json'].status,'sent');
});
test('Remote Ops ledger write failure before the send sends nothing; without a notifier nothing is sent directly',async t=>{
 const r=remoteOps(t),n=stubNotifier({status:'sent'});r.service().attach(runtimeOf({notifications:n}));
 // The ledger cannot be written (a directory blocks the atomic temp file): the key is not durable, so nothing is sent.
 const blocker=path.join(r.state,'qq-notifications.json.'+process.pid+'.tmp');fs.mkdirSync(blocker);r.job('job-1');await r.poll();fs.rmdirSync(blocker);
 assert.equal(n.calls.length,0,'not persisted, not sent');
 await r.poll();await r.poll();assert.equal(n.calls.length,1,'failed claim must not strand an in-memory sending entry');
 assert.equal(r.ledger()['job:job-1.result.json'].status,'sent');r.reload();r.service().attach(runtimeOf({notifications:n}));await r.poll();assert.equal(n.calls.length,1);
 const s=remoteOps(t);s.service().attach(runtimeOf({}));s.job('job-9');await s.poll();
 assert.deepEqual(s.ledger()['job:job-9.result.json'],{...s.ledger()['job:job-9.result.json'],status:'not-sent',reason:'notifications-unavailable'});
});

test('Remote Ops HMR cannot let a late old result overwrite newer durable keys and cause a replay',async t=>{
 const r=remoteOps(t);let finish;const gate=new Promise(resolve=>{finish=resolve;});
 const old=stubNotifier(()=>gate);r.service().attach(runtimeOf({notifications:old}));r.job('old');await r.poll();assert.equal(old.calls.length,1);
 r.reload({overlap:true});assert.equal(old.calls[0].authorize(owner),false,'a replaced instance cannot authorize queued parts, even before its cleanup');
 const fresh=stubNotifier({status:'sent'});r.service().attach(runtimeOf({notifications:fresh}));r.job('new');await r.poll();assert.equal(fresh.calls.length,1);
 finish({status:'sent'});await tick();
 assert.equal(r.ledger()['job:new.result.json']?.status,'sent','stale instance must never replace the new ledger snapshot');
 r.reload();r.service().attach(runtimeOf({notifications:fresh}));await r.poll();assert.equal(fresh.calls.length,1,'neither durable sending nor a newer sent entry replays');
});

test('Remote Ops terminal write failure keeps a durable sending fence across ticks and HMR',async t=>{
 const r=remoteOps(t);let finish;const gate=new Promise(resolve=>{finish=resolve;});const n=stubNotifier(()=>gate);
 r.service().attach(runtimeOf({notifications:n}));r.job('terminal');await r.poll();
 const blocker=path.join(r.state,'qq-notifications.json.'+process.pid+'.tmp');fs.mkdirSync(blocker);finish({status:'sent'});await tick();fs.rmdirSync(blocker);
 assert.equal(r.ledger()['job:terminal.result.json'].status,'sending');await r.poll();assert.equal(n.calls.length,1);
 r.reload();r.service().attach(runtimeOf({notifications:n}));await r.poll();assert.equal(n.calls.length,1,'unknown completion is never retried');
});

test('Remote Ops reconciles an ambiguous atomic-write error from disk without erasing a durable claim',async t=>{
 const r=remoteOps(t),n=stubNotifier({status:'sent'});r.service().attach(runtimeOf({notifications:n}));
 const file=path.join(r.state,'qq-notifications.json'),rename=fs.renameSync;let fail=true;
 t.mock.method(fs,'renameSync',(from,to)=>{rename(from,to);if(to===file&&fail){fail=false;throw Error('synthetic post-rename error');}});
 r.job('ambiguous-claim');await r.poll();assert.equal(n.calls.length,0,'a thrown persist never hands over');
 await r.poll();assert.equal(n.calls.length,0,'read back the durable sending fence instead of dropping it');
 r.reload();r.service().attach(runtimeOf({notifications:n}));await r.poll();assert.equal(n.calls.length,0);
 assert.equal(r.ledger()['job:ambiguous-claim.result.json'].status,'sending');
});

test('Remote Ops can attach after the very first ledger write fails; no half-attached runtime or phantom claim',async t=>{
 const r=remoteOps(t),n=stubNotifier({status:'sent'}),runtime=runtimeOf({notifications:n});
 const blocker=path.join(r.state,'qq-notifications.json.'+process.pid+'.tmp');fs.mkdirSync(blocker);
 assert.throws(()=>r.service().attach(runtime));r.job('first');await r.poll();assert.equal(n.calls.length,0);
 fs.rmdirSync(blocker);r.service().attach(runtime);await r.poll();await r.poll();assert.equal(n.calls.length,1);
});
test('with Character, the durable Outbox is the only sender: the notifier is not used and the Outbox status is recorded',async t=>{
 const r=remoteOps(t),n=stubNotifier({status:'sent'}),events=[];
 r.service().attach(runtimeOf({notifications:n,notifyEvent:async e=>{events.push(e);if(e.eventId.includes('job-2'))throw Object.assign(Error('Notification delivery pending'),{status:'pending'});return {status:'sent'};}}));
 r.job('job-1');r.job('job-2');await r.poll();await r.poll();
 assert.equal(n.calls.length,0,'no second sender for the same event');
 assert.deepEqual(events.map(e=>[e.eventId,e.kind]),[['qqtk:job:job-1.result.json','maintenance_result'],['qqtk:job:job-2.result.json','maintenance_result']]);
 assert.equal(r.ledger()['job:job-1.result.json'].status,'sent');assert.equal(r.ledger()['job:job-2.result.json'].status,'pending','the Outbox still owns it; not a false failure');
 const off=remoteOps(t,{features:{notifications:{enabled:false}}}),m=stubNotifier({status:'sent'});off.service().attach(runtimeOf({notifications:m}));off.job('job-5');await off.poll();
 assert.equal(m.calls.length,0);assert.equal(off.ledger()['job:job-5.result.json'].status,'suppressed');
});
