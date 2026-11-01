// Execute the actual bridge/middleware bodies with fake SDK transports. These
// tests prove adapter wiring, not QQ network delivery or SDK internals.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {createConversations} from '../plugin-sources/dsh-agent-io/conversation.mjs';
import {createTurnControls} from './qq-conversation-fixture.mjs';
const base=new URL('./qqbot-src/dist/gateway/',import.meta.url);
// The shared Conversation wiring as the agent-io plugin builds it, with a stand-in native message.
const wiring=(io,manager,interactionPolicy,extra={})=>createConversations(io,{createInput:m=>({id:'native-'+Math.random().toString(36).slice(2),...m}),interactionPolicy})({platform:'qq-official',adapter:'qq-official-gateway',accountId:extra.accountId??'app',manager,scopes:{direct:'c2c',group:'group'},admits:()=>true,...extra});
function outbound(policy,streaming=true,diagnostics){
 const source=fs.readFileSync(new URL('bootstrap.js',base),'utf8').replaceAll('\r\n','\n');
 const start=source.indexOf('    const policyFor ='),end=source.indexOf('    return outboundHandler;',start);assert(start>=0&&end>start);
 const body=source.slice(start,end);
 assert(body.includes('const outboundHandler'));assert(!body.includes('bootstrapGateway'));
 const sent=[],legacy=[],delivered=[],record={sessionKey:'fixture',sessionId:'fixture',agent:{},replyTarget:{scope:'c2c',targetId:'owner',msgId:'m1'},scope:'c2c',peerId:'owner'};
 const manager={getOrCreate:async()=>record,getSessionRecord:()=>record,isCurrentSession:r=>r===record,findBySessionId:()=>record,hitl:{open:new Set(),waiting(r){return this.open.has(r);}}};
 const sender={sendMarkdown:async(t,s)=>sent.push([t,s])};
 const io={sendMessage:async request=>{delivered.push(request);return {status:'sent',parts:[]};}};
 const conversation=wiring(io,manager,a=>{assert.equal(a,record.agent);return policy;});
 const handler=vm.runInNewContext('(function(){'+body+';return outboundHandler;})()',{
  ctx:{get:()=>{throw Error('the policy comes from the shared Conversation wiring');}},manager,sender,config:{streaming,appId:'app'},logger:{},toolsRegistry:undefined,diagnostics,io,conversation,
  AbortController,AbortSignal,createTurnControls,randomUUID:()=>'0123abcd-0000-4000-8000-000000000000',
  createOutboundHandler:(_m,s)=>async(session,event)=>{legacy.push(event.type);if(event.type==='tool/result')await s.deliverText(record,'tool error','sendToolResult');}
 });
 return {handler,sent,legacy,delivered,record,manager,io,session:{header:{id:'fixture'}}};
}
test('QQ bridge absent policy keeps the original router, whose static text goes to the Unified I/O',async()=>{
 const f=outbound();await f.handler(f.session,{type:'assistant/message'});await f.handler(f.session,{type:'tool/result'});assert.deepEqual(f.legacy,['assistant/message','tool/result']);
 assert.equal(f.sent.length,0,'no direct sendMarkdown');assert.equal(f.delivered.length,1);
 const {signal,...request}=f.delivered[0];
 assert.deepEqual(JSON.parse(JSON.stringify(request)),{target:{platform:'qq-official',adapter:'qq-official-gateway',accountId:'app',conversation:{type:'direct',id:'owner'}},origin:{sessionId:'fixture'},message:{text:'tool error'}});
 assert.equal(signal?.aborted,false,'output without a Turn still carries the Session controller, so /stop reaches it');
});
test('QQ bridge delegates policy output once, keeps tool errors on ordered external channel',async()=>{
 const events=[],external=[],p={bind(t){this.transport=t;},event:e=>events.push(e.type),external:async(t,m)=>external.push([t,m])};
 const f=outbound(p);for(const type of ['turn/start','assistant/chunk','assistant/message','tool/result','turn/end'])await f.handler(f.session,{type});
 assert.deepEqual(events,['turn/start','assistant/chunk','assistant/message','tool/result','turn/end']);assert.deepEqual(f.legacy,['turn/start','tool/result','turn/end']);assert.deepEqual(external.map(e=>e[0]),['tool error']);assert.equal(external[0][1].kind,'tool-or-error');
 assert.equal(f.sent.length,0);assert.equal(f.delivered.length,0);assert.equal(p.transport.openStream,undefined,'the bridge offers no stream');
 f.manager.hitl.open.add(f.record);assert(p.transport.waitingForUser());f.manager.hitl.open.clear();assert(!p.transport.waitingForUser());
});
test('with streaming on or off, a policy bubble is one Unified I/O request and never a direct send',async()=>{
 for(const streaming of [true,false]){
  const p={bind(t){this.transport=t;},event(){}};const f=outbound(p,streaming);f.handler(f.session,{type:'turn/start'});assert.equal(p.transport.openStream,undefined);
  await p.transport.sendText('test',{kind:'assistant',reply:1,bubble:1});assert.equal(f.sent.length,0);assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].message.text,'test');
 }
});

test('native Host context does not stop QQ output, and cannot clear background suppression',()=>{
 const events=[],p={bind(t){this.transport=t;},admitInput(){},event:e=>events.push(e.type),stopOutput(){this.stops=(this.stops??0)+1;}};
 const f=outbound(p);f.manager.trackInteractionInput(f.record,{id:'qq',source:{kind:'user'}});
 const context=kind=>f.handler(f.session,{type:'user/message',data:{message:{source:{kind}}}});
 for(const kind of ['agent-instructions','runtime-context','skill-catalog','time-context'])context(kind);
 f.handler(f.session,{type:'assistant/message'});assert.equal(p.stops??0,0);assert.equal(events.at(-1),'assistant/message');
 for(const kind of ['web','schedule','unknown']){
  context(kind);const before=events.length;context('time-context');context('agent-instructions');
  f.handler(f.session,{type:'assistant/message'});assert.equal(events.length,before);assert.equal(f.record.interactionSuppressed,true);
  f.manager.trackInteractionInput(f.record,{id:'next-qq',source:{kind:'user'}});
 }
});
function middleware(enabled=true){
 const source=fs.readFileSync(new URL('middleware-setup.js',base),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function ','function ');
 const chain=[],events=[],agent={status:'running'},policy={revise:m=>events.push(['revise',m]),stopOutput:()=>events.push(['stop-output'])};
 const record={agent,scope:'c2c',peerId:'owner'},manager={getOrCreate:async()=>record,getSessionRecord:()=>record,isCurrentSession:r=>r===record};
 // enabled==='throw': a reloading policy service that cannot resolve this Agent.
 const conversation=wiring(createAgentIO(),manager,()=>{if(enabled==='throw')throw Error('Agent outside Interaction scope');return enabled?policy:undefined;});
 conversation.openInbound(()=>({status:'accepted'}));
 // The real command gate and Agent I/O command router; only the commands are stand-ins.
 const sandbox={buildCommandList:()=>[{name:'stop',handler:()=>events.push(['native-stop'])}],
  cacheMsgId(){},
  concurrencyGuard:()=>async(_c,next)=>{events.push(['merge']);await next();},getHistoryStore(){},historyGroupKey(){},
  accessPolicy:()=>async(c,next)=>{if(c.message.senderId==='owner')await next();else events.push(['blocked']);}
 };
 for(const name of ['errorHandler','messageFilter','mentionGate','contentSanitizer','rateLimiter','typingIndicator','quoteRef','historyBuffer','envelopeFormatter','attachmentProcessor'])sandbox[name]=()=>async(_c,next)=>next();
 const setup=vm.runInNewContext(source+';setupMiddlewares;',sandbox);
 setup({use:f=>chain.push(f)},{access:{c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'disabled',groupAllow:[]}},manager,{},conversation,{cacheMsgId(){}});
 let seq=0;
 const run=async(content,extra={})=>{const c={message:{content,kind:'c2c',senderId:'owner',messageId:'m'+(++seq),...extra.message},replyTarget:{scope:'c2c',targetId:'owner',msgId:'m'+seq},state:{},bot:{sendText:async()=>{}},stop(){this.stopped=true;},...extra};let i=0;const next=async()=>{if(i<chain.length)await chain[i++](c,next);else events.push(['inbound']);};await next();};
 return {run,events,agent,manager,record};
}
test('explicit correction passes access and question guards but avoids merge and double followup',async()=>{
 const f=middleware();await f.run('更正：保留原文件');assert.deepEqual(f.events.map(e=>e[0]),['revise']);assert.equal(f.events[0][1].source.kind,'user');
 const denied=middleware();await denied.run('',{message:{kind:'c2c',senderId:'other',content:'更正：别执行'}});assert.deepEqual(denied.events.map(e=>e[0]),['blocked']);
 // An open question takes the owner's text first (the real HITL text gate; the Bridge is a stand-in here).
 const pending=middleware();pending.manager.hitl={answer:input=>{pending.events.push(['answer',input.message.text]);return {status:'answered'};}};
 await pending.run('更正：答案');assert.deepEqual(pending.events,[['answer','更正：答案']]);
});
test('ordinary ambiguous messages and disabled policy preserve merge; stop invokes native cancel path once',async()=>{
 for(const text of ['等等看','不对吧','请总结“更正：文本”']){const f=middleware();await f.run(text);assert.deepEqual(f.events.map(e=>e[0]),['merge','inbound']);}
 const off=middleware(false);await off.run('更正：保留文件');assert.deepEqual(off.events.map(e=>e[0]),['merge','inbound']);
 const f=middleware();await f.run('/stop');assert.deepEqual(f.events.map(e=>e[0]),['stop-output','native-stop']);
});
test('trusted correction admission must succeed and return the same record before revise',async()=>{
 const f=middleware();f.manager.admitInteractionInput=async c=>{f.events.push(['trusted',c.message.content]);return f.record;};
 await f.run('更正：保留原文件');assert.deepEqual(f.events.map(e=>e[0]),['trusted','revise']);
 for(const changed of [false,true]){
  const denied=middleware();denied.manager.admitInteractionInput=async()=>{if(changed)return {agent:denied.agent};throw Error('Owner ingress required');};
  await assert.rejects(denied.run('更正：保留原文件'),changed?/Session changed/:/Owner ingress/);assert.equal(denied.events.length,0);
 }
});

test('QQ bridge delegates non-user sources to the policy and traces suppression by enum',()=>{
 const traces=[],diagnostics={hash:v=>v===undefined?undefined:'b'.repeat(24),trace:(e,f)=>traces.push([e,f])};
 const events=[],known=new Set(['child-1']),p={bind(t){this.transport=t;},admitInput(){},event:e=>events.push(e.type),stopOutput(){this.stops=(this.stops??0)+1;},admitsSource:m=>known.has(m?.source?.senderSessionId)};
 const f=outbound(p,true,diagnostics);f.manager.trackInteractionInput(f.record,{id:'qq',source:{kind:'user'}});
 const settled=id=>f.handler(f.session,{type:'user/message',data:{message:{source:{kind:'subagent-settled',senderSessionId:id}}}});
 settled('child-1');f.handler(f.session,{type:'assistant/message'});
 assert.equal(f.record.interactionSuppressed,false);assert.equal(p.stops??0,0);assert.equal(events.at(-1),'assistant/message');
 settled('forged');const before=events.length;f.handler(f.session,{type:'assistant/message'});
 assert.equal(f.record.interactionSuppressed,true);assert.equal(p.stops,1);assert.equal(events.length,before);
 assert.deepEqual(traces.filter(([e])=>e==='suppressed').map(([,x])=>x.source),['subagent-settled']);
 // A recognized continuation lifts an earlier background suppression for its own turn.
 settled('child-1');assert.equal(f.record.interactionSuppressed,false);
 // Without admitsSource the original conservative suppression is kept.
 const q={bind(t){this.transport=t;},admitInput(){},event(){},stopOutput(){}},g=outbound(q);g.manager.trackInteractionInput(g.record,{id:'qq'});
 g.handler(g.session,{type:'user/message',data:{message:{source:{kind:'subagent-settled',senderSessionId:'child-1'}}}});assert.equal(g.record.interactionSuppressed,true);
});
test('QQ bridge sends each reply to the target of its own input id',async()=>{
 const p={bind(t){this.transport=t;},admitInput(){},event(){}};const f=outbound(p,false);
 f.manager.trackInteractionInput(f.record,{id:'input-1',source:{kind:'user'}});
 f.record.replyTarget={scope:'c2c',targetId:'owner',msgId:'m2'};f.manager.trackInteractionInput(f.record,{id:'input-2',source:{kind:'user'}});
 f.handler(f.session,{type:'turn/start'});
 // The fake I/O resolves the adapter's reply target the way the gateway's QQ text adapter does.
 const targets=[];f.io.sendMessage=async r=>{targets.push([r.message.text,f.handler.delivery(r.id)?.target?.msgId??f.record.replyTarget.msgId]);return {status:'sent',parts:[]};};
 let n=0;const meta=input=>({kind:'assistant',reply:1,bubble:++n,...(input?{input}:{})});
 await p.transport.sendText('旧任务尾部',meta('input-1'));await p.transport.sendText('新回复',meta('input-2'));await p.transport.sendText('无归属',meta());await p.transport.sendText('未知',meta('other'));
 assert.deepEqual(targets,[['旧任务尾部','m1'],['新回复','m2'],['无归属','m2'],['未知','m2']]);assert.equal(f.sent.length,0);assert.equal(f.handler.delivery('anything'),undefined,'nothing kept after the hand-over');
 for(let i=0;i<120;i++)f.manager.trackInteractionInput(f.record,{id:'bulk-'+i});assert.equal(f.record.interactionTargets.size,100);assert(!f.record.interactionTargets.has('input-1'));
});
function inbound(policy,status='running'){
 const source=fs.readFileSync(new URL('../transport/inbound.js',base),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export (?=(?:async )?function)/gm,'');
 const events=[],timers=[];let idle;const whenIdle=new Promise(r=>idle=r);
 const agent={status,followup:m=>events.push(['followup',m.source.kind]),whenIdle:()=>{events.push(['wait']);return whenIdle;}};
 const record={agent,scope:'c2c',peerId:'owner',replyTarget:{scope:'c2c',targetId:'owner',msgId:'m1'}};
 const manager={getOrCreate:async()=>record,getSessionRecord:()=>record,isCurrentSession:r=>r===record};
 const io=createAgentIO(),conversation=wiring(io,manager,()=>policy,{accountId:'a',onInput:(_r,m)=>events.push(['register',m.source.kind])});
 const {handleInbound:handle,deliverInbound}=vm.runInNewContext('(function(){'+source+';return {handleInbound,deliverInbound};})()',{
  QQ_SCOPES:{direct:'c2c',group:'group'},classifyContentType:()=>'file',isVoiceContentType:()=>false,clearGroupHistory(){},
  setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearInterval:id=>{timers[id-1].cleared=true;},
 });
 const bot={sendTyping:async(target,sec)=>events.push(['typing',target.msgId,sec]),sendMarkdown:async()=>{}};
 const config={appId:'a'},logger={info(){},warn(){},error(){},debug(){}};
 // The real inbound path: Unified Agent I/O channel -> trusted QQ Conversation entry.
 const channel=conversation.openInbound(s=>deliverInbound(s,conversation,config,logger));
 const run=()=>handle({message:{kind:'c2c',senderId:'owner',messageId:'m2',content:'你好',attachments:[]},state:{},bot},logger,channel);
 return {run,events,timers,record,idle};
}
test('with Interaction, input during a run goes to intervene and the guard is released at once',async()=>{
 const calls=[],policy={intervene:m=>calls.push(m.source.kind)};
 const f=inbound(policy,'running');await f.run();
 // run() resolved although the Agent never became idle; the only whenIdle use is the typing keepalive's release.
 assert.deepEqual(calls,['user']);assert.deepEqual(f.events.map(e=>e[0]),['register','wait']);assert.equal(f.timers.length,1,'typing kept alive until idle');
 assert.equal(f.timers[0].ms,50000);await f.timers[0].fn();assert.deepEqual(f.events.at(-1),['typing','m2',60]);
 f.idle();await new Promise(r=>setImmediate(r));assert(f.timers[0].cleared);assert.equal(f.record.typingKeepAlive,undefined);
 const g=inbound(policy,'idle');await g.run();assert.deepEqual(g.events.map(e=>e[0]),['register','followup','wait']);assert.equal(calls.length,1,'idle Agent gets a plain followup');assert.equal(g.timers.length,1);
 // Without an intervene-capable policy the original blocking path is unchanged.
 const h=inbound(undefined,'idle');const done=h.run();await new Promise(r=>setImmediate(r));assert.deepEqual(h.events.map(e=>e[0]),['register','followup','wait']);h.idle();await done;assert.equal(h.timers.length,0);
});
