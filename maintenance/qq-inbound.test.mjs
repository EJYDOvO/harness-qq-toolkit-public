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
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';

const dist=new URL('./qqbot-src/dist/',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,dist),'utf8').replaceAll('\r\n','\n');
const strip=source=>source.replace(/^import [^;]*;\n/gm,'').replace(/^export (?=(?:async )?function|class|const)/gm,'');
const tick=async(n=5)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const {accessAllows,QQ_OFFICIAL}=vm.runInNewContext(strip(read('transport/qq-text-adapter.js'))+'\n;({accessAllows,QQ_OFFICIAL})');
let inputs=0;
const inbound=vm.runInNewContext(strip(read('transport/inbound.js'))+'\n;({normalizeQQMessage,handleInbound,deliverInbound})',{
 accessAllows,createUserMessage:m=>({id:'native-'+(++inputs),role:'user',...m}),classifyContentType:()=>'file',isVoiceContentType:()=>false,clearGroupHistory(){},setInterval:()=>0,clearInterval(){},
});
// The installed SDK middlewares (access, @ gate, commands, merge) when available.
const profile=process.env.QQBOT_TEST_PROFILE??fileURLToPath(new URL('../data/profiles/qqbot-validation/',import.meta.url));
const sdkFile=path.join(profile,'node_modules/@tencent-connect/qqbot-nodejs/dist/middleware/index.js');
const sdk=fs.existsSync(sdkFile)?await import(pathToFileURL(sdkFile).href):null;
const needsSdk={skip:sdk?false:'no validation profile with the installed SDK middlewares'};

function agent(id){
 const a={id,status:'idle',received:[],followup(m){a.received.push(m);},whenIdle:()=>a.idle??Promise.resolve()};return a;
}
// A fake Conversation Manager handle: one record per Conversation, optional rotation and failure.
function manager(){
 const records=new Map(),history=[],m={calls:[],history,fail:null,policy:undefined,registered:[],
  async getOrCreate(scope,peer,sender,target){m.calls.push({scope,peer,sender,target});if(m.fail)throw m.fail;
   const key=scope+':'+peer;let r=records.get(key);if(!r||m.rotate){m.rotate=false;r={sessionKey:key,sessionId:'s'+(records.size+1)+'-'+m.calls.length,agent:agent('a-'+m.calls.length),scope,peerId:peer,replyTarget:target};records.set(key,r);history.push(r);}
   r.replyTarget=target;return r;},
  registerInteractionInput:(r,msg)=>m.registered.push(msg.id),interactionPolicy:()=>m.policy,records};
 return m;
}
const owner={c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'disabled',groupAllow:[]};
function gateway({io=createAgentIO(),appId='app-a',access=owner,commands=[]}={}){
 const mgr=manager(),logs=[],config={appId,access,requireMention:true},logger={info(){},debug:m=>logs.push(['debug',m]),warn:m=>logs.push(['warn',m]),error:m=>logs.push(['error',m])};
 // The same wiring as bootstrapGateway: one channel per QQ application.
 const channel=io.openInbound({platform:QQ_OFFICIAL,adapter:'qq-official-gateway',accountId:appId,deliver:s=>inbound.deliverInbound(s,mgr,config,logger)});
 const replies=[],typing=[];
 const final=ctx=>inbound.handleInbound(ctx,mgr,config,logger,channel);
 const chain=sdk?[sdk.messageFilter({skipSelfEcho:false}),sdk.accessPolicy({c2c:{mode:access.c2cMode,allow:access.c2cAllow},group:{mode:access.groupMode,allow:access.groupAllow}}),sdk.mentionGate({requireMentionInGroup:true}),sdk.slashCommand({autoHelp:false,commands}).middleware,sdk.concurrencyGuard({strategy:'merge',maxQueue:10})]:[];
 const event=({kind='c2c',sender='owner',group,id='msg-1',content='你好',attachments=[],mention=false}={})=>{
  const target={scope:kind==='group'?'group':'c2c',targetId:kind==='group'?group:sender,msgId:id};
  return {message:{kind,senderId:sender,groupOpenid:group,messageId:id,content,attachments,senderIsBot:false,replyTarget:target,...(mention?{rawEventType:'GROUP_AT_MESSAGE_CREATE'}:{})},
   replyTarget:target,state:{},log:{debug(){},info(){},warn(){},error(){}},stop(reason){this.stopped=reason;},abort(){},
   bot:{sendText:async(_t,c)=>replies.push(c),sendMarkdown:async(_t,c)=>replies.push(c),sendTyping:async()=>typing.push(1)}};
 };
 // Full SDK middleware chain, then the message handler (bot.on('message')).
 const push=async options=>{const ctx=event(options);let i=0;const next=async()=>{if(ctx.stopped)return;const mw=chain[i++];return mw?mw(ctx,next):final(ctx);};await next();return ctx;};
 const direct=options=>final(event(options)); // a re-delivery past the SDK's 5 s filter window
 return {io,mgr,channel,logs,replies,push,direct,event,config,logger};
}
const all=g=>g.mgr.history.flatMap(r=>r.agent.received);
const texts=g=>all(g).map(m=>m.content[0].text);

test('ordinary QQ text reaches the right Agent through the Unified I/O channel as a native user input',async()=>{
 const g=gateway();await g.direct({id:'msg-1',content:'今天怎么样'});
 assert.deepEqual(texts(g),['今天怎么样']);assert.equal(all(g)[0].source.kind,'user');
 assert.deepEqual(JSON.parse(JSON.stringify(g.mgr.calls)),[{scope:'c2c',peer:'owner',sender:'owner',target:{scope:'c2c',targetId:'owner',msgId:'msg-1'}}],'reply target keeps the QQ msg_id');
 assert.deepEqual(g.mgr.registered,['native-'+inputs],'trusted Interaction input registration is unchanged');
 assert(!g.logs.some(([,m])=>m.includes('今天怎么样')||m.includes('owner')),'no chat text or raw identity in logs');
});
test('the same messageId pushed again creates one input, also past the SDK filter window',async()=>{
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
 assert.throws(()=>io.openInbound({platform:'qq-official',adapter:'second-gateway',accountId:'app-a',deliver(){}}),/already open/,'no second Gateway intake for one application');
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
 const g=gateway(),interventions=[];g.mgr.policy={intervene:m=>interventions.push(m.content[0].text)};
 await g.direct({id:'i0',content:'开始'});const record=[...g.mgr.records.values()][0];record.agent.status='running';
 await g.direct({id:'i1',content:'插话'});await g.direct({id:'i1',content:'插话'});
 assert.deepEqual(interventions,['插话']);assert.deepEqual(record.agent.received.map(m=>m.content[0].text),['开始'],'no second native input for the interjection');
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
test('closing the channel on Gateway disposal leaves no live intake; a reloaded Gateway takes over',async()=>{
 const io=createAgentIO(),g=gateway({io});g.channel.close();await g.direct({id:'late'});
 assert.equal(all(g).length,0);assert(g.logs.some(([,m])=>m==='im-qqbot: inbound rejected (closed)'));
 const reloaded=gateway({io});await reloaded.direct({id:'late'});assert.equal(all(reloaded).length,1);
 const bootstrap=read('gateway/bootstrap.js');
 assert.match(bootstrap,/const inbound = io\.openInbound\(\{ platform: QQ_OFFICIAL, adapter: 'qq-official-gateway', accountId: config\.appId,/);
 assert.match(bootstrap,/ctx\.effect\(\(\) => inbound\.close\);/);assert.match(bootstrap,/await handleInbound\(mCtx, manager, config, logger, inbound\);/);
});
test('the replaced path: the message handler never creates Agent input itself, and the I/O stays platform-neutral',()=>{
 const source=read('transport/inbound.js'),handler=source.slice(source.indexOf('export async function handleInbound'),source.indexOf('export async function deliverInbound'));
 assert(handler.includes('channel.receive(standard)'));assert(!/\.followup\(|getOrCreate\(|\.intervene\(|createUserMessage\(/.test(handler));
 assert(!/body="|peerId=\$\{|key=\$\{scope\}:\$\{peerId\}/.test(source),'no chat text or raw peer id in the Processing/followup logs');
 const core=fs.readFileSync(new URL('../plugin-sources/dsh-agent-io/io.mjs',import.meta.url),'utf8');
 assert.deepEqual(core.match(/^import .*$/gm),["import {createHash} from 'node:crypto';"]);
});
