// QQ Official chat outbound through the Unified Agent I/O: plain replies and
// Interaction bubbles alike. Runs the reviewed sources (patched outbound router
// and buffer, gateway sender, Interaction bridge and adapter registration, reply
// target/limiter, QQ text adapter) against a fake QQ bot. Proves wiring and
// semantics, not QQ network delivery or phone receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {qqAdapter as adapterModule,qqConversation,createTurnControls} from './qq-conversation-fixture.mjs';

const dist=new URL('./qqbot-src/dist/',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,dist),'utf8').replaceAll('\r\n','\n');
const strip=source=>source.replace(/^import [^;]*;\n/gm,'').replace(/^export (?=(?:async )?function|class|const)/gm,'');
const load=(file,names,context={})=>vm.runInNewContext(strip(read(file))+`\n;({${names}})`,context);
const slice=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,start);return source.slice(a,b);};
const tick=async(n=5)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};

const {ReplyLimiter}=load('transport/reply-limiter.js','ReplyLimiter');
const {resolveReplyTarget,sendResolvedMarkdown}=load('transport/reply-target.js','resolveReplyTarget,sendResolvedMarkdown',{MsgType:{MARKDOWN:2},getCachedReplyIds:()=>[]});
// Real chunker when a validation profile is present (same resolution as the
// approval tests); otherwise a line-based stand-in.
const profile=process.env.QQBOT_TEST_PROFILE??fileURLToPath(new URL('../data/profiles/qqbot-validation/',import.meta.url));
const chunkerFile=path.join(profile,'node_modules/@tencent-connect/dsh-qqbot/dist/transport/chunker.js');
const realChunker=fs.existsSync(chunkerFile)?vm.runInNewContext(strip(fs.readFileSync(chunkerFile,'utf8').replaceAll('\r\n','\n'))+'\n;chunkMarkdownText'):null;
// The installed native event parser when present, otherwise the same rules.
const eventsFile=path.join(profile,'node_modules/@tencent-connect/dsh-qqbot/dist/transport/events.js');
const realEvents=fs.existsSync(eventsFile)?vm.runInNewContext(strip(fs.readFileSync(eventsFile,'utf8').replaceAll('\r\n','\n'))+'\n;({parseEvent,extractTurnError})'):null;
const parseEvent=realEvents?.parseEvent??(raw=>{const d=raw.data??{};switch(raw.type){
 case 'assistant/chunk':return d.chunk?.type==='text-delta'&&d.chunk.text?{type:raw.type,text:d.chunk.text}:undefined;
 case 'assistant/message':return Array.isArray(d.message?.content)?{type:raw.type,content:d.message.content}:undefined;
 case 'tool/call':return d.callId&&d.name?{type:raw.type,callId:d.callId,name:d.name,arguments:d.arguments??''}:undefined;
 case 'tool/result':return d.message?.source?.callId?{type:raw.type,callId:d.message.source.callId,error:d.error,raw:d}:undefined;
 case 'turn/end':return {type:raw.type,reason:d.reason??{}};}});
const extractTurnError=realEvents?.extractTurnError??(r=>r.kind==='error'?{code:r.error?.code??'UNKNOWN',message:r.error?.message??'unknown error'}:undefined);
const lineChunker=(text,limit)=>{const out=[];let cur='';for(const line of text.split('\n')){const next=cur?cur+'\n'+line:line;if(cur&&next.length>limit){out.push(cur);cur=line;}else cur=next;}if(cur)out.push(cur);return out.length?out:[text];};

class ApiError extends Error{name='ApiError';constructor(status){super('API Error [/v2/users/OPENID/messages]');this.httpStatus=status;this.path='/v2/users/OPENID/messages';}}
function fakeBot(){
 const sent=[],failures=[],gates=[];
 const deliver=async(entry)=>{const gate=gates.shift();if(gate)await gate;sent.push(entry);const failure=failures.shift();if(failure)throw failure;return {id:'qq-'+sent.length};};
 return {sent,failures,gates,streams:[],
  sendMarkdown:(target,content)=>deliver({msgId:target.msgId,eventId:undefined,targetId:target.targetId,content}),
  send:opts=>deliver({msgId:undefined,eventId:opts.extra?.event_id,targetId:opts.target.targetId,content:opts.markdown.content}),
  openStream(){throw Error('QQ chat output never opens an SDK stream');}};
}
function gateway({io=createAgentIO(),appId='app-a',policy,streaming=false,limit=4500,chunker=lineChunker,recorder,access}={}){
 const source=read('gateway/bootstrap.js'),bot=fakeBot(),logs=[],cleanups=[];
 const agents=new Map(),record={sessionKey:'qqbot:'+appId+':c2c:owner',sessionId:'s1',agent:{id:'s1'},replyTarget:{scope:'c2c',targetId:'owner',msgId:'m1'},scope:'c2c',peerId:'owner'};
 agents.set('s1',record.agent);
 const sessions=new Map([['c2c:owner',record]]);
 // The Manager's ownership contract: the record is the mapped one and its live Agent is registered.
 const manager={getOrCreate:async()=>{throw Error('no inbound in these fixtures');},getSessionRecord:(scope,peer)=>sessions.get(scope+':'+peer),findBySessionId:id=>[...sessions.values()].find(r=>r.sessionId===id),
  isCurrentSession:r=>sessions.get((r.scope)+':'+r.peerId)===r&&agents.get(r.sessionId)===r.agent,approvalChannel:{pending:new Map()},questionChannel:{pending:new Map()}};
 const logger={info(){},debug:m=>logs.push(['debug',m]),warn:m=>logs.push(['warn',m]),error:m=>logs.push(['error',m])};
 const config={appId,streaming,textChunkLimit:limit,showToolResults:false,access:access??{c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'allowlist',groupAllow:['grp']}};
 const ctx={get:()=>undefined,effect:f=>cleanups.push(f())};
 // The application's Conversation wiring, as bootstrapGateway opens it.
 const conversation=qqConversation({io,manager,config,policy:()=>policy});
 const chunkMarkdownText=(text,max)=>chunker(text,max);
 // The gateway's own sender, Interaction bridge and adapter registration, exactly as reviewed.
 const senderSource=slice(source,'    const replyLimiter = new ReplyLimiter({ limit: 4 });','    // Optional Agent policy. No Character');
 const {sender,diagnostics}=vm.runInNewContext('(function(){'+senderSource+';return {sender,diagnostics};})()',{ReplyLimiter,deliveryRecorder:recorder,bot,resolveReplyTarget,sendResolvedMarkdown});
 // The original outbound router with its patched static send.
 const {createOutboundHandler}=load('transport/outbound.js','createOutboundHandler',{formatToolResult:name=>`工具 ${name} 失败`,parseEvent,extractTurnError});
 const body=slice(source,'    const policyFor =','    return outboundHandler;');
 const handler=vm.runInNewContext('(function(){'+body+';return outboundHandler;})()',{
  ctx,manager,sender,config,logger,toolsRegistry:undefined,diagnostics,io,conversation,createOutboundHandler,createTurnControls,AbortController,AbortSignal,randomUUID:()=>'0123abcd-0000-4000-8000-000000000000'});
 const registration=slice(source,'    // Unified Agent I/O text adapter',"    ctx\n        .on('session/event'");
 vm.runInNewContext('(function(){'+registration+'})()',{conversation,createQQTextAdapter:adapterModule.createQQTextAdapter,config,chunkMarkdownText,sender,diagnostics,outboundHandler:handler,ctx});
 // Native Session events as the Host emits them: durable seq, Turn in data.
 let seq=0,call=0;const session={header:{id:'s1'}};
 const emit=(event,id=record.sessionId)=>{handler({header:{id}},event);return event;};
 const native=(type,data,id)=>emit({type,seq:++seq,data},id);
 const ev={
  turn:(turn=1)=>native('turn/start',{turn}),
  reply:(text,turn=1,extra={})=>native('assistant/message',{turn,step:1,message:{role:'assistant',content:[{type:'text',text}]},stream:[],...extra}),
  chunk:(text,turn=1)=>native('assistant/chunk',{turn,step:1,chunk:{type:'text-delta',text}}),
  tool:(name,error,turn=1)=>{const callId='call-'+(++call);native('tool/call',{turn,step:1,callId,name,arguments:'{}'});return native('tool/result',{turn,step:1,message:{role:'tool',source:{callId},content:[]},...(error?{error:{name:'Error',code:error}}:{})});},
  end:(reason={kind:'completed'},turn=1)=>native('turn/end',{turn,reason}),
 };
 return {io,bot,logs,record,sessions,agents,manager,conversation,emit,ev,cleanups,diagnostics,sender,config,session,handler};
}
const warns=g=>g.logs.filter(([level])=>level!=='debug');
test('a plain Agent reply without Interaction reaches QQ once through the Unified I/O, with a stable event id',async()=>{
 const io=createAgentIO(),calls=[];const spy={...io,sendMessage:r=>{calls.push(r);return io.sendMessage(r);}};
 const g=gateway({io:spy});g.ev.turn();const event=g.ev.reply('你好');await tick();
 assert.deepEqual(g.bot.sent,[{msgId:'m1',eventId:undefined,targetId:'owner',content:'你好'}]);assert.deepEqual(warns(g),[]);
 assert.equal(calls[0].id,`qq:s1:${event.seq}:assistant`,'Session id + durable seq + kind, never random');
 assert.equal(calls[0].signal?.aborted,false,'tied to the native Turn');
});
test('a repeated native event or a second settlement of the same message is sent once; equal text from another event is sent again',async()=>{
 const g=gateway();g.ev.turn();const first=g.ev.reply('好的');g.emit(first);g.emit({...first});
 const tool=g.ev.tool('read','denied');g.emit({type:'tool/call',seq:tool.seq-1,data:{turn:1,step:1,callId:tool.data.message.source.callId,name:'read',arguments:'{}'}});g.emit(tool);await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['好的','工具 read 失败']);
 assert.equal(g.logs.filter(([,m])=>/duplicate suppressed/.test(m)).length,3);
 g.ev.reply('好的');await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['好的','工具 read 失败','好的'],'a different event is a different legitimate message');
 // After the first send finished, a late duplicate still gets the earlier outcome.
 g.emit(first);await tick();assert.equal(g.bot.sent.length,3);
});
test('the same logical id with different text or another Conversation is a conflict, not the earlier success',async()=>{
 const g=gateway();g.sessions.set('group:grp',{...g.record,sessionKey:'k2',scope:'group',peerId:'grp',replyTarget:{scope:'group',targetId:'grp',msgId:'g1'}});
 const base={id:'qq:s1:7:assistant',target:{platform:'qq-official',accountId:'app-a',conversation:{type:'direct',id:'owner'}},origin:{sessionId:'s1'},message:{text:'原文'}};
 assert.equal((await g.io.sendMessage(base)).status,'sent');
 const changed=await g.io.sendMessage({...base,message:{text:'改写'}});assert.deepEqual([changed.status,changed.reason,changed.duplicate],['not-sent','id-conflict',undefined]);
 const moved=await g.io.sendMessage({...base,target:{...base.target,conversation:{type:'group',id:'grp'}}});assert.equal(moved.reason,'id-conflict');
 const again=await g.io.sendMessage(base);assert.deepEqual([again.status,again.duplicate],['sent',true]);
 assert.deepEqual(g.bot.sent.map(s=>s.content),['原文']);
});
test('/stop inside one Session cancels its queued output and late output of that Turn; the next Turn sends normally',async()=>{
 const g=gateway({limit:50});let open;g.bot.gates.push(new Promise(r=>open=r));
 g.ev.turn(1);g.ev.reply(['一'.repeat(40),'二'.repeat(40),'三'.repeat(40)].join('\n'),1);g.ev.reply('排队中',1);await tick();
 // /stop: the gateway's stop wrapper calls cancelOutput before native cancellation.
 g.manager.cancelOutput(g.record);open();await tick(10);
 assert.deepEqual(g.bot.sent.map(s=>s.content),['一'.repeat(40)],'the part already at QQ is not withdrawn; nothing else of Turn 1');
 g.ev.reply('被打断的半句',1,{interrupted:true});g.ev.end({kind:'interrupted'},1);g.ev.tool('read','late',1);await tick();
 assert.equal(g.bot.sent.length,1,'interrupted partial and late Turn 1 output are not delivered');
 assert.deepEqual(warns(g).map(([,m])=>m),['im-qqbot: sendMarkdown partial (cancelled)','im-qqbot: sendMarkdown not-sent (cancelled)','im-qqbot: sendToolResult not-sent (cancelled)']);
 g.ev.turn(2);g.ev.reply('第二轮',2);await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['一'.repeat(40),'第二轮'],'same Session, new Turn');
});
test('capacity overflow: output queued in an old Turn is still cancelled by /stop after many newer Turns',async()=>{
 const g=gateway();let open;g.bot.gates.push(new Promise(r=>open=r));
 g.ev.turn(1);g.ev.reply('先发',1);g.ev.reply('旧轮排队',1);await tick();
 // Aborted Turns stay as tombstones: real pressure on the per-Session capacity.
 for(let turn=2;turn<=20;turn++){g.ev.turn(turn);g.ev.end({kind:turn%2?'aborted':'completed'},turn);}
 g.manager.cancelOutput(g.record);open();await tick(10);
 assert.deepEqual(g.bot.sent.map(s=>s.content),['先发'],'the queued Turn 1 message is not sent although 19 Turns followed');
 g.ev.turn(21);g.ev.reply('新一轮',21);await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['先发','新一轮']);
});
test('Session release (rotation, removal, disposal) cancels and forgets its queued output',async()=>{
 const g=gateway();let open;g.bot.gates.push(new Promise(r=>open=r));
 g.ev.turn(1);g.ev.reply('第一条',1);g.ev.reply('释放后不发',1);await tick();
 g.manager.releaseOutput(g.record);open();await tick(10);
 assert.deepEqual(g.bot.sent.map(s=>s.content),['第一条']);
});
test('a Turn that ends aborted cancels its queued output without /stop and without Session rotation',async()=>{
 const g=gateway();let open;g.bot.gates.push(new Promise(r=>open=r));
 g.ev.turn(3);g.ev.reply('先发',3);g.ev.reply('后到',3);await tick();g.ev.end({kind:'aborted',reason:{kind:'user'}},3);open();await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['先发']);
});
test('queued output stops after Session rotation, Agent disposal or revoked access',async()=>{
 const rotated=gateway();let open;rotated.bot.gates.push(new Promise(r=>open=r));
 rotated.ev.reply('第一条');rotated.ev.reply('旧会话的迟到回复');await tick();
 rotated.sessions.set('c2c:owner',{...rotated.record,sessionId:'s2'});open();await tick();
 assert.deepEqual(rotated.bot.sent.map(s=>s.content),['第一条']);assert.deepEqual(warns(rotated),[['warn','im-qqbot: sendMarkdown not-sent (stale)']]);
 rotated.sessions.delete('c2c:owner');rotated.ev.reply('已移除');await tick();assert.equal(rotated.bot.sent.length,1);
 const disposed=gateway();disposed.agents.delete('s1');disposed.ev.reply('Agent 已卸载');await tick();
 assert.equal(disposed.bot.sent.length,0,'the record is still mapped but its Agent is gone');assert.deepEqual(warns(disposed),[['warn','im-qqbot: sendMarkdown not-sent (stale)']]);
 const revoked=gateway();let gate;revoked.bot.gates.push(new Promise(r=>gate=r));revoked.ev.reply('允许时');revoked.ev.reply('撤销后');await tick();
 revoked.config.access.c2cAllow=[];gate();await tick();
 assert.deepEqual(revoked.bot.sent.map(s=>s.content),['允许时']);assert.deepEqual(warns(revoked),[['warn','im-qqbot: sendMarkdown not-sent (unauthorized)']]);
 const closed=gateway({access:{c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'disabled',groupAllow:[]}});closed.sessions.set('group:grp',{...closed.record,scope:'group',peerId:'grp',replyTarget:{scope:'group',targetId:'grp',msgId:'g1'}});
 const r=await closed.io.sendMessage({target:{platform:'qq-official',accountId:'app-a',conversation:{type:'group',id:'grp'}},origin:{sessionId:'s1'},message:{text:'群'}});
 assert.deepEqual([r.status,r.reason],['not-sent','unauthorized'],'disabled group scope is never written to');
});
test('the QQ adapter chunks long text, keeps order and falls back to proactive after the passive quota',async()=>{
 const lines=Array.from({length:6},(_,i)=>String(i).repeat(40));const g=gateway({limit:50});
 g.ev.reply(lines.join('\n'));await tick(20);
 assert.deepEqual(g.bot.sent.map(s=>s.content),lines);
 assert.deepEqual(g.bot.sent.map(s=>s.msgId),['m1','m1','m1','m1',undefined,undefined],'four passive replies per msg_id, then proactive');
 const h=gateway({limit:50});h.ev.reply('x'.repeat(120));await tick(10);
 assert.deepEqual(h.bot.sent.map(s=>s.content.length),[50,50,20],'one long line is cut at the platform limit');
 const pair=gateway({limit:50});pair.ev.reply('a'.repeat(49)+'😀'+'b');await tick(10);
 assert.deepEqual(pair.bot.sent.map(s=>s.content),['a'.repeat(49),'😀b'],'a surrogate pair is never split');
});
test('with the installed markdown chunker, parts stay within the limit and rebuild the text in order',{skip:realChunker?false:'no validation profile with the installed chunker'},async()=>{
 const table='| a | b |\n| - | - |\n| 1 | 2 |',code='```js\n'+Array.from({length:4},(_,i)=>'line'+i).join('\n')+'\n```';
 const text=['前言'.repeat(10),table,code,'后记'.repeat(10),'长'.repeat(90)].join('\n');
 const g=gateway({limit:40,chunker:realChunker});g.ev.reply(text);await tick(30);
 const parts=g.bot.sent.map(s=>s.content);assert(parts.length>2);assert(parts.every(p=>p.length<=40));
 assert.equal(parts.join('').replaceAll('\n',''),text.replaceAll('\n',''));assert(parts.some(p=>p.includes(table)),'a short table is never split across parts');
});
test('tool errors and turn errors use the same ordered path with their own event ids',async()=>{
 const g=gateway();g.ev.turn();g.ev.tool('read','denied');g.ev.end({kind:'error',error:{code:'MODEL_ERROR',message:'fixture'}});await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['工具 read 失败','⚠️ 本轮异常结束\n`MODEL_ERROR`: fixture']);
});
test('order holds across a rejection, an unknown outcome and a partial; nothing is resent',async()=>{
 const g=gateway({limit:50});g.bot.failures.push(new ApiError(400));g.ev.reply('被拒');
 g.bot.failures.push(undefined,new ApiError(0));g.ev.reply('甲'.repeat(40)+'\n'+'乙'.repeat(40));
 g.bot.failures.push(new ApiError(502));g.ev.reply('网关');
 g.bot.failures.push(undefined,new ApiError(403));g.ev.reply('丙'.repeat(40)+'\n'+'丁'.repeat(40)+'\n'+'戊'.repeat(40));
 g.ev.reply('之后');await tick(30);
 assert.deepEqual(g.bot.sent.map(s=>s.content),['被拒','甲'.repeat(40),'乙'.repeat(40),'网关','丙'.repeat(40),'丁'.repeat(40),'之后'],'each part attempted once, in order; the part after a refusal is skipped');
 assert.deepEqual(warns(g),[['warn','im-qqbot: sendMarkdown not-sent (platform-rejected)'],['warn','im-qqbot: sendMarkdown unknown (timeout-or-network)'],['warn','im-qqbot: sendMarkdown unknown (platform-unavailable)'],['warn','im-qqbot: sendMarkdown partial (platform-rejected)']]);
 assert(!JSON.stringify(g.logs).includes('OPENID'),'no API path or identifier in the log');
});
// A stand-in policy with the real one's transport contract: it owns the
// reply (assistant events), queues tool errors on its external channel, and
// hands complete bubbles to transport.sendText(text, metadata).
function stubPolicy(){
 const events=[];
 return {events,bind(t){this.transport=t;},event(e){events.push(e.type);},external(t,m){return this.transport.sendText(t,{...m}).catch(()=>{});}};
}
const bubble=(extra={})=>({kind:'assistant',turn:1,reply:1,bubble:1,signal:new AbortController().signal,cancelled:()=>false,...extra});
test('with Interaction bound, every bubble, hang-on line and tool error is a logical message of the Unified I/O',async()=>{
 const io=createAgentIO(),calls=[];const spy={...io,sendMessage:r=>{calls.push(r);return io.sendMessage(r);}};
 const policy=stubPolicy(),g=gateway({io:spy,policy});g.ev.turn(1);
 g.manager.trackInteractionInput(g.record,{id:'in-1'});g.record.replyTarget={scope:'c2c',targetId:'owner',msgId:'m2'};g.manager.trackInteractionInput(g.record,{id:'in-2'});
 g.ev.reply('交给策略');await tick();assert(policy.events.includes('assistant/message'),'the reply belongs to the policy, not the router');assert.equal(g.bot.sent.length,0);
 const t=policy.transport;assert.equal(t.openStream,undefined,'no stream capability is offered');
 const first=await t.sendText('旧任务的气泡',bubble({input:'in-1'}));
 assert.equal(first.status,'sent');assert.match(calls[0].id,/^qq:s1:1:0123abcd:1\.1:assistant$/,'Session, Turn, policy instance, reply and bubble');
 assert.deepEqual({...calls[0].origin},{sessionId:'s1'});assert.equal(calls[0].signal.aborted,false);
 // The same bubble handed over again is the same logical message: sent once.
 const again=await t.sendText('旧任务的气泡',bubble({input:'in-1'}));assert.equal(again.duplicate,true);
 await t.sendText('新输入的气泡',bubble({input:'in-2',reply:2}));
 await t.sendText('还在处理中，稍等一下。',bubble({kind:'status',reply:2,bubble:2,input:'in-2',transient:true}));
 await t.sendText('没有归属的气泡',bubble({reply:3}));
 g.ev.tool('read','denied',1);await tick();
 assert.deepEqual(g.bot.sent.map(s=>[s.content,s.msgId]),[['旧任务的气泡','m1'],['新输入的气泡','m2'],['还在处理中，稍等一下。','m2'],['没有归属的气泡','m2'],['工具 read 失败','m2']],'each bubble answers the reply target of its own input');
 assert.match(calls.at(-1).id,/^qq:s1:\d+:tool$/,'a tool error keeps its native event id');assert.match(calls[3].id,/:2\.2:status$/);
 assert.equal(calls.length,6,'one I/O request per hand-over, nothing on another path');assert.deepEqual(warns(g),[]);
});
test('an Interaction bubble that is not confirmed rejects with its delivery state and is attempted once',async()=>{
 const policy=stubPolicy(),g=gateway({policy,limit:50});g.ev.turn(1);const t=policy.transport;
 g.bot.failures.push(new ApiError(400));await assert.rejects(t.sendText('被拒',bubble({bubble:1})),e=>e.delivery==='not-sent'&&e.reason==='platform-rejected');
 g.bot.failures.push(new ApiError(0));await assert.rejects(t.sendText('超时',bubble({bubble:2})),e=>e.delivery==='unknown');
 g.bot.failures.push(undefined,new ApiError(403));await assert.rejects(t.sendText('甲'.repeat(40)+'\n'+'乙'.repeat(40),bubble({bubble:3})),e=>e.delivery==='partial');
 assert.deepEqual(g.bot.sent.map(s=>s.content),['被拒','超时','甲'.repeat(40),'乙'.repeat(40)],'no part is retried');
 // Rotation and revoked access refuse the bubble before QQ.
 g.sessions.set('c2c:owner',{...g.record,sessionId:'s2'});await assert.rejects(t.sendText('旧会话',bubble({bubble:4})),e=>e.delivery==='not-sent'&&e.reason==='stale');
 g.sessions.set('c2c:owner',g.record);g.config.access.c2cAllow=[];await assert.rejects(t.sendText('撤权后',bubble({bubble:5})),e=>e.reason==='unauthorized');
 assert.equal(g.bot.sent.length,4);
});
test('cancelling an Interaction bubble: the policy signal, /stop or an aborted Turn stop the parts not yet at QQ',async()=>{
 for(const how of ['policy','stop','turn']){
  const policy=stubPolicy(),g=gateway({policy,limit:50});g.ev.turn(1);const control=new AbortController();let open;g.bot.gates.push(new Promise(r=>open=r));
  const pending=policy.transport.sendText(['一'.repeat(40),'二'.repeat(40),'三'.repeat(40)].join('\n'),bubble({signal:control.signal}));await tick();
  if(how==='policy')control.abort();else if(how==='stop')g.manager.cancelOutput(g.record);else g.ev.end({kind:'aborted',reason:{kind:'user'}},1);
  open();await assert.rejects(pending,e=>e.delivery==='partial'&&e.reason==='cancelled',how);
  assert.deepEqual(g.bot.sent.map(s=>s.content),['一'.repeat(40)],how+': the part at QQ is not withdrawn, nothing else is sent');
  assert.deepEqual(warns(g),[],'a cancellation is not a delivery warning');
 }
 // Already cancelled when handed over: no I/O request at all.
 const io=createAgentIO(),calls=[];const spy={...io,sendMessage:r=>{calls.push(r);return io.sendMessage(r);}};
 const policy=stubPolicy(),g=gateway({io:spy,policy});g.ev.turn(1);
 await assert.rejects(policy.transport.sendText('已取消',bubble({cancelled:()=>true})),e=>e.reason==='cancelled');assert.equal(calls.length,0);
 // Late output of the aborted Turn is refused; the next Turn sends normally.
 g.ev.end({kind:'aborted',reason:{kind:'user'}},1);await assert.rejects(policy.transport.sendText('迟到',bubble()),e=>e.reason==='cancelled');
 g.ev.turn(2);await policy.transport.sendText('第二轮',bubble({turn:2}));assert.deepEqual(g.bot.sent.map(s=>s.content),['第二轮']);
});
test('a plain reply is sent from its settled assistant/message, not from accumulated chunks; the old streaming option changes nothing',async()=>{
 for(const streaming of [false,true]){
  const g=gateway({streaming});g.ev.turn();g.ev.chunk('流');const message=g.ev.reply('流式回复');g.ev.end();await tick();
  g.emit(message);await tick();
  assert.deepEqual(g.bot.sent.map(s=>s.content),['流式回复'],`streaming:${streaming} sends the complete settled text once`);
  assert.equal(g.bot.streams?.length??0,0,'no SDK stream');
 }
});
test('missing, repeated, out-of-order or divergent chunks never change the settled reply',async()=>{
 const io=createAgentIO(),ids=[];const g=gateway({io:{...io,sendMessage:r=>{ids.push(r.id);return io.sendMessage(r);}}});
 g.ev.turn();
 // Chunks of an abandoned attempt, a retry repeating them, out of order and with a different join.
 for(const piece of ['第一段','第一段','。第二','第一段'])g.ev.chunk(piece);
 const message=g.ev.reply('',1,{message:{role:'assistant',content:[{type:'text',text:'第一段。'},{type:'tool-call',id:'c',name:'x',arguments:'{}'},{type:'text',text:'第二段。'}]}});
 g.ev.end();await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['第一段。\n第二段。'],'the settled text blocks, joined as before');
 assert.deepEqual(ids,[`qq:s1:${message.seq}:assistant`],'the logical id is the settlement event, so a replayed settlement is a duplicate');
 // No chunk at all before the settlement.
 const plain=gateway();plain.ev.turn();plain.ev.reply('完整正文');plain.ev.end();await tick();
 assert.deepEqual(plain.bot.sent.map(s=>s.content),['完整正文']);
});
test('unsettled chunks are never sent: not at turn/end, not after a failed attempt, not after cancellation',async()=>{
 // Completed Turn whose deltas never settled into a message (abandoned attempt).
 const completed=gateway();completed.ev.turn();completed.ev.chunk('半句');completed.ev.end();await tick();
 assert.deepEqual(completed.bot.sent,[]);
 // Failed Turn: only the turn error notice, never the partial text.
 const failed=gateway();failed.ev.turn();failed.ev.chunk('半句');failed.ev.end({kind:'error',error:{code:'MODEL_ERROR',message:'boom'}});await tick();
 assert.deepEqual(failed.bot.sent.map(s=>s.content),['⚠️ 本轮异常结束\n`MODEL_ERROR`: boom'],'only the error notice, no fallback to the unsettled deltas');
 // Cancelled: an interrupted settlement and the partial deltas are both dropped.
 for(const kind of ['interrupted','aborted']){
  const stopped=gateway();stopped.ev.turn();stopped.ev.chunk('半');stopped.ev.reply('半截',1,{interrupted:true});stopped.ev.end({kind});await tick();
  assert.equal(stopped.bot.sent.length,0,`${kind}: nothing from the cancelled Turn`);
 }
 // Chunks of one step do not leak into the next step's settled reply.
 const steps=gateway();steps.ev.turn();steps.ev.chunk('旧');steps.ev.reply('第一步');steps.ev.chunk('新');steps.ev.reply('第二步');steps.ev.end();await tick();
 assert.deepEqual(steps.bot.sent.map(s=>s.content),['第一步','第二步']);
});
test('two QQ applications on one I/O keep separate adapters, queues and targets',async()=>{
 const io=createAgentIO(),a=gateway({io,appId:'app-a'}),b=gateway({io,appId:'app-b'});
 let open;a.bot.gates.push(new Promise(r=>open=r));a.ev.reply('给 A');b.ev.reply('给 B');await tick();
 assert.deepEqual(b.bot.sent.map(s=>s.content),['给 B'],'B is not blocked by A, although both events share Session id and seq');open();await tick();
 assert.deepEqual(a.bot.sent.map(s=>s.content),['给 A']);
 assert.throws(()=>gateway({io,appId:'app-a'}),/already registered/,'one active adapter per QQ application');
});
test('a group Conversation maps to the QQ group scope and its own record',async()=>{
 const g=gateway();g.sessions.clear();const group={...g.record,scope:'group',peerId:'grp',replyTarget:{scope:'group',targetId:'grp',msgId:'g1'}};g.sessions.set('group:grp',group);
 assert.deepEqual(JSON.parse(JSON.stringify(g.conversation.target(group))),{platform:'qq-official',accountId:'app-a',conversation:{type:'group',id:'grp'}});
 const r=await g.io.sendMessage({target:{platform:'qq-official',accountId:'app-a',conversation:{type:'group',id:'grp'}},origin:{sessionId:'s1'},message:{text:'群消息'}});
 assert.equal(r.status,'sent');assert.deepEqual(g.bot.sent,[{msgId:'g1',eventId:undefined,targetId:'grp',content:'群消息'}]);
 const wrong=await g.io.sendMessage({target:{platform:'qq-official',accountId:'app-a',conversation:{type:'direct',id:'grp'}},origin:{sessionId:'s1'},message:{text:'x'}});
 assert.equal(wrong.reason,'unauthorized','a direct target never reaches a group: grp is not an admitted C2C peer');
});
test('delivery diagnostics carry the Session hash, part index and bubble numbers, never text',async()=>{
 const rows=[],recorder={hash:v=>v===undefined?undefined:'c'.repeat(24),trace:(e,f)=>rows.push([e,f])};
 const g=gateway({recorder,limit:50});g.ev.reply('秘密'.repeat(30));await tick(10);
 const requests=rows.filter(([e])=>e==='static-request').map(([,f])=>f);
 assert.deepEqual(requests.map(f=>[f.session,f.index]),[['c'.repeat(24),0],['c'.repeat(24),1]]);
 assert(!JSON.stringify(rows).includes('秘密'));assert(rows.some(([e])=>e==='static-receipt'));
 const policy=stubPolicy(),h=gateway({recorder,policy});rows.length=0;h.ev.turn(1);await policy.transport.sendText('私密气泡',bubble({reply:2,bubble:3}));
 const row=rows.find(([e])=>e==='static-request')[1];assert.deepEqual([row.turn,row.reply,row.bubble,row.kind,row.index],[1,2,3,'assistant',0]);assert(!JSON.stringify(rows).includes('私密'));
});
test('QQ error classification only treats a 4xx refusal as not sent',()=>{
 const c=adapterModule.classifyQQError;
 assert.deepEqual([0,408,429,400,403,500,503,200].map(s=>[s,c(new ApiError(s)).outcome]),[[0,'unknown'],[408,'unknown'],[429,'not-sent'],[400,'not-sent'],[403,'not-sent'],[500,'unknown'],[503,'unknown'],[200,'unknown']]);
 assert.equal(c(new Error('socket hang up')).outcome,'unknown');assert.equal(c(undefined).outcome,'unknown');
});
test('the wiring refuses a Manager without the ownership check, and the access rules mirror the SDK',()=>{
 assert.throws(()=>qqConversation({io:createAgentIO(),manager:{getOrCreate(){},getSessionRecord(){}},config:{appId:'a',access:{}}}),/ownership check required/);
 const allows=adapterModule.accessAllows;
 assert.deepEqual([allows({c2cMode:'allowlist',c2cAllow:['u']},'c2c','u'),allows({c2cMode:'allowlist',c2cAllow:['u']},'c2c','v'),allows({c2cMode:'allowlist',c2cAllow:[]},'c2c','u'),allows({c2cMode:'allowlist',c2cAllow:['*']},'c2c','v'),allows({},'c2c','u'),allows({groupMode:'disabled'},'group','g'),allows({groupMode:'allowlist',groupAllow:['g']},'group','g'),allows({c2cMode:'bogus'},'c2c','u')],[true,false,false,true,true,false,true,false]);
});
test('no QQ chat output path is left beside the Unified I/O',()=>{
 const bridge=slice(read('gateway/bootstrap.js'),'export function createInteractionOutbound','export async function bootstrapGateway').replace(/\/\/.*$/gm,'');
 for(const banned of ['openStream','sendMarkdown','boundedStream','StreamingWriter'])assert(!bridge.includes(banned),banned);
 const gatewaySource=read('gateway/bootstrap.js');assert(!/openStream/.test(gatewaySource.replace(/\/\/.*$/gm,'')),'the gateway sender offers no SDK stream');
 assert(!/streaming-writer|StreamingWriter/.test(read('transport/outbound-buffer.js')),'the plain buffer has no stream writer');
});
test('the QQ plugin declares the agentIO service and the gateway refuses to start without it',()=>{
 assert.match(read('index.js'),/inject = \['agents', 'conversationManager', 'agentIO'\]/);
 assert.match(read('gateway/bootstrap.js'),/if \(!io\) throw new Error\('Install and configure dsh-agent-io before QQ'\)/);
 assert.match(read('gateway/bootstrap.js'),/if \(typeof io\.openConversation !== 'function'\) throw new Error\('dsh-agent-io 0\.1\.0-test\.4 or later \(openConversation\) is required before QQ'\)/,'an older I/O package stops the Gateway with a clear error');
 assert.match(read('gateway/middleware-setup.js'),/manager\.cancelOutput\?\.\(record\)/,'/stop cancels unsent I/O output first');
 // The original router no longer holds a direct static sender.
 for(const file of ['transport/outbound.js','transport/outbound-buffer.js'])assert(!/\.sendMarkdown\(|chunkMarkdownText/.test(strip(read(file)).replace(/\/\*\*[\s\S]*?\*\//g,'')),file);
 assert(!/OutboundBuffer|outbound-buffer/.test(read('transport/outbound.js')),'the router sends settled text only, no chunk buffer');
});
