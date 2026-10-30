// QQ Official plain-text outbound through the Unified Agent I/O. Runs the
// reviewed sources (patched outbound router and buffer, gateway sender and
// adapter registration, reply target/limiter, QQ text adapter) against a fake
// QQ bot. Proves wiring and semantics, not QQ network delivery or phone receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';

const dist=new URL('./qqbot-src/dist/',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,dist),'utf8').replaceAll('\r\n','\n');
const strip=source=>source.replace(/^import [^;]*;\n/gm,'').replace(/^export (?=(?:async )?function|class|const)/gm,'');
const load=(file,names,context={})=>vm.runInNewContext(strip(read(file))+`\n;({${names}})`,context);
const slice=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,start);return source.slice(a,b);};
const tick=async(n=5)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};

const adapterModule=load('transport/qq-text-adapter.js','QQ_OFFICIAL,qqConversation,classifyQQError,createQQTextAdapter');
const {ReplyLimiter}=load('transport/reply-limiter.js','ReplyLimiter');
const {resolveReplyTarget,sendResolvedMarkdown}=load('transport/reply-target.js','resolveReplyTarget,sendResolvedMarkdown',{MsgType:{MARKDOWN:2},getCachedReplyIds:()=>[]});
// Real chunker when a validation profile is present (same resolution as the
// approval tests); otherwise a line-based stand-in.
const profile=process.env.QQBOT_TEST_PROFILE??fileURLToPath(new URL('../data/profiles/qqbot-validation/',import.meta.url));
const chunkerFile=path.join(profile,'node_modules/@tencent-connect/dsh-qqbot/dist/transport/chunker.js');
const realChunker=fs.existsSync(chunkerFile)?vm.runInNewContext(strip(fs.readFileSync(chunkerFile,'utf8').replaceAll('\r\n','\n'))+'\n;chunkMarkdownText'):null;
const lineChunker=(text,limit)=>{const out=[];let cur='';for(const line of text.split('\n')){const next=cur?cur+'\n'+line:line;if(cur&&next.length>limit){out.push(cur);cur=line;}else cur=next;}if(cur)out.push(cur);return out.length?out:[text];};

class ApiError extends Error{name='ApiError';constructor(status){super('API Error [/v2/users/OPENID/messages]');this.httpStatus=status;this.path='/v2/users/OPENID/messages';}}
function fakeBot(){
 const sent=[],failures=[],gates=[];
 const deliver=async(entry)=>{const gate=gates.shift();if(gate)await gate;sent.push(entry);const failure=failures.shift();if(failure)throw failure;return {id:'qq-'+sent.length};};
 return {sent,failures,gates,streams:[],
  sendMarkdown:(target,content)=>deliver({msgId:target.msgId,eventId:undefined,targetId:target.targetId,content}),
  send:opts=>deliver({msgId:undefined,eventId:opts.extra?.event_id,targetId:opts.target.targetId,content:opts.markdown.content}),
  openStream(){throw Error('SDK stream is not used by these fixtures');}};
}
function gateway({io=createAgentIO(),appId='app-a',policy,streaming=false,limit=4500,chunker=lineChunker,writer,recorder}={}){
 const source=read('gateway/bootstrap.js'),bot=fakeBot(),logs=[],cleanups=[];
 const record={sessionKey:'qqbot:'+appId+':c2c:owner',sessionId:'s1',agent:{},replyTarget:{scope:'c2c',targetId:'owner',msgId:'m1'},scope:'c2c',peerId:'owner'};
 const sessions=new Map([['c2c:owner',record]]);
 const manager={getSessionRecord:(scope,peer)=>sessions.get(scope+':'+peer),findBySessionId:id=>[...sessions.values()].find(r=>r.sessionId===id),approvalChannel:{pending:new Map()},questionChannel:{pending:new Map()}};
 const logger={info(){},debug(){},warn:m=>logs.push(['warn',m]),error:m=>logs.push(['error',m])};
 const config={appId,streaming,textChunkLimit:limit,showToolResults:false};
 const ctx={get:name=>name==='agentPresets'?{serviceFor:()=>policy?{get:()=>policy}:undefined}:undefined,effect:f=>cleanups.push(f())};
 const chunkMarkdownText=(text,max)=>chunker(text,max);
 // The gateway's own sender and adapter registration, exactly as reviewed.
 const wiring=slice(source,'    const replyLimiter = new ReplyLimiter({ limit: 4 });','    // Optional Agent policy. No Character');
 const {sender,diagnostics}=vm.runInNewContext('(function(){'+wiring+';return {sender,diagnostics};})()',{
  ReplyLimiter,deliveryRecorder:recorder,bot,randomUUID:()=>'00000000-0000-4000-8000-000000000000',resolveReplyTarget,sendResolvedMarkdown,io,createQQTextAdapter:adapterModule.createQQTextAdapter,config,manager,chunkMarkdownText,ctx});
 // The original outbound router and buffer with their patched static send.
 class StreamingWriter{constructor(deps){this.deps=deps;this.text='';(writer??={}).instances=[...(writer.instances??[]),this];}append(t){this.text+=t;}async finish(){this.finished=true;}get shouldFallback(){return writer?.fallback===true;}abort(){}}
 const {OutboundBuffer}=load('transport/outbound-buffer.js','OutboundBuffer',{StreamingWriter});
 const {createOutboundHandler}=load('transport/outbound.js','createOutboundHandler',{OutboundBuffer,formatToolResult:name=>`工具 ${name} 失败`,parseEvent:e=>e,extractTurnError:r=>r?.error});
 const body=slice(source,'    const policyFor =','    return outboundHandler;');
 const handler=vm.runInNewContext('(function(){'+body+';return outboundHandler;})()',{
  ctx,manager,sender,config,logger,toolsRegistry:undefined,diagnostics,io,createOutboundHandler,chunkMarkdownText,QQ_OFFICIAL:adapterModule.QQ_OFFICIAL,qqConversation:adapterModule.qqConversation});
 const emit=event=>handler({header:{id:record.sessionId}},event);
 return {io,bot,logs,record,sessions,manager,emit,writer,cleanups,diagnostics,sender};
}
const reply=text=>({type:'assistant/message',content:[{type:'text',text}]});

test('a plain Agent reply without Interaction reaches QQ once through the Unified I/O',async()=>{
 const g=gateway();g.emit(reply('你好'));await tick();
 assert.deepEqual(g.bot.sent,[{msgId:'m1',eventId:undefined,targetId:'owner',content:'你好'}]);assert.deepEqual(g.logs,[]);
});
test('streamed chunks, the final message and turn end produce exactly one send',async()=>{
 const g=gateway();for(const t of ['你','好'])g.emit({type:'assistant/chunk',text:t});g.emit(reply('你好'));g.emit({type:'turn/end'});await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['你好']);
});
test('the QQ adapter chunks long text, keeps order and falls back to proactive after the passive quota',async()=>{
 const lines=Array.from({length:6},(_,i)=>String(i).repeat(40));const g=gateway({limit:50});
 g.emit(reply(lines.join('\n')));await tick(20);
 assert.deepEqual(g.bot.sent.map(s=>s.content),lines);
 assert.deepEqual(g.bot.sent.map(s=>s.msgId),['m1','m1','m1','m1',undefined,undefined],'four passive replies per msg_id, then proactive');
 const h=gateway({limit:50});h.emit(reply('x'.repeat(120)));await tick(10);
 assert.deepEqual(h.bot.sent.map(s=>s.content.length),[50,50,20],'one long line is cut at the platform limit');
 const pair=gateway({limit:50});pair.emit(reply('a'.repeat(49)+'😀'+'b'));await tick(10);
 assert.deepEqual(pair.bot.sent.map(s=>s.content),['a'.repeat(49),'😀b'],'a surrogate pair is never split');
});
test('with the installed markdown chunker, parts stay within the limit and rebuild the text in order',{skip:realChunker?false:'no validation profile with the installed chunker'},async()=>{
 const table='| a | b |\n| - | - |\n| 1 | 2 |',code='```js\n'+Array.from({length:4},(_,i)=>'line'+i).join('\n')+'\n```';
 const text=['前言'.repeat(10),table,code,'后记'.repeat(10),'长'.repeat(90)].join('\n');
 const g=gateway({limit:40,chunker:realChunker});g.emit(reply(text));await tick(30);
 const parts=g.bot.sent.map(s=>s.content);assert(parts.length>2);assert(parts.every(p=>p.length<=40));
 assert.equal(parts.join('').replaceAll('\n',''),text.replaceAll('\n',''));assert(parts.some(p=>p.includes(table)),'a short table is never split across parts');
});
test('tool errors and turn errors use the same ordered path',async()=>{
 const g=gateway();g.emit({type:'tool/call',callId:'c1',name:'read',arguments:'{}'});g.emit({type:'tool/result',callId:'c1',error:'denied',raw:{}});
 g.emit({type:'turn/end',reason:{error:{code:'MODEL_ERROR',message:'fixture'}}});await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['工具 read 失败','⚠️ 本轮异常结束\n`MODEL_ERROR`: fixture']);
});
test('a QQ rejection is not-sent and an unknown outcome is not resent; later replies still go out',async()=>{
 const g=gateway();g.bot.failures.push(new ApiError(400));g.emit(reply('被拒'));await tick();
 g.bot.failures.push(new ApiError(0));g.emit(reply('超时'));await tick();
 g.bot.failures.push(new ApiError(502));g.emit(reply('网关'));await tick();
 g.emit(reply('之后'));await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['被拒','超时','网关','之后'],'each attempted exactly once');
 assert.deepEqual(g.logs,[['warn','im-qqbot: sendMarkdown not-sent (platform-rejected)'],['warn','im-qqbot: sendMarkdown unknown (timeout-or-network)'],['warn','im-qqbot: sendMarkdown unknown (platform-unavailable)']]);
 assert(!JSON.stringify(g.logs).includes('OPENID'),'no API path or identifier in the log');
});
test('a reply queued behind a rotated Session is not delivered to the new Session',async()=>{
 const g=gateway();let open;g.bot.gates.push(new Promise(r=>open=r));
 g.emit(reply('第一条'));g.emit(reply('旧会话的迟到回复'));await tick();
 g.sessions.set('c2c:owner',{...g.record,sessionId:'s2'});open();await tick();
 assert.deepEqual(g.bot.sent.map(s=>s.content),['第一条']);assert.deepEqual(g.logs,[['warn','im-qqbot: sendMarkdown not-sent (stale)']]);
 g.sessions.delete('c2c:owner');g.emit(reply('已移除'));await tick();assert.equal(g.bot.sent.length,1);
});
test('with Interaction bound, tool errors stay on the policy channel and the I/O is not used',async()=>{
 const external=[],policy={bind(t){this.transport=t;},event(){},external:async(t,m)=>external.push([t,m.kind])};
 const io=createAgentIO(),calls=[];const spy={...io,sendMessage:r=>{calls.push(r);return io.sendMessage(r);},registerAdapter:io.registerAdapter};
 const g=gateway({io:spy,policy});g.emit({type:'turn/start'});g.emit({type:'tool/call',callId:'c1',name:'read',arguments:'{}'});g.emit({type:'tool/result',callId:'c1',error:'x',raw:{}});await tick();
 assert.deepEqual(external,[['工具 read 失败','tool-or-error']]);assert.equal(calls.length,0);assert.equal(g.bot.sent.length,0);
 // Interaction's own static bubbles are unchanged in this slice (gateway sender).
 await policy.transport.sendText('气泡',{});assert.deepEqual(g.bot.sent.map(s=>s.content),['气泡']);
});
test('the SDK stream path is not migrated; only its static fallback goes through the I/O',async()=>{
 const streamed=gateway({streaming:true,writer:{fallback:false}});streamed.emit({type:'assistant/chunk',text:'流'});streamed.emit(reply('流'));await tick();
 assert.equal(streamed.bot.sent.length,0);assert.equal(streamed.writer.instances[0].finished,true);
 const fallback=gateway({streaming:true,writer:{fallback:true}});fallback.emit({type:'assistant/chunk',text:'降级'});fallback.emit(reply('降级'));await tick();
 assert.deepEqual(fallback.bot.sent.map(s=>s.content),['降级']);
});
test('two QQ applications on one I/O keep separate adapters, queues and targets',async()=>{
 const io=createAgentIO(),a=gateway({io,appId:'app-a'}),b=gateway({io,appId:'app-b'});
 let open;a.bot.gates.push(new Promise(r=>open=r));a.emit(reply('给 A'));b.emit(reply('给 B'));await tick();
 assert.deepEqual(b.bot.sent.map(s=>s.content),['给 B'],'B is not blocked by A');open();await tick();
 assert.deepEqual(a.bot.sent.map(s=>s.content),['给 A']);
 assert.throws(()=>gateway({io,appId:'app-a'}),/already registered/,'one active adapter per QQ application');
});
test('a group Conversation maps to the QQ group scope and its own record',async()=>{
 const g=gateway();g.sessions.clear();const group={...g.record,scope:'group',peerId:'grp',replyTarget:{scope:'group',targetId:'grp',msgId:'g1'}};g.sessions.set('group:grp',group);
 assert.deepEqual({...adapterModule.qqConversation(group)},{type:'group',id:'grp'});
 const r=await g.io.sendMessage({target:{platform:'qq-official',accountId:'app-a',conversation:{type:'group',id:'grp'}},origin:{sessionId:'s1'},message:{text:'群消息'}});
 assert.equal(r.status,'sent');assert.deepEqual(g.bot.sent,[{msgId:'g1',eventId:undefined,targetId:'grp',content:'群消息'}]);
 const wrong=await g.io.sendMessage({target:{platform:'qq-official',accountId:'app-a',conversation:{type:'direct',id:'grp'}},origin:{sessionId:'s1'},message:{text:'x'}});
 assert.equal(wrong.reason,'stale','a direct target never resolves to a group record');
});
test('delivery diagnostics carry the Session hash and part index, never text',async()=>{
 const rows=[],recorder={hash:v=>v===undefined?undefined:'c'.repeat(24),trace:(e,f)=>rows.push([e,f])};
 const g=gateway({recorder,limit:50});g.emit(reply('秘密'.repeat(30)));await tick(10);
 const requests=rows.filter(([e])=>e==='static-request').map(([,f])=>f);
 assert.deepEqual(requests.map(f=>[f.session,f.index]),[['c'.repeat(24),0],['c'.repeat(24),1]]);
 assert(!JSON.stringify(rows).includes('秘密'));assert(rows.some(([e])=>e==='static-receipt'));
});
test('QQ error classification only treats a 4xx refusal as not sent',()=>{
 const c=adapterModule.classifyQQError;
 assert.deepEqual([0,408,429,400,403,500,503,200].map(s=>[s,c(new ApiError(s)).outcome]),[[0,'unknown'],[408,'unknown'],[429,'not-sent'],[400,'not-sent'],[403,'not-sent'],[500,'unknown'],[503,'unknown'],[200,'unknown']]);
 assert.equal(c(new Error('socket hang up')).outcome,'unknown');assert.equal(c(undefined).outcome,'unknown');
});
test('the QQ plugin declares the agentIO service and the gateway refuses to start without it',()=>{
 assert.match(read('index.js'),/inject = \['agents', 'conversationManager', 'agentIO'\]/);
 assert.match(read('gateway/bootstrap.js'),/if \(!io\) throw new Error\('Install and configure dsh-agent-io before QQ'\)/);
 // The original router no longer holds a direct static sender.
 for(const file of ['transport/outbound.js','transport/outbound-buffer.js'])assert(!/\.sendMarkdown\(|chunkMarkdownText/.test(strip(read(file)).replace(/\/\*\*[\s\S]*?\*\//g,'')),file);
});
