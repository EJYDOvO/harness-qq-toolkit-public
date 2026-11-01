// QQ Official ordinary chat inbound through the Unified Agent I/O. Runs the
// reviewed inbound source (Adapter normalization, handleInbound and the
// trusted Conversation entry deliverInbound) on the real I/O core, behind the
// installed SDK middlewares when a validation profile is present. Fake QQ
// events, Manager and Agents: proves wiring and admission, not QQ delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {qqAdapter,qqConversation} from './qq-conversation-fixture.mjs';

const dist=new URL('./qqbot-src/dist/',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,dist),'utf8').replaceAll('\r\n','\n');
const strip=source=>source.replace(/^import [^;]*;\n/gm,'').replace(/^export (?=(?:async )?function|class|const)/gm,'');
const tick=async(n=5)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const {QQ_OFFICIAL,QQ_SCOPES}=qqAdapter;
const inbound=vm.runInNewContext(strip(read('transport/inbound.js'))+'\n;({normalizeQQMessage,handleInbound,deliverInbound})',{
 QQ_SCOPES,classifyContentType:()=>'file',isVoiceContentType:()=>false,clearGroupHistory(){},setInterval:()=>0,clearInterval(){},
});
// The installed SDK middlewares (access, @ gate, commands, merge) when available.
const profile=process.env.QQBOT_TEST_PROFILE??fileURLToPath(new URL('../data/profiles/qqbot-validation/',import.meta.url));
const sdkFile=path.join(profile,'node_modules/@tencent-connect/qqbot-nodejs/dist/middleware/index.js');
const sdk=fs.existsSync(sdkFile)?await import(pathToFileURL(sdkFile).href):null;
const needsSdk={skip:sdk?false:'no validation profile with the installed SDK middlewares'};
// The reviewed QQ command gate and spec mapping (middleware-setup.js).
const {qqCommand,commandGate}=vm.runInNewContext(strip(read('gateway/middleware-setup.js'))+';({qqCommand,commandGate})',{});

function agent(id){
 const a={id,status:'idle',received:[],followup(m){a.received.push(m);},whenIdle:()=>a.idle??Promise.resolve()};return a;
}
// A fake Conversation Manager handle: one record per Conversation, optional rotation and failure.
function manager(){
 const records=new Map(),history=[],m={calls:[],history,fail:null,policy:undefined,registered:[],
  async getOrCreate(scope,peer,sender,target){m.calls.push({scope,peer,sender,target});if(m.fail)throw m.fail;
   const key=scope+':'+peer;let r=records.get(key);if(!r||m.rotate){m.rotate=false;r={sessionKey:key,sessionId:'s'+(records.size+1)+'-'+m.calls.length,agent:agent('a-'+m.calls.length),scope,peerId:peer,replyTarget:target};records.set(key,r);history.push(r);}
   r.replyTarget=target;return r;},
  getSessionRecord:(scope,peer)=>records.get(scope+':'+peer),trackInteractionInput:(r,msg)=>m.registered.push(msg.id),records,
  isCurrentSession:r=>records.get(r.scope+':'+r.peerId)===r};
 return m;
}
const owner={c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'disabled',groupAllow:[]};
function gateway({io=createAgentIO(),appId='app-a',access=owner,commands=[]}={}){
 const mgr=manager(),logs=[],config={appId,access,requireMention:true},logger={info(){},debug:m=>logs.push(['debug',m]),warn:m=>logs.push(['warn',m]),error:m=>logs.push(['error',m])};
 // The same wiring as bootstrapGateway: one Conversation wiring and channel per QQ application.
 const conversation=qqConversation({io,manager:mgr,config,policy:()=>mgr.policy});
 const channel=conversation.openInbound(s=>inbound.deliverInbound(s,conversation,config,logger));
 // Commands: the Agent I/O router of this wiring behind the reviewed QQ gate.
 const router=conversation.openCommands({prefixes:['/']});for(const c of commands)router.register(qqCommand(c));const gate=commandGate(router);
 const replies=[],typing=[];
 conversation.registerAdapter({split:t=>[t],async send(route,text){if(!route.inputReply)throw Error('unexpected output');replies.push(text);}});
 const final=ctx=>inbound.handleInbound(ctx,logger,channel);
 const chain=sdk?[sdk.messageFilter({skipSelfEcho:false}),sdk.accessPolicy({c2c:{mode:access.c2cMode,allow:access.c2cAllow},group:{mode:access.groupMode,allow:access.groupAllow}}),sdk.mentionGate({requireMentionInGroup:true}),gate,sdk.concurrencyGuard({strategy:'merge',maxQueue:10})]:[];
 const event=({kind='c2c',sender='owner',group,id='msg-1',content='你好',attachments=[],mention=false}={})=>{
  const target={scope:kind==='group'?'group':'c2c',targetId:kind==='group'?group:sender,msgId:id};
  return {message:{kind,senderId:sender,groupOpenid:group,messageId:id,content,attachments,senderIsBot:false,replyTarget:target,...(mention?{rawEventType:'GROUP_AT_MESSAGE_CREATE'}:{})},
   replyTarget:target,state:{},log:{debug(){},info(){},warn(){},error(){}},stop(reason){this.stopped=reason;},abort(){},
   bot:{sendText:async(_t,c)=>replies.push(c),sendMarkdown:async(_t,c)=>replies.push(c),sendTyping:async()=>typing.push(1)}};
 };
 // Full SDK middleware chain, then the message handler (bot.on('message')).
 const push=async options=>{const ctx=event(options);let i=0;const next=async()=>{if(ctx.stopped)return;const mw=chain[i++];return mw?mw(ctx,next):final(ctx);};await next();return ctx;};
 const direct=options=>final(event(options)); // a re-delivery the SDK filter no longer remembers (another Gateway, or after it purged the id)
 return {io,mgr,conversation,channel,logs,replies,push,direct,event,config,logger};
}
const all=g=>g.mgr.history.flatMap(r=>r.agent.received);
const texts=g=>all(g).map(m=>m.content[0].text);

test('ordinary QQ text reaches the right Agent through the Unified I/O channel as a native user input',async()=>{
 const g=gateway();await g.direct({id:'msg-1',content:'今天怎么样'});
 assert.deepEqual(texts(g),['今天怎么样']);assert.equal(all(g)[0].source.kind,'user');
 assert.deepEqual(JSON.parse(JSON.stringify(g.mgr.calls)),[{scope:'c2c',peer:'owner',sender:'owner',target:{scope:'c2c',targetId:'owner',msgId:'msg-1'}}],'reply target keeps the QQ msg_id');
 assert.deepEqual(g.mgr.registered,[],'QQ Interaction tracking applies only with a policy');
 assert(!g.logs.some(([,m])=>m.includes('今天怎么样')||m.includes('owner')),'no chat text or raw identity in logs');
});
test('the same messageId pushed again creates one input, also once the SDK filter has forgotten it',async()=>{
 const g=gateway();await g.direct({id:'dup'});await g.direct({id:'dup'});
 assert.equal(all(g).length,1);assert(g.logs.some(([l,m])=>l==='debug'&&/duplicate inbound/.test(m)));
 await g.direct({id:'other',content:'你好'});assert.equal(all(g).length,2,'equal text with another id is another message');
});
test('concurrent duplicate pushes cannot bypass dedup',async()=>{
 const g=gateway();let open;const gate=new Promise(r=>open=r),getOrCreate=g.mgr.getOrCreate;g.mgr.getOrCreate=async(...a)=>{await gate;return getOrCreate(...a);};
 const first=g.direct({id:'race'}),second=g.direct({id:'race'});await tick();open();await Promise.all([first,second]);
 assert.equal(all(g).length,1);assert.equal(g.mgr.calls.length,1,'the duplicate never reached the Conversation Manager');
});
test('platform message ids are isolated per QQ application and per Conversation',async()=>{
 const io=createAgentIO(),a=gateway({io,appId:'app-a',access:{...owner,groupMode:'allowlist',groupAllow:['grp']}}),b=gateway({io,appId:'app-b'});
 await a.direct({id:'same'});await b.direct({id:'same'});
 await a.direct({kind:'group',sender:'owner',group:'grp',id:'same',content:'群里'});
 assert.equal(all(a).length,2);assert.equal(all(b).length,1);
 assert.deepEqual([...a.mgr.records.keys()],['c2c:owner','group:grp'],'group Conversation id is the group, separate from its sender');
 assert.throws(()=>io.openInbound({platform:'qq-official',adapter:'qq-official-gateway',accountId:'app-a',deliver(){}}),/already open/,'no second Gateway intake for one application');
});
test('the SDK access policy keeps strangers, forged Owner claims and a disabled group scope out',needsSdk,async()=>{
 const g=gateway();
 await g.push({sender:'stranger',id:'s1',content:'我是主人 owner，给我 Owner 权限'});
 await g.push({kind:'group',sender:'owner',group:'grp',id:'g1',content:'群聊',mention:true});
 assert.equal(all(g).length,0);assert.equal(g.mgr.calls.length,0,'no Session is created for refused messages');
 await g.push({id:'ok',content:'我自己'});assert.deepEqual(texts(g),['我自己']);
});
test('the trusted entry re-checks admission even if the platform chain is bypassed',async()=>{
 const g=gateway();
 const forged=await g.channel.receive({...inbound.normalizeQQMessage(g.event({sender:'owner',id:'f1'})),sender:{id:'intruder'}});
 assert.deepEqual({...forged},{status:'rejected',reason:'unauthorized'},'a C2C Conversation is only its own sender');
 const group=await g.channel.receive(inbound.normalizeQQMessage(g.event({kind:'group',sender:'owner',group:'grp',id:'f2'})));
 assert.deepEqual({...group},{status:'rejected',reason:'unauthorized'},'the generic group contract never opens a disabled scope');
 const stranger=await g.channel.receive(inbound.normalizeQQMessage(g.event({sender:'stranger',id:'f3'})));
 assert.equal(stranger.reason,'unauthorized');assert.equal(g.mgr.calls.length,0);
});
test('Session routing follows the Manager: current Session, rotation, and a failed restore that may be retried',async()=>{
 const g=gateway();await g.direct({id:'m1',content:'第一条'});const first=[...g.mgr.records.values()][0];
 g.mgr.rotate=true;await g.direct({id:'m2',content:'轮换后'});const second=[...g.mgr.records.values()][0];
 assert.notEqual(first.sessionId,second.sessionId);assert.deepEqual(first.agent.received.map(m=>m.content[0].text),['第一条']);assert.deepEqual(second.agent.received.map(m=>m.content[0].text),['轮换后']);
 // An Owner-only wrapper or a failed restore throws before any input: the user is told, nothing reaches an Agent.
 g.mgr.fail=Error('Owner-only gateway');await g.direct({id:'m3',content:'失败'});
 assert.equal(all(g).length,2);assert.deepEqual(g.replies,['⚠️ 处理消息时出现异常，请稍后重试。']);assert(g.logs.some(([l,m])=>l==='warn'&&m==='im-qqbot: inbound failed (session-unavailable)'));
 g.mgr.fail=null;await g.direct({id:'m3',content:'失败'});assert.equal(all(g).length,3,'a proven non-handoff can be re-delivered once');
});
test('with Interaction, input during a run is an intervention once; without it, a native followup that holds until idle',async()=>{
 const g=gateway(),interventions=[],admitted=[];g.mgr.policy={intervene:m=>interventions.push(m.content[0].text),admitInput:m=>admitted.push(m.id)};
 await g.direct({id:'i0',content:'开始'});const record=[...g.mgr.records.values()][0];record.agent.status='running';
 await g.direct({id:'i1',content:'插话'});await g.direct({id:'i1',content:'插话'});
 assert.deepEqual(interventions,['插话']);assert.deepEqual(record.agent.received.map(m=>m.content[0].text),['开始'],'no second native input for the interjection');
 assert.equal(admitted.length,2);assert.deepEqual(g.mgr.registered,admitted,'each admitted input is tracked once on the QQ side, before the policy sees it');
 const h=gateway();let idle;const agentIdle=new Promise(r=>idle=r);
 await h.direct({id:'w0'});const r=[...h.mgr.records.values()][0];r.agent.idle=agentIdle;
 let done=false;const waiting=h.direct({id:'w1',content:'等待'}).then(()=>done=true);await tick();
 assert.equal(r.agent.received.length,2);assert.equal(done,false,'the handler waits for the turn as before');idle();await waiting;
});
test('/stop stays a command, attachments still reach the chat flow',needsSdk,async()=>{
 const stops=[],g=gateway({commands:[{name:'stop',hidden:true,handler:()=>{stops.push(1);return '已中止';}}]});
 await g.push({id:'c1',content:'/stop'});assert.deepEqual(stops,[1]);assert.equal(all(g).length,0,'never chat input');assert.deepEqual(g.replies,['已中止']);
 await g.push({id:'c2',content:'',attachments:[{content_type:'application/pdf',filename:'a.pdf',size:10}]});
 assert.equal(all(g).length,1);assert.match(texts(g)[0],/\[文件\]/);assert.match(texts(g)[0],/a\.pdf/);
});
test('/stop runs at once while the running Turn holds the merge guard, and only once',needsSdk,async()=>{
 const stops=[],g=gateway({commands:[{name:'stop',hidden:true,handler:()=>{stops.push(Date.now());return '已中止';}}]});
 let idle;const agentIdle=new Promise(r=>idle=r);
 await g.push({id:'t0',content:'开始'});
 const record=[...g.mgr.records.values()][0];record.agent.idle=agentIdle;
 // This input now waits in handleInbound for idle, holding the SDK merge guard;
 // the next one queues behind it.
 const running=g.push({id:'t1',content:'长任务'});await tick();
 const queued=g.push({id:'t2',content:'排队消息'});await tick();
 await g.push({id:'c1',content:'/stop'});
 assert.equal(stops.length,1,'/stop executed while the guard is held');
 assert.deepEqual(texts(g),['开始','长任务'],'the command is not Agent input and the queued message still waits');
 idle();await running;await queued;
 assert.deepEqual(texts(g),['开始','长任务','排队消息']);
 await g.push({id:'c1',content:'/stop'});assert.equal(stops.length,1,'a repeated /stop delivery is not executed again');
});
test('a command re-delivered past the command gate never becomes Agent input',needsSdk,async()=>{
 const runs=[],g=gateway({commands:[{name:'new',handler:()=>{runs.push(1);return '已开启新会话 ✓';}}]});
 const first=await g.push({id:'n1',content:'/new'});assert.equal(runs.length,1);assert.equal(first.stopped,'command:handled:new');
 await g.direct({id:'n1',content:'/new'});
 assert.equal(all(g).length,0,'the claimed message is a duplicate for the chat channel');assert.equal(runs.length,1);
});
test('unknown commands stay ordinary chat; an owner-only command refuses another admitted user without Agent input',needsSdk,async()=>{
 const access={c2cMode:'allowlist',c2cAllow:['owner','friend'],groupMode:'disabled',groupAllow:[]};
 const ops=[],g=gateway({access,commands:[{name:'ops',scope:'c2c',authorized:c=>(c.message.kind==='c2c'&&c.message.senderId==='owner')||'仅部署所有者可执行运维命令。',handler:c=>{ops.push(c.command.args);return 'ok';}}]});
 await g.push({id:'u1',content:'/unknown 参数'});assert.deepEqual(texts(g),['/unknown 参数'],'compatible: unknown commands reach the Agent');
 const denied=await g.push({id:'o1',sender:'friend',content:'/ops status'});
 assert.equal(denied.stopped,'command:denied:ops','the gate itself ends the chain for a refused command');
 assert.deepEqual(ops,[]);assert.equal(all(g).length,1);assert.deepEqual(g.replies,['仅部署所有者可执行运维命令。']);
 await g.push({id:'o2',content:'/ops status now'});assert.equal(JSON.stringify(ops),JSON.stringify([['status','now']]));assert.equal(g.replies.at(-1),'ok');
 await g.push({id:'s1',sender:'stranger',content:'/ops status'});assert.equal(ops.length,1,'the SDK access policy keeps strangers out first');
});
test('the replaced path: no SDK slashCommand, the command gate sits before the merge guard',()=>{
 const source=read('gateway/middleware-setup.js').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
 assert(!/slashCommand/.test(source),'commands no longer use the SDK middleware');
 const gate=source.indexOf('bot.use(commandGate(router))'),merge=source.indexOf('bot.use(concurrencyGuard(');
 assert(gate>0&&merge>gate,'/stop is handled before the merge guard');
 assert(source.indexOf('conversation.openCommands(')>0);
});
test('closing the channel on Gateway disposal leaves no live intake; a reloaded Gateway takes over',async()=>{
 const io=createAgentIO(),g=gateway({io});g.channel.close();await g.direct({id:'late'});
 assert.equal(all(g).length,0);assert(g.logs.some(([,m])=>m==='im-qqbot: inbound rejected (closed)'));
 g.conversation.close();const reloaded=gateway({io});await reloaded.direct({id:'late'});assert.equal(all(reloaded).length,1);
 const bootstrap=read('gateway/bootstrap.js');
 assert.match(bootstrap,/const conversation = io\.openConversation\(\{ platform: QQ_OFFICIAL, adapter: 'qq-official-gateway', accountId: config\.appId, manager, scopes: QQ_SCOPES,/);
 assert.match(bootstrap,/const inbound = conversation\.openInbound\(standard => deliverInbound\(standard, conversation, config, logger\)\);/);
 assert.match(bootstrap,/ctx\.effect\(\(\) => inbound\.close\);/);assert.match(bootstrap,/ctx\.effect\(\(\) => conversation\.close\);/);assert.match(bootstrap,/await handleInbound\(mCtx, logger, inbound\);/);
 assert(!/io\.openInbound\(|io\.registerAdapter\(/.test(bootstrap),'QQ opens no channel or adapter beside its Conversation wiring');
});
test('the replaced path: the message handler never creates Agent input itself, and the I/O stays platform-neutral',()=>{
 const source=read('transport/inbound.js'),handler=source.slice(source.indexOf('export async function handleInbound'),source.indexOf('export async function deliverInbound'));
 assert(handler.includes('channel.receive(standard)'));
 // The Session lookup, current-Session check and native input now live only in the shared wiring.
 const code=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
 assert(!/\.followup\(|getOrCreate\(|isCurrentSession|\.intervene\(|createUserMessage|registerInteractionInput|interactionPolicy/.test(code));
 assert(source.includes('conversation.handoff(standard, { replyTarget, content: agentBody })'));
 assert(!/body="|peerId=\$\{|key=\$\{scope\}:\$\{peerId\}/.test(source),'no chat text or raw peer id in the Processing/followup logs');
 const core=fs.readFileSync(new URL('../plugin-sources/dsh-agent-io/io.mjs',import.meta.url),'utf8');
 assert.deepEqual(core.match(/^import .*$/gm),["import {createHash} from 'node:crypto';","import {createDiagnostics} from './diagnostics.mjs';"]);
});

// ── Serialization and lifecycle races (deterministic: controlled promises) ──
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const blocking=(inputs,gate,fail)=>{let n=0;return {calls:()=>n,async getOrCreate(scope,peer){n++;if(n===1){await gate.promise;if(fail)throw Error('fixture restore failed');}
 const r={sessionKey:scope+':'+peer,sessionId:'s',scope,peerId:peer,agent:{status:'idle',followup:m=>inputs.push(m),whenIdle:()=>Promise.resolve()}};this.current=r;return r;},getSessionRecord(){return this.current;},isCurrentSession(r){return r===this.current;}};};
test('the SDK merge guard serializes one Conversation: a duplicate behind a failed handoff is delivered once, behind an accepted one it is suppressed',needsSdk,async()=>{
 for(const fail of [true,false]){
  const inputs=[],gate=deferred(),mgr=blocking(inputs,gate,fail),g=gateway(),config={appId:'app-a',access:owner},logger={info(){},debug(){},warn(){},error(){}};
  const conversation=qqConversation({io:createAgentIO(),manager:mgr,config}),channel=conversation.openInbound(s=>inbound.deliverInbound(s,conversation,config,logger));
  // The SDK filter has forgotten the id (another Gateway, or after its purge); the merge guard still runs.
  const guard=sdk.concurrencyGuard({strategy:'merge',maxQueue:10});
  const push=id=>{const ctx=g.event({id});return guard(ctx,()=>inbound.handleInbound(ctx,logger,channel));};
  const first=push('same');await tick();const second=push('same');await tick();
  assert.equal(mgr.calls(),1,'the duplicate waits in the guard, not inside the I/O');
  gate.resolve();await Promise.all([first,second]);
  assert.equal(inputs.length,1,'exactly one native input');
  assert.equal(mgr.calls(),fail?2:1,fail?'the released id was handed over again':'the settled id was suppressed');
 }
});

// The real Conversation Manager (fake Agents) behind the trusted entry.
const cmSource=file=>fs.readFileSync(new URL('../plugin-sources/dsh-conversation-manager/'+file,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export class /g,'class ')+'\n';
class SessionPersistenceNotFoundError extends Error{constructor(id){super('absent');this.name='SessionPersistenceNotFoundError';this.sessionId=id;}}
function conversationManager(t,order){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'qq-inbound-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const durable=new Set(),live=new Map();
 const PrefsStore=vm.runInNewContext(cmSource('preferences.mjs')+';PrefsStore;',{...fs,resolve:path.resolve,isAbsolute:path.isAbsolute,dirname:path.dirname,homedir:()=>home,process:{pid:process.pid,env:{DSH_HOME:home}},structuredClone});
 const handle=id=>{const a={id,status:'idle',session:{header:{id,agentPreset:'fixture'},events:[]},inbox:{hasPending:false},cancel(){order.push('cancel');},followup(){order.push('followup');},whenIdle:()=>Promise.resolve()};live.set(id,a);return {agent:a,async dispose(){order.push('dispose');live.delete(id);}};};
 const agents={get:id=>live.get(id),async create({sessionId}){return handle(sessionId);},async resume({resumeSessionId}){if(!durable.has(resumeSessionId))throw new SessionPersistenceNotFoundError(resumeSessionId);return handle(resumeSessionId);}};
 class ModelResolver{constructor(){this.prefs=new PrefsStore(undefined,path.join(home,'prefs.json'));}getEffectiveRoute(){return undefined;}getResumeRoute(){return undefined;}getPreset(k){return this.prefs.getPreset(k);}getSessionId(k){return this.prefs.getSessionId(k);}setSessionId(k,v){this.prefs.setSessionId(k,v);}}
 const IdleEvictor=vm.runInNewContext(cmSource('idle-evictor.mjs')+';IdleEvictor;',{Date,setInterval:()=>0,clearInterval(){}});
 const Manager=vm.runInNewContext(cmSource('manager.mjs')+';ConversationManager;',{ModelResolver,IdleEvictor,SessionPersistenceNotFoundError,SessionId:x=>x,buildForkSeed:r=>r,createHash,randomUUID,Date,structuredClone,process:{cwd:()=>home}});
 const ctx={on:()=>()=>{},get(name){if(name==='agentPresets')return {async resolve(id){return {id:id??'fixture'};},async mount(){}};if(name==='sessionPersistence')return {async open(id){throw new SessionPersistenceNotFoundError(id);}};if(name==='sessions')return {async flush(s){durable.add(s.header.id);return true;}};}};
 const config={appId:'app-a',cwd:home,sessionIdleTimeout:1,sessionLifecycle:{enabled:false},access:owner,adapter:{key:(scope,peer)=>'qqbot:app-a:'+scope+':'+peer,lifecycleScope:()=>false,acceptActivity:()=>true,isUserInput:t=>!!t?.msgId,inputId:t=>t?.msgId}};
 return {manager:new Manager(ctx,agents,config,{info(){},warn(){},debug(){},error(){}}),config};
}
const quiet={info(){},debug(){},warn(){},error(){}};
const standardFor=(g,id)=>{const s=inbound.normalizeQQMessage(g.event({id}));s.platformData.hold={};return s;};
test('Gateway disposal while an input waits for its Conversation: no input on the closing Session, the id is released',async t=>{
 for(const where of ['inside','behind']){
  const order=[],{manager,config}=conversationManager(t,order),g=gateway();
  await manager.getOrCreate('c2c','owner','owner',{scope:'c2c',targetId:'owner',msgId:'warm'});
  const gate=deferred();let held;
  if(where==='inside'){const drain=manager.drainSessionClosures.bind(manager);manager.drainSessionClosures=async(...a)=>{await gate.promise;return drain(...a);};}
  else held=manager.inConversation('qqbot:app-a:c2c:owner',()=>gate.promise); // a command, rotation or compaction
  const conversation=qqConversation({io:createAgentIO(),manager,config}),channel=conversation.openInbound(s=>inbound.deliverInbound(s,conversation,config,quiet));
  const first=channel.receive(standardFor(g,'race'));await tick();
  channel.close();const closing=manager.disposeAll();await tick();gate.resolve();await held;
  assert.deepEqual({...await first},{status:'failed',stage:'before-handoff',reason:'session-unavailable'},where);await closing;
  assert(!order.includes('followup'),where+': no native input');
 }
});
test('disposal between the Session lookup and the handoff: the entry re-checks the current Session instead of using a disposed one',async t=>{
 const order=[],{manager,config}=conversationManager(t,order),g=gateway();
 await manager.getOrCreate('c2c','owner','owner',{scope:'c2c',targetId:'owner',msgId:'warm'});
 let closing;const entry=Object.create(manager);entry.getOrCreate=async(...a)=>{const r=await manager.getOrCreate(...a);closing=manager.disposeAll();return r;};
 const conversation=qqConversation({io:createAgentIO(),manager:entry,config}),channel=conversation.openInbound(s=>inbound.deliverInbound(s,conversation,config,quiet));
 const result=await channel.receive(standardFor(g,'window'));await closing;
 assert.deepEqual({...result},{status:'failed',stage:'before-handoff',reason:'session-changed'});
 assert.deepEqual(order,['cancel','dispose'],'the disposed Agent received no input');
 assert.equal((await channel.receive(standardFor(g,'window'))).status,'failed','the id was released: a re-delivery is handled again');
});
