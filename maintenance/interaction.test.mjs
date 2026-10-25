// Execute the actual bridge/middleware bodies with fake SDK transports. These
// tests prove adapter wiring, not QQ network delivery or SDK internals.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const base=new URL('./qqbot-src/dist/gateway/',import.meta.url);
function outbound(policy,streaming=true){
 const source=fs.readFileSync(new URL('bootstrap.js',base),'utf8').replaceAll('\r\n','\n');
 const start=source.indexOf('    const policyFor ='),end=source.indexOf('    return outboundHandler;',start);assert(start>=0&&end>start);
 const body=source.slice(start,end);
 assert(body.includes('const outboundHandler'));assert(!body.includes('bootstrapGateway'));
 const sent=[],legacy=[],record={sessionKey:'fixture',agent:{},replyTarget:{scope:'c2c',targetId:'owner',msgId:'m1'}};
 const manager={getSessionRecord:()=>record,findBySessionId:()=>record,approvalChannel:{pending:new Map()},questionChannel:{pending:new Map()}};
 const sender={sendMarkdown:async(t,s)=>sent.push([t,s]),openStream:()=>({update:async()=>{},complete:async()=>{}})};
 const handler=vm.runInNewContext('(function(){'+body+';return outboundHandler;})()',{
  ctx:{get:()=>({serviceFor:()=>policy?{get:a=>{assert.equal(a,record.agent);return policy;}}:undefined})},manager,sender,config:{streaming},logger:{},toolsRegistry:undefined,
  createOutboundHandler:(_m,s)=>async(session,event)=>{legacy.push(event.type);if(event.type==='tool/result')await s.sendMarkdown(record.replyTarget,'tool error');}
 });
 return {handler,sent,legacy,record,manager,session:{header:{id:'fixture'}}};
}
test('QQ bridge absent policy preserves original outbound path',async()=>{
 const f=outbound();await f.handler(f.session,{type:'assistant/message'});await f.handler(f.session,{type:'tool/result'});assert.deepEqual(f.legacy,['assistant/message','tool/result']);assert.equal(f.sent.length,1);
});
test('QQ bridge delegates policy output once, keeps tool errors on ordered external channel',async()=>{
 const events=[],external=[],p={bind(t){this.transport=t;},event:e=>events.push(e.type),external:async t=>external.push(t)};
 const f=outbound(p);for(const type of ['turn/start','assistant/chunk','assistant/message','tool/result','turn/end'])await f.handler(f.session,{type});
 assert.deepEqual(events,['turn/start','assistant/chunk','assistant/message','tool/result','turn/end']);assert.deepEqual(f.legacy,['turn/start','tool/result','turn/end']);assert.deepEqual(external,['tool error']);assert.equal(f.sent.length,0);assert.equal(typeof p.transport.openStream,'function');
 f.manager.approvalChannel.pending.set('fixture',{});assert(p.transport.waitingForUser());f.manager.approvalChannel.pending.clear();assert(!p.transport.waitingForUser());
});
test('QQ no-stream configuration does not accidentally open a stream',async()=>{
 const p={bind(t){this.transport=t;},event(){}};const f=outbound(p,false);f.handler(f.session,{type:'turn/start'});assert.equal(p.transport.openStream,undefined);await p.transport.sendText('test');assert.equal(f.sent.length,1);
});

test('native Host context does not stop QQ output, and cannot clear background suppression',()=>{
 const events=[],p={bind(t){this.transport=t;},admitInput(){},event:e=>events.push(e.type),stopOutput(){this.stops=(this.stops??0)+1;}};
 const f=outbound(p);f.manager.registerInteractionInput(f.record,{id:'qq',source:{kind:'user'}});
 const context=kind=>f.handler(f.session,{type:'user/message',data:{message:{source:{kind}}}});
 for(const kind of ['agent-instructions','runtime-context','skill-catalog','time-context'])context(kind);
 f.handler(f.session,{type:'assistant/message'});assert.equal(p.stops??0,0);assert.equal(events.at(-1),'assistant/message');
 for(const kind of ['web','schedule','unknown']){
  context(kind);const before=events.length;context('time-context');context('agent-instructions');
  f.handler(f.session,{type:'assistant/message'});assert.equal(events.length,before);assert.equal(f.record.interactionSuppressed,true);
  f.manager.registerInteractionInput(f.record,{id:'next-qq',source:{kind:'user'}});
 }
});
function middleware(enabled=true){
 const source=fs.readFileSync(new URL('middleware-setup.js',base),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export function setupMiddlewares','function setupMiddlewares');
 const chain=[],events=[],agent={status:'running'},policy={revise:m=>events.push(['revise',m]),stopOutput:()=>events.push(['stop-output'])};
 const record={agent},manager={getSessionRecord:()=>record,ctx:{get:n=>n==='agentPresets'?{serviceFor:()=>enabled?{get:()=>policy}:undefined}:undefined}};
 const sandbox={buildCommandList:()=>[{name:'stop',handler:()=>events.push(['native-stop'])}],createUserMessage:m=>m,
  slashCommand:({commands})=>({middleware:async(c,next)=>c.message.content==='/stop'?commands.find(x=>x.name==='stop').handler(c):next()}),
  questionAnswer:()=>async(c,next)=>{if(c.answerPending)events.push(['answer']);else await next();},
  concurrencyGuard:()=>async(_c,next)=>{events.push(['merge']);await next();},getHistoryStore(){},historyGroupKey(){},
  accessPolicy:()=>async(c,next)=>{if(c.message.senderId==='owner')await next();else events.push(['blocked']);}
 };
 for(const name of ['errorHandler','messageFilter','mentionGate','contentSanitizer','rateLimiter','typingIndicator','quoteRef','historyBuffer','envelopeFormatter','attachmentProcessor'])sandbox[name]=()=>async(_c,next)=>next();
 const setup=vm.runInNewContext(source+';setupMiddlewares;',sandbox);
 setup({use:f=>chain.push(f)},{access:{c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'disabled',groupAllow:[]}},manager,{});
 const run=async(content,extra={})=>{const c={message:{content,kind:'c2c',senderId:'owner',...extra.message},...extra};let i=0;const next=async()=>{if(i<chain.length)await chain[i++](c,next);else events.push(['inbound']);};await next();};
 return {run,events,agent,manager,record};
}
test('explicit correction passes access and question guards but avoids merge and double followup',async()=>{
 const f=middleware();await f.run('更正：保留原文件');assert.deepEqual(f.events.map(e=>e[0]),['revise']);assert.equal(f.events[0][1].source.kind,'user');
 const denied=middleware();await denied.run('',{message:{kind:'c2c',senderId:'other',content:'更正：别执行'}});assert.deepEqual(denied.events.map(e=>e[0]),['blocked']);
 const pending=middleware();await pending.run('更正：答案',{answerPending:true});assert.deepEqual(pending.events.map(e=>e[0]),['answer']);
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
