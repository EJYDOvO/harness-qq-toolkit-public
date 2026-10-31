// Uses an explicit code-only SDK/QQ fixture; never instantiates QQBot or contacts QQ.
// Assertions describe release requirements and intentionally remain red on test.10.
// Iteration 04: all chat output goes through the Unified Agent I/O; no SDK stream path.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import path from 'node:path';import {pathToFileURL} from 'node:url';import os from 'node:os';
import {Interaction} from '../../../character-agent-v1/packages/interaction-policy/policy.mjs';
import {createConversations} from '../../plugin-sources/dsh-agent-io/conversation.mjs';
import {createAgentIO} from '../../plugin-sources/dsh-agent-io/io.mjs';
import {createTurnControls} from '../qq-conversation-fixture.mjs';
const sdk=process.env.QQBOT_AUDIT_SDK_DIR,qq=process.env.QQBOT_AUDIT_DIST;
assert(sdk&&qq,'Set QQBOT_AUDIT_SDK_DIR and QQBOT_AUDIT_DIST to isolated code-only fixture directories');
const {StreamSession}=await import(pathToFileURL(path.join(sdk,'streaming.js')));
const {MessageApi}=await import(pathToFileURL(path.join(sdk,'protocol/api/messages.js')));
const {ApiClient}=await import(pathToFileURL(path.join(sdk,'protocol/api/api-client.js')));
const {ApiError}=await import(pathToFileURL(path.join(sdk,'protocol/types.js')));
const {concurrencyGuard}=await import(pathToFileURL(path.join(sdk,'middleware/concurrency-guard.js')));
const {ReplyLimiter}=await import(pathToFileURL(path.join(qq,'transport/reply-limiter.js')));
const {cacheMsgId,getCachedReplyIds}=await import(pathToFileURL(path.join(qq,'transport/msgid-cache.js')));
const {ConfigSchema}=await import(pathToFileURL(path.join(qq,'config.js')));
// The reviewed QQ text adapter (no imports) from this checkout.
const {createQQTextAdapter,classifyQQError}=await import(new URL('../qqbot-src/dist/transport/qq-text-adapter.js',import.meta.url));
const source=fs.readFileSync(new URL('../qqbot-src/dist/gateway/bootstrap.js',import.meta.url),'utf8');
const targetSource=fs.readFileSync(path.join(qq,'transport/reply-target.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function','function');
const {resolveReplyTarget,sendResolvedMarkdown}=vm.runInNewContext(targetSource+'\n;({resolveReplyTarget,sendResolvedMarkdown});',{getCachedReplyIds,MsgType:{MARKDOWN:2}});
const slice=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,start);return source.slice(a,b);};
const makeSender=vm.runInNewContext('(function(bot,deliveryRecorder){'+slice('    const replyLimiter =','    // Optional Agent policy')+'return {sender,replyLimiter};})',{ReplyLimiter,resolveReplyTarget,sendResolvedMarkdown});
const makeOutbound=vm.runInNewContext(slice('export function createInteractionOutbound','export async function bootstrapGateway').replace(/^export (async )?function/gm,'$1function')+';createInteractionOutbound;',{AbortController,AbortSignal,createTurnControls,randomUUID:()=> 'fixture-0000-4000',createOutboundHandler:()=>()=>{}});
// The gateway's own Unified Agent I/O adapter registration (the only chat output path).
const registerAdapter=vm.runInNewContext('(function(conversation,config,chunkMarkdownText,sender,diagnostics,outboundHandler,ctx){'+slice('    // Unified Agent I/O text adapter',"    ctx\n        .on('session/event'")+'})',{createQQTextAdapter});
const micro=()=>new Promise(r=>setImmediate(r));
// The real Interaction policy, gateway bridge, Unified Agent I/O, shared Conversation
// wiring, QQ text adapter, gateway sender, reply limiter and SDK MessageApi.
function fixture(t,{rejectOver=Infinity,onRequest,diagnostics,limit=4500}={}){
 const payloads=[],agent={session:{header:{id:'fixture'}},status:'running'},timers=new Map();let timer=0;
 const policy=new Interaction(agent,{throttleMs:0},{now:Date.now,set:fn=>{timers.set(++timer,fn);return timer;},clear:id=>timers.delete(id)});t.after(()=>policy.dispose());
 const api=new MessageApi({async request(_token,_method,_path,body){payloads.push(structuredClone(body));if((body.markdown?.content??body.content_raw??'').length>rejectOver)throw Error('fixture: over platform limit');if(onRequest)await onRequest(body);return {id:'synthetic-receipt'};}},{getAccessToken:async()=> 'synthetic-token'},{markdownSupport:true});
 const bot={sendMarkdown:(target,text)=>api.sendRaw(target.scope,target.targetId,{appId:'fixture',clientSecret:'dummy'},{markdown:{content:text},msg_id:target.msgId}),send:opts=>api.sendRaw(opts.target.scope,opts.target.targetId,{appId:'fixture',clientSecret:'dummy'},{markdown:opts.markdown,...opts.extra}),openStream(){throw Error('QQ chat output never opens an SDK stream');}};
 const {sender,replyLimiter}=makeSender(bot,diagnostics);
 const record={agent,sessionKey:'fixture',sessionId:'fixture',scope:'c2c',peerId:'fixture-owner',replyTarget:{scope:'c2c',targetId:'fixture-owner',msgId:'fixture-message'}};
 const manager={getOrCreate:async()=>record,getSessionRecord:()=>record,isCurrentSession:r=>r===record,findBySessionId:()=>record};
 // The shared Conversation wiring supplies the policy and the route, as in the Gateway.
 const io=createAgentIO(),config={textChunkLimit:limit};
 const conversation=createConversations(io,{createInput:m=>m,interactionPolicy:()=>policy})({platform:'qq-official',adapter:'qq-official-gateway',accountId:'fixture',manager,scopes:{direct:'c2c',group:'group'},admits:()=>true});
 const outbound=makeOutbound({get:()=>{throw Error('policy comes from the Conversation wiring');}},manager,sender,config,{warn(){},debug(){},error(){}},undefined,diagnostics,io,conversation);
 registerAdapter(conversation,config,chunk,sender,diagnostics,outbound,{effect(){}});
 const event=(type,data={})=>outbound(agent.session,{type,data});
 // What the shared handoff does for an admitted QQ input: QQ tracking, then the policy.
 manager.registerInteractionInput=(r,m)=>{manager.trackInteractionInput(r,m);policy.admitInput(m);};
 const input={id:'native-fixture-input',source:{kind:'user'}};manager.registerInteractionInput(record,input);event('turn/start',{turn:1});event('user/message',{turn:1,message:input});
 const final=text=>event('assistant/message',{turn:1,message:{content:[{type:'text',text}]}});
 const texts=()=>payloads.map(b=>b.markdown?.content);
 return {policy,record,manager,sender,replyLimiter,payloads,event,final,timers,io,texts};
}
// Line-based stand-in for the markdown chunker (the real one is covered by the light tests).
const chunk=(text,limit)=>{const out=[];let cur='';for(const line of text.split('\n')){const next=cur?cur+'\n'+line:line;if(cur&&next.length>limit){out.push(cur);cur=line;}else cur=next;}if(cur)out.push(cur);return out.length?out:[text];};

test('only a confirmed QQ send confirms a bubble; diagnostics connect settlement and requests, never text',async t=>{
 const traces=[],diagnostics={hash:()=> 'a'.repeat(24),trace:(event,fields)=>traces.push({event,...fields})};
 let release;const f=fixture(t,{diagnostics,onRequest:()=>new Promise(r=>release=r)});
 f.policy.text('QQ接口尚未确认');f.policy.update(f.policy.message);await micro();assert.deepEqual(f.payloads,[],'nothing before the bubble is complete');
 f.final('QQ接口尚未确认');await micro();await micro();assert.equal(f.policy.delivered,false);assert(traces.some(x=>x.event==='static-request'&&x.kind==='assistant'&&x.bubble===1));
 release();await f.policy.idle();assert.equal(f.policy.delivered,true);
 assert(traces.some(x=>x.event==='assistant-settlement'));assert(traces.some(x=>x.event==='static-receipt'&&x.receipt));
 assert(!JSON.stringify(traces).includes('QQ接口'));
});

test('missing stream receipt ID is observable without inventing association or retrying (SDK patch, unused by chat output)',async()=>{
 const events=[],stream=new StreamSession({sendC2CStreamMessage:async()=>({})},{openid:'fixture',msgId:'fixture',creds:{}}).observe(e=>events.push(e));
 await stream.update('fixture');await stream.complete();assert.equal(events.filter(e=>e.type==='request').length,2);assert(events.filter(e=>e.type==='receipt').every(e=>e.receiptId===undefined));assert(events.every(e=>!e.streamMsgId));
});

test('SDK observer failure cannot break sending or change retry policy (SDK patch, unused by chat output)',async()=>{
 let calls=0;const stream=new StreamSession({sendC2CStreamMessage:async()=>{calls++;return {id:'fixture'};}},{openid:'fixture',msgId:'fixture',creds:{}}).observe(()=>{throw Error('diagnostic error');});
 await stream.update('fixture');await stream.complete();assert.equal(calls,2);
});
for(const length of [4501,5001,10001])test(`Q01 ${length} chars respect configured 4500 limit and retain the entire message`,async t=>{
 const f=fixture(t,{rejectOver:5000}),text='长'.repeat(length);f.final(text);await f.policy.idle();
 assert(f.payloads.every(b=>b.markdown.content.length<=4500),'adapter emitted an oversized payload');
 assert.equal(f.texts().join(''),text);assert(f.payloads.every(b=>b.input_state===undefined),'no SDK stream frame');
});
test('Q02 Interaction bubbles share the same four-reply passive budget as plain replies',async t=>{
 const f=fixture(t);for(let i=0;i<6;i++){f.final('第'+i+'个工具步骤的完整回应');await f.policy.idle();}
 assert.equal(f.payloads.length,6);assert(f.payloads.filter(b=>b.msg_id).length<=4,'six passive replies bypassed ReplyLimiter');
 assert(f.replyLimiter.checkLimit('fixture-message').remaining===0);
});
test('Q03 explicit target remains expired rather than resurrecting on the next limit check',()=>{
 const limiter=new ReplyLimiter({ttlMs:10});limiter.record('expired-fixture');limiter.messages.get('expired-fixture').firstSeenAt=Date.now()-20;
 assert.equal(limiter.checkLimit('expired-fixture').allowed,false);assert.equal(limiter.checkLimit('expired-fixture').allowed,false);
});
test('Q04 expired explicit target duplicated in cache must not bypass fallback',()=>{
 const target={scope:'c2c',targetId:'expiry-fixture',msgId:'expired-twice'},limiter=new ReplyLimiter({ttlMs:10});cacheMsgId(target.scope,target.targetId,target.msgId);limiter.record(target.msgId);limiter.messages.get(target.msgId).firstSeenAt=Date.now()-20;
 assert.equal(resolveReplyTarget(target,limiter,true).msgId,undefined);
});
test('Q05 generated text that is not a complete bubble stays unsent when output is canceled',async t=>{
 const f=fixture(t);f.policy.text('已经生成的前缀');f.policy.update(f.policy.message);await f.policy.idle();
 f.policy.text('取消前仍未完成的尾巴');f.policy.update(f.policy.message);await f.policy.idle();
 f.policy.stopOutput();f.final('已经生成的前缀取消前仍未完成的尾巴');await f.policy.idle();assert.deepEqual(f.payloads,[]);
});
test('Q06 a rate-limit rejection is reported and never retried, also after stop',async t=>{
 let calls=0;const f=fixture(t,{onRequest:()=>{calls++;throw new ApiError('请求过于频繁',429,'/fixture',50002);}});
 f.final('被限流的气泡');await f.policy.idle();assert.equal(calls,1);assert(f.policy.errors.includes('bubble-delivery-failed'));
 f.policy.stopOutput();await f.policy.idle();assert.equal(calls,1,'retried after stop');
});
test('Q07 a refused bubble withholds the rest of its reply instead of leaving a gap; the next reply is delivered',async t=>{
 let calls=0;const f=fixture(t,{onRequest:()=>{if(++calls===1)throw new ApiError('rejected',400,'/fixture',0);}});
 f.final('第一段完整文本，写得足够长。\n\n第二段完整文本，同样足够长。');await f.policy.idle();
 assert.deepEqual(f.texts(),['第一段完整文本，写得足够长。\n\n']);assert(f.policy.errors.includes('bubble-delivery-failed'));
 f.event('turn/end',{turn:1,reason:{kind:'completed'}});f.event('turn/start',{turn:2});const next={id:'next-input',source:{kind:'user'}};f.manager.registerInteractionInput(f.record,next);f.event('user/message',{turn:2,message:next});
 f.event('assistant/message',{turn:2,message:{content:[{type:'text',text:'下一次回复。'}]}});await f.policy.idle();assert.equal(f.texts().at(-1),'下一次回复。');
});
test('Q08 a 4500-character result is one bubble and one payload',async t=>{
 const f=fixture(t),text='长'.repeat(4500);f.final(text);await f.policy.idle();assert.deepEqual(f.texts(),[text]);
});
test('Q09 Web input on a QQ-bound Session must not send response or hang-on to QQ',async t=>{
 const f=fixture(t);f.event('user/message',{source:{kind:'web'},content:[{type:'text',text:'Web-only'}]});f.policy.hangOn();f.final('Web-only结果');await f.policy.idle();assert.deepEqual(f.payloads,[]);
});
test('Q10 actual SDK request deadline must include reading a stalled response body',async()=>{
 const saved=globalThis.fetch;let release,signal;
 globalThis.fetch=async(_url,init)=>{signal=init.signal;return {ok:true,status:200,headers:new Headers(),text:()=>new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});})};};
 try{
  const client=new ApiClient({baseUrl:'https://no-network.invalid',defaultTimeoutMs:10});
  const request=client.request('synthetic-token','POST','/fixture',{});
  const observed=request.then(()=> 'resolved',()=> 'aborted');await micro();
  const result=await Promise.race([observed,new Promise(r=>setTimeout(()=>r('hung'),50))]);
  release('{}');await request.catch(()=>{});assert.equal(result,'aborted');assert.equal(signal.aborted,true);
 }finally{globalThis.fetch=saved;}
});
test('Q11 rate-limit recognition accepts the actual SDK ApiError fields',()=>{
 assert.equal(classifyQQError(new ApiError('请求过于频繁',429,'/fixture',50002)).outcome,'not-sent');
 assert.equal(classifyQQError(new ApiError('timeout',0,'/fixture',0)).outcome,'unknown');
});
test('Q12 merge survivor retains per-peer exclusion until its downstream completes',async()=>{
 const guard=concurrencyGuard({strategy:'merge',maxQueue:8});let releaseA,releaseB,active=0,peak=0;
 const context=n=>({message:{content:n,messageId:n,replyTarget:{scope:'c2c',targetId:'merge-fixture'}},state:{},log:{debug(){},warn(){}},stop(){},abort(){},signal:new AbortController().signal});
 const enter=async gate=>{active++;peak=Math.max(peak,active);if(gate)await gate;active--;};
 const a=guard(context('A'),()=>enter(new Promise(r=>releaseA=r)));const b=guard(context('B'),()=>enter(new Promise(r=>releaseB=r)));
 releaseA();await a;await micro();assert(releaseB,'Buffered survivor must have started');
 const c=guard(context('C'),()=>enter());await micro();releaseB();await Promise.all([b,c]);assert.equal(peak,1,'C entered while merged survivor B still executed');
});
// Reuse the existing deterministic middleware fixture, which evaluates the actual
// patched middleware body. The assertions below cover gaps in its original tests.
const support=fs.readFileSync(new URL('../interaction.test.mjs',import.meta.url),'utf8');
const wiringSource=support.slice(support.indexOf('const wiring='),support.indexOf('\n',support.indexOf('const wiring=')));
const fixtureSource=support.slice(support.indexOf('function middleware('),support.indexOf("test('explicit correction"));
const middlewareFixture=vm.runInNewContext(wiringSource+'\n'+fixtureSource+'\n;middleware;',{fs,vm,assert,URL,Math,createAgentIO,createConversations,base:new URL('../qqbot-src/dist/gateway/',import.meta.url)});
test('Q13 generic correction refreshes reply target without Character admission hook',async()=>{
 const f=middlewareFixture();f.record.replyTarget={scope:'c2c',targetId:'owner',msgId:'old'};
 await f.run('更正：保留文件',{message:{kind:'c2c',senderId:'owner',messageId:'new',content:'更正：保留文件'}});assert.equal(f.record.replyTarget.msgId,'new');
});
test('Q14 native stop remains available if a reloading policy service cannot resolve its Agent',async()=>{
 const f=middlewareFixture('throw');
 await assert.doesNotReject(()=>f.run('/stop'));assert(f.events.some(e=>e[0]==='native-stop'));
});

test('Q15 native Web user source cannot impersonate a registered QQ input',async t=>{
 const f=fixture(t);f.event('turn/end',{turn:1,reason:{kind:'completed'}});f.event('turn/start',{turn:2});
 f.event('user/message',{id:'unregistered-web',source:{kind:'user'},content:[{type:'text',text:'Web'}]});
 f.policy.hangOn();f.event('assistant/message',{turn:2,message:{content:[{type:'text',text:'Web result'}]}});await f.policy.idle();assert.deepEqual(f.payloads,[]);
 const message={id:'next-qq',source:{kind:'user'}};f.manager.registerInteractionInput(f.record,message);f.event('user/message',message);
 f.event('user/message',{id:'host-context',source:{kind:'runtime-context'}});
 f.event('assistant/message',{turn:2,message:{content:[{type:'text',text:'QQ result'}]}});await f.policy.idle();assert.equal(f.payloads.at(-1).markdown.content,'QQ result');
});

test('native Host context retains admitted QQ output through the Unified I/O; the bubble before a tool goes out while it runs',async t=>{
 const f=fixture(t);
 for(const kind of ['agent-instructions','runtime-context','skill-catalog','time-context'])f.event('user/message',{message:{id:kind,source:{kind}}});
 f.final('我先查一下。');f.event('tool/call',{callId:'search'});await f.policy.idle();assert.deepEqual(f.texts(),['我先查一下。'],'sent while the tool runs');
 f.event('user/message',{id:'new-time',source:{kind:'time-context'}});
 f.event('tool/result',{message:{source:{callId:'search'}}});f.final('完整结果。');
 f.event('turn/end',{turn:1,reason:{kind:'completed'}});await f.policy.idle();
 assert.deepEqual(f.texts(),['我先查一下。','完整结果。']);assert.equal(f.record.interactionSuppressed,false);
});

for(const kind of ['web','schedule','unknown','user'])test(`native context cannot reactivate unadmitted ${kind} output`,async t=>{
 const f=fixture(t);f.event('user/message',{id:'not-admitted',source:{kind}});
 for(const context of ['agent-instructions','runtime-context','skill-catalog','time-context'])f.event('user/message',{source:{kind:context}});
 f.policy.hangOn();f.final('非QQ结果');await f.policy.idle();assert.deepEqual(f.payloads,[]);
});

test('Q16 cancellation during a settled long send suppresses the remaining protocol parts',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=fixture(t,{onRequest:()=>gate});
 f.final('字'.repeat(10001));await micro();await micro();assert.equal(f.payloads.length,1);f.policy.stopOutput();release();await f.policy.idle();assert.equal(f.payloads.length,1);
});

test('Q17 a long reply commits complete bubbles while generating, in order, without duplicates',async t=>{
 const f=fixture(t),section=n=>`第${n}部分的完整说明。`.repeat(28);const text=[1,2,3,4].map(section).join('\n\n');
 for(let i=0;i<text.length;i+=40){f.policy.text(text.slice(i,i+40));f.policy.update(f.policy.message);await f.policy.idle();}
 const early=f.texts();assert(early.length>=1&&early.length<=2,'committed before settlement');assert(text.startsWith(early.join('')));
 f.final(text);await f.policy.idle();assert.equal(f.texts().join(''),text);assert.deepEqual(f.texts().slice(0,early.length),early);assert(f.texts().length<=3);
});

test('Q18 a long uncommitted reply never sends a partial bubble, also after stop',async t=>{
 const f=fixture(t);f.policy.text('草'.repeat(10001));f.policy.update(f.policy.message);await f.policy.idle();
 assert.deepEqual(f.payloads,[]);f.policy.stopOutput();await f.policy.idle();assert.deepEqual(f.payloads,[]);
});
test('Q19 Session rotation and revoked access stop queued bubbles before QQ',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=fixture(t,{onRequest:()=>gate});
 f.final('第一段完整文本，写得足够长。\n\n第二段完整文本，同样足够长。');await micro();await micro();assert.equal(f.payloads.length,1);
 f.manager.isCurrentSession=()=>false;release();await f.policy.idle();assert.equal(f.payloads.length,1,'the second bubble is refused as stale');
});
test('QQ lifecycle configuration parses through the installed Host schema and remains opt-in',()=>{
 const legacy=ConfigSchema({});assert.deepEqual(legacy.sessionLifecycle,{enabled:false,freshOnHostRestart:true,inactivityMs:43200000});
 const enabled=ConfigSchema({sessionLifecycle:{enabled:true}});assert.equal(enabled.sessionLifecycle.inactivityMs,43200000);assert.equal(enabled.sessionLifecycle.freshOnHostRestart,true);
 assert.throws(()=>ConfigSchema({sessionLifecycle:{enabled:true,inactivityMs:0}}));
});

// ── Iteration 05 basic media on the real SDK MediaApi (synthetic HTTP client, no network) ──
const {MediaApi}=await import(pathToFileURL(path.join(sdk,'protocol/api/media.js')));
const {verifyLocalFile}=await import(pathToFileURL(path.join(qq,'media/send-file-tool.js')));
const {sendMedia}=vm.runInNewContext(slice('const MEDIA_TYPES','export async function bootstrapGateway').replace(/^export (async )?function/gm,'$1function')+';({sendMedia});',{verifyLocalFile,resolveReplyTarget,MediaFileType:{IMAGE:1,VIDEO:2,VOICE:3,FILE:4},process});
function mediaFixture(t,{fail}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qq-audit-media-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const requests=[],creds={appId:'fixture',clientSecret:'dummy'};
 const client={async request(_token,method,route,body){requests.push({method,route,body:structuredClone(body)});const f=fail?.(route,requests.length);if(f)throw f;return route.endsWith('/files')?{file_uuid:'synthetic-uuid',file_info:'synthetic-info',ttl:0}:{id:'synthetic-media-receipt'};}};
 const mediaApi=new MediaApi(client,{getAccessToken:async()=> 'synthetic-token'},{});
 const bot={creds,mediaApi,uploadMedia:o=>mediaApi.uploadMedia(o.target.scope,o.target.targetId,o.fileType,creds,{localPath:o.localPath,srvSendMsg:o.srvSendMsg,fileName:o.fileName}),sendMarkdown:async()=>({id:'text'})};
 const config={textChunkLimit:4500,sendFile:{restrictPaths:true,extraRoots:[dir]},cwd:dir};
 const record={agent:{status:'idle'},sessionKey:'fixture',sessionId:'fixture',scope:'c2c',peerId:'fixture-owner',replyTarget:{scope:'c2c',targetId:'fixture-owner',msgId:'fixture-message'}};
 const manager={getOrCreate:async()=>record,getSessionRecord:()=>record,isCurrentSession:r=>r===record};
 const io=createAgentIO(),limiter=new ReplyLimiter({limit:4});
 const conversation=createConversations(io,{createInput:m=>m,interactionPolicy:()=>undefined})({platform:'qq-official',adapter:'qq-official-gateway',accountId:'fixture',manager,scopes:{direct:'c2c',group:'group'},admits:()=>true});
 conversation.registerAdapter(createQQTextAdapter({send:async()=>({id:'text'}),split:t=>[t],sendMedia:(target,a)=>sendMedia(bot,limiter,config,target,a)}));
 const send=(attachments,id)=>io.sendMessage({...(id?{id}:{}),target:conversation.target(record),origin:{sessionId:'fixture'},message:{attachments}});
 const fileAt=(name,body='synthetic')=>{const p=path.join(dir,name);fs.writeFileSync(p,body);return p;};
 return {requests,send,fileAt,dir};
}
test('Q20 a file attachment is uploaded without sending, then sent as one media message replying to the input',async t=>{
 const f=mediaFixture(t),doc=f.fileAt('report.pdf','PDF');
 const r=await f.send([{kind:'file',name:'report.pdf',resource:{type:'local',path:doc}}],'qq:fixture:1:file:x');
 assert.equal(r.status,'sent');assert.deepEqual({...r.parts[0]},{index:0,status:'sent',attachment:0,receipt:'synthetic-media-receipt',uploaded:'synthetic-uuid'});
 const [upload,message]=f.requests;
 assert.equal(upload.route,'/v2/users/fixture-owner/files');assert.equal(upload.body.srv_send_msg,false);assert.equal(upload.body.file_type,4);assert.equal(upload.body.file_name,'report.pdf');assert.equal(Buffer.from(upload.body.file_data,'base64').toString(),'PDF');
 assert.equal(message.route,'/v2/users/fixture-owner/messages');assert.equal(message.body.msg_type,7);assert.deepEqual(message.body.media,{file_info:'synthetic-info'});assert.equal(message.body.msg_id,'fixture-message');
 const again=await f.send([{kind:'file',name:'report.pdf',resource:{type:'local',path:doc}}],'qq:fixture:1:file:x');
 assert.equal(again.duplicate,true);assert.equal(f.requests.length,2,'the same logical message is not uploaded again');
});
test('Q21 real SDK errors: a refused upload is not-sent, a timed-out media message is unknown and not retried',async t=>{
 const refused=mediaFixture(t,{fail:route=>route.endsWith('/files')?new ApiError('API Error 400 Invalid file',400,route):undefined});
 const r=await refused.send([{kind:'image',resource:{type:'local',path:refused.fileAt('a.png')}}]);
 assert.deepEqual([r.status,r.reason],['not-sent','upload-failed']);assert(refused.requests.every(x=>x.route.endsWith('/files')),'no media message after a failed upload');
 const timeout=mediaFixture(t,{fail:route=>route.endsWith('/messages')?new ApiError('timeout',0,route):undefined});
 const u=await timeout.send([{kind:'image',resource:{type:'local',path:timeout.fileAt('b.png')}}]);
 assert.deepEqual([u.status,u.reason],['unknown','timeout-or-network']);assert.equal(timeout.requests.filter(x=>x.route.endsWith('/messages')).length,1,'the message request is never repeated');
 const outside=mediaFixture(t),elsewhere=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qq-audit-out-')));t.after(()=>fs.rmSync(elsewhere,{recursive:true,force:true}));
 fs.writeFileSync(path.join(elsewhere,'x.txt'),'secret');
 const o=await outside.send([{kind:'file',resource:{type:'local',path:path.join(elsewhere,'x.txt')}}]);
 assert.deepEqual([o.status,o.reason,o.stage],['not-sent','invalid-resource','before-platform']);assert.equal(outside.requests.length,0,'nothing read or uploaded');
});
