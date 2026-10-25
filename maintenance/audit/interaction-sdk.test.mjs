// Uses an explicit code-only SDK/QQ fixture; never instantiates QQBot or contacts QQ.
// Assertions describe release requirements and intentionally remain red on test.10.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {Interaction} from '../../../character-agent-v1/packages/interaction-policy/policy.mjs';
const sdk=process.env.QQBOT_AUDIT_SDK_DIR,qq=process.env.QQBOT_AUDIT_DIST;
assert(sdk&&qq,'Set QQBOT_AUDIT_SDK_DIR and QQBOT_AUDIT_DIST to isolated code-only fixture directories');
const {StreamSession}=await import(pathToFileURL(path.join(sdk,'streaming.js')));
const {MessageApi}=await import(pathToFileURL(path.join(sdk,'protocol/api/messages.js')));
const {ApiClient}=await import(pathToFileURL(path.join(sdk,'protocol/api/api-client.js')));
const {ApiError,StreamInputState}=await import(pathToFileURL(path.join(sdk,'protocol/types.js')));
const {concurrencyGuard}=await import(pathToFileURL(path.join(sdk,'middleware/concurrency-guard.js')));
const {ReplyLimiter}=await import(pathToFileURL(path.join(qq,'transport/reply-limiter.js')));
const {cacheMsgId,getCachedReplyIds}=await import(pathToFileURL(path.join(qq,'transport/msgid-cache.js')));
const {ConfigSchema}=await import(pathToFileURL(path.join(qq,'config.js')));
const source=fs.readFileSync(new URL('../qqbot-src/dist/gateway/bootstrap.js',import.meta.url),'utf8');
const targetSource=fs.readFileSync(path.join(qq,'transport/reply-target.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function','function');
const {resolveReplyTarget,sendResolvedMarkdown}=vm.runInNewContext(targetSource+'\n;({resolveReplyTarget,sendResolvedMarkdown});',{getCachedReplyIds,MsgType:{MARKDOWN:2}});
const makeSender=vm.runInNewContext('(function(bot){'+source.slice(source.indexOf('    const replyLimiter ='),source.indexOf('    // Optional Agent policy.'))+'return {sender,replyLimiter};})',{ReplyLimiter,resolveReplyTarget,sendResolvedMarkdown});
const makeOutbound=vm.runInNewContext(source.slice(source.indexOf('export function createInteractionOutbound'),source.indexOf('export async function bootstrapGateway')).replace('export function','function')+';createInteractionOutbound;',{createOutboundHandler:()=>()=>{}});
const micro=()=>new Promise(r=>setImmediate(r));
function fixture(t,{streaming=false,rejectOver=Infinity,onRequest}={}){
 const payloads=[],bubbles=[],agent={session:{header:{id:'fixture'}},status:'running'},key={},timers=new Map();let timer=0;
 const policy=new Interaction(agent,{throttleMs:0},{now:Date.now,set:fn=>{timers.set(++timer,fn);return timer;},clear:id=>timers.delete(id)});t.after(()=>policy.dispose());
 const api=new MessageApi({async request(_token,_method,_path,body){payloads.push(structuredClone(body));if((body.markdown?.content??body.content_raw??'').length>rejectOver)throw Error('fixture: over platform limit');if(onRequest)await onRequest(body);return {id:'synthetic-stream'};}},{getAccessToken:async()=> 'synthetic-token'},{markdownSupport:true});
 const bot={sendMarkdown:(target,text)=>api.sendRaw(target.scope,target.targetId,{appId:'fixture',clientSecret:'dummy'},{markdown:{content:text},msg_id:target.msgId}),send:opts=>api.sendRaw(opts.target.scope,opts.target.targetId,{appId:'fixture',clientSecret:'dummy'},{markdown:opts.markdown,...opts.extra}),openStream:({target})=>{const stream=new StreamSession(api,{openid:target.targetId,msgId:target.msgId,creds:{appId:'fixture',clientSecret:'dummy'},throttleMs:300});bubbles.push(stream);return stream;}};
 const {sender,replyLimiter}=makeSender(bot);
 const record={agent,sessionKey:'fixture',replyTarget:{scope:'c2c',targetId:'fixture-owner',msgId:'fixture-message'}};
 const manager={getSessionRecord:()=>record,findBySessionId:()=>record};
 const outbound=makeOutbound({get:()=>({serviceFor:()=>({get:()=>policy})})},manager,sender,{streaming,textChunkLimit:4500},{});
 const event=(type,data={})=>outbound(agent.session,{type,data});
 const input={id:'native-fixture-input',source:{kind:'user'}};manager.registerInteractionInput(record,input);event('turn/start',{turn:1});event('user/message',{turn:1,message:input});
 const final=text=>event('assistant/message',{turn:1,message:{content:[{type:'text',text}]}});
 return {policy,record,manager,sender,replyLimiter,payloads,bubbles,event,final};
}
for(const streaming of [false,true])for(const length of [4501,5001,10001])test(`Q01 ${streaming?'stream':'static'} ${length} chars respect configured 4500 limit and retain the entire message`,async t=>{
 const f=fixture(t,{streaming,rejectOver:5000}),text='长'.repeat(length);f.final(text);await f.policy.idle();
 assert(f.payloads.every(b=>(b.markdown?.content??b.content_raw).length<=4500),'adapter emitted an oversized payload');
 const output=streaming?f.payloads.filter(b=>b.input_state===StreamInputState.DONE).map(b=>b.content_raw).join(''):f.payloads.map(b=>b.markdown.content).join('');assert.equal(output,text);
});
test('Q02 streams share the same four-reply budget as static sends',async t=>{
 const f=fixture(t,{streaming:true});for(let i=0;i<6;i++){f.final('第'+i+'个工具步骤的完整回应');await f.policy.idle();}
 assert(f.payloads.filter(b=>b.input_state===StreamInputState.GENERATING&&b.msg_id).length<=4,'six independent passive streams bypassed ReplyLimiter');
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
test('Q05 SDK throttled text stays unsent when output is canceled',async t=>{
 const f=fixture(t,{streaming:true});f.policy.text('已经发送的前缀');f.policy.update(f.policy.message);await f.policy.idle();
 f.policy.text('取消前仍在SDK缓冲中的尾巴');f.policy.update(f.policy.message);await f.policy.idle();
 const before=f.payloads.length;f.policy.stopOutput();await f.policy.idle();assert(!f.payloads.slice(before).some(b=>b.content_raw.includes('尾巴')));
});
test('Q06 a known rate-limit rejection cannot retry new content after stop',async t=>{
 let calls=0;const f=fixture(t,{streaming:true,onRequest:()=>{if(++calls===1)throw Object.assign(Error('rate limit'),{code:429});}});
 f.policy.text('应该取消的SDK重试');f.policy.update(f.policy.message);await micro();assert.equal(calls,1);f.policy.stopOutput();await f.policy.idle();assert.equal(calls,1,'SDK retried and completed after stop');
});
test('Q07 SDK stream failure must still carry the committed suffix or signal undelivered result',async t=>{
 let calls=0;const f=fixture(t,{streaming:true,onRequest:()=>{if(++calls===1)throw Object.assign(Error('fixture rejection before delivery'),{delivery:'rejected'});}});
 f.policy.text('前缀');f.policy.update(f.policy.message);await f.policy.idle();f.policy.text('最终尾巴');f.final('前缀最终尾巴');await f.policy.idle();
 assert(f.payloads.some(b=>b.content_raw==='前缀最终尾巴'));
});
test('Q08 successful static and SDK stream controls preserve a 4500-character result',async t=>{
 for(const streaming of [false,true]){const f=fixture(t,{streaming}),text='长'.repeat(4500);f.final(text);await f.policy.idle();assert.equal(f.payloads.at(-1).markdown?.content??f.payloads.at(-1).content_raw,text);}
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
 const stream=new StreamSession({}, {openid:'fixture',msgId:'fixture',creds:{}});
 assert.equal(stream.isRateLimitError(new ApiError('请求过于频繁',429,'/fixture',50002)),true);
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
const fixtureSource=support.slice(support.indexOf('function middleware('),support.indexOf("test('explicit correction"));
const middlewareFixture=vm.runInNewContext(fixtureSource+'\n;middleware;',{fs,vm,assert,URL,base:new URL('../qqbot-src/dist/gateway/',import.meta.url)});
test('Q13 generic correction refreshes reply target without Character admission hook',async()=>{
 const f=middlewareFixture();f.record.replyTarget={scope:'c2c',targetId:'owner',msgId:'old'};
 await f.run('更正：保留文件',{message:{kind:'c2c',senderId:'owner',messageId:'new',content:'更正：保留文件'}});assert.equal(f.record.replyTarget.msgId,'new');
});
test('Q14 native stop remains available if a reloading policy service cannot resolve its Agent',async()=>{
 const f=middlewareFixture();f.manager.ctx.get=()=>({serviceFor:()=>({get(){throw Error('Agent outside Interaction scope');}})});
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

test('Q16 cancellation during a settled long static send suppresses remaining protocol chunks',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=fixture(t,{onRequest:()=>gate});
 f.final('字'.repeat(10001));await micro();assert.equal(f.payloads.length,1);f.policy.stopOutput();release();await f.policy.idle();assert.equal(f.payloads.length,1);
});

test('Q17 cancellation reaches an in-flight committed stream retry',async t=>{
 let calls=0;const f=fixture(t,{streaming:true,onRequest:()=>{calls++;throw Object.assign(Error('rate limit'),{code:429});}});
 f.final('最终结果');await micro();assert.equal(calls,1);f.policy.stopOutput();await f.policy.idle();assert.equal(calls,1);
});

test('Q18 a long uncommitted stream never completes overflow bubbles',async t=>{
 const f=fixture(t,{streaming:true});f.policy.text('草'.repeat(10001));f.policy.update(f.policy.message);await f.policy.idle();
 assert(!f.payloads.some(b=>b.input_state===StreamInputState.DONE));assert(f.payloads.every(b=>b.content_raw.length<=4500));
 f.policy.stopOutput();await f.policy.idle();assert(!f.payloads.some(b=>b.input_state===StreamInputState.DONE));
});
test('QQ lifecycle configuration parses through the installed Host schema and remains opt-in',()=>{
 const legacy=ConfigSchema({});assert.deepEqual(legacy.sessionLifecycle,{enabled:false,freshOnHostRestart:true,inactivityMs:43200000});
 const enabled=ConfigSchema({sessionLifecycle:{enabled:true}});assert.equal(enabled.sessionLifecycle.inactivityMs,43200000);assert.equal(enabled.sessionLifecycle.freshOnHostRestart,true);
 assert.throws(()=>ConfigSchema({sessionLifecycle:{enabled:true,inactivityMs:0}}));
});
