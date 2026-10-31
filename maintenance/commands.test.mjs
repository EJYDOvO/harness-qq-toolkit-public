// Unified Agent I/O command router (commands.mjs) on the real I/O core and
// Conversation wiring: recognition, parsing, once-only claim in the inbound
// duplicate scope, admission, scope and authorization refusals, and isolation
// across accounts and Conversation types. Platform-neutral: no QQ code here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {createConversations} from '../plugin-sources/dsh-agent-io/conversation.mjs';
import {createCommandRouter} from '../plugin-sources/dsh-agent-io/commands.mjs';

const manager=()=>({getOrCreate:async()=>{throw Error('unused');},getSessionRecord:()=>undefined,isCurrentSession:()=>false});
function wiring({io=createAgentIO(),accountId='acct',admits=()=>true,inbound=true}={}){
 const delivered=[];
 const c=createConversations(io,{createInput:m=>m,interactionPolicy:()=>undefined})({platform:'synthetic',adapter:'synthetic-adapter',accountId,manager:manager(),scopes:{direct:'dm',group:'room'},admits});
 const channel=inbound?c.openInbound(s=>{delivered.push(s);return {status:'accepted'};}):undefined;
 return {io,c,channel,delivered,router:c.openCommands({prefixes:['/']})};
}
const input=(text,{id='m1',type='direct',peer='u1',sender='u1'}={})=>({conversation:{type,id:peer},sender:{id:sender},message:{...(id?{id}:{}),text}});
const counter=(name='ping',extra={})=>{const runs=[];return {runs,spec:{name,execute:call=>{runs.push(call);return 'pong';},...extra}};};

test('recognition and parsing: prefixes, case, aliases, args and raw; ordinary text and unknown commands pass',async()=>{
 const {router}=wiring(),{runs,spec}=counter(['ping','p']);router.register(spec);
 assert.deepEqual(router.parse('/Ping  a   b c'),{name:'ping',args:['a','b','c'],raw:'a   b c'});
 assert.equal(router.parse('/'),undefined);assert.equal(router.parse('hello /ping'),undefined);
 for(const [text,status] of [['hello','pass'],['/','pass'],['/unknown x','pass'],['/P',' handled'.trim()]])
  assert.equal((await router.dispatch(input(text,{id:'id-'+text}))).status,status,text);
 assert.equal(runs.length,1);assert.equal(runs[0].name,'p');
 const bang=createCommandRouter({prefixes:['!'],claim:()=>'claimed',admits:()=>true});bang.register(counter().spec);
 assert.equal((await bang.dispatch(input('!ping'))).status,'handled');assert.equal((await bang.dispatch(input('/ping'))).status,'pass');
});
test('registration: names are validated, aliases may not collide, unregister removes every alias',()=>{
 const {router}=wiring();
 const off=router.register(counter(['ops','o']).spec);
 assert.throws(()=>router.register(counter('O').spec),/Duplicate/);
 for(const bad of ['', 'has space','../x',' ']) assert.throws(()=>router.register(counter(bad).spec),/names/);
 assert.throws(()=>router.register({name:'x'}),/execute/);
 assert.throws(()=>router.register({name:'x',execute(){},scopes:['dm']}),/scopes/);
 assert.deepEqual(router.list().map(c=>c.names),[['ops','o']]);
 off();assert.deepEqual(router.list(),[]);router.register(counter('o').spec);
});
test('a command runs once per platform message: repeated and concurrent deliveries are duplicates, and it never reaches the Agent',async()=>{
 const {router,channel,delivered}=wiring(),{runs,spec}=counter();router.register(spec);
 assert.equal((await router.dispatch(input('/ping'))).status,'handled');
 assert.equal((await router.dispatch(input('/ping'))).status,'duplicate');
 const both=await Promise.all([router.dispatch(input('/ping',{id:'m2'})),router.dispatch(input('/ping',{id:'m2'}))]);
 assert.deepEqual(both.map(r=>r.status).sort(),['duplicate','handled']);
 assert.equal(runs.length,2);
 const late=await channel.receive({conversation:{type:'direct',id:'u1'},sender:{id:'u1'},message:{id:'m1',text:'/ping'}});
 assert.equal(late.status,'duplicate','the same message re-delivered as chat creates no Agent input');assert.equal(delivered.length,0);
});
test('claims are scoped like inbound dedup: other accounts and Conversation types are independent',async()=>{
 const io=createAgentIO(),a=wiring({io,accountId:'a'}),b=wiring({io,accountId:'b'}),ra=counter(),rb=counter();
 a.router.register(ra.spec);b.router.register(rb.spec);
 await a.router.dispatch(input('/ping'));await b.router.dispatch(input('/ping'));
 await a.router.dispatch(input('/ping',{type:'group',peer:'u1'}));await a.router.dispatch(input('/ping',{peer:'u2',sender:'u2'}));
 assert.equal(ra.runs.length,3);assert.equal(rb.runs.length,1);
});
test('admission comes from the wiring: a Conversation the platform no longer admits runs nothing and is not claimed',async()=>{
 let open=false;const {router,channel,delivered}=wiring({admits:(scope,peer)=>open&&peer==='u1'}),{runs,spec}=counter();router.register(spec);
 assert.deepEqual(await router.dispatch(input('/ping')),{status:'rejected',reason:'unauthorized'});
 assert.equal((await router.dispatch(input('/ping',{id:'m9',peer:'intruder',sender:'u1'}))).reason,'unauthorized','a forged sender does not open another Conversation');
 assert.equal(runs.length,0);
 open=true;assert.equal((await router.dispatch(input('/ping'))).status,'handled','not claimed while refused');
 assert.equal(delivered.length,0);void channel;
});
test('authorization belongs to the command: refusals reply, never execute, and cannot be granted by the input',async()=>{
 const replies=[],{router}=wiring(),run=[];
 const reply=t=>{replies.push(t);};
 router.register({name:'ops',authorize:call=>call.sender.id==='owner'||'仅部署所有者可执行运维命令。',execute:call=>{run.push(call.sender.id);return 'ok';}});
 router.register({name:'deny',authorize:()=>false,execute:()=>run.push('deny')});
 router.register({name:'boom',authorize:()=>{throw Error('x');},execute:()=>run.push('boom')});
 const forged={...input('/ops status',{id:'f1',sender:'other',peer:'other'}),platformData:{owner:true},permissions:['admin']};
 assert.deepEqual(await router.dispatch(forged,{reply}),{status:'denied',reason:'unauthorized',command:'ops',replied:true});
 await router.dispatch(input('/deny',{id:'d1'}),{reply});await router.dispatch(input('/boom',{id:'b1'}),{reply});
 assert.deepEqual(run,[]);assert.deepEqual(replies,['仅部署所有者可执行运维命令。','⚠️ 无权限执行此命令','⚠️ 无权限执行此命令']);
 assert.equal((await router.dispatch(input('/ops status',{id:'o1',sender:'owner',peer:'owner'}),{reply})).status,'handled');assert.deepEqual(run,['owner']);
});
test('scope restriction, results and failures map to replies; the call is frozen and carries no platform data',async()=>{
 const replies=[],{router}=wiring(),seen=[];const reply=t=>{replies.push(t);};
 router.register({name:'dm-only',scopes:['direct'],execute:()=>'私聊'});
 router.register({name:'noop',execute:call=>{seen.push(call);return {kind:'noop'};}});
 router.register({name:'obj',execute:()=>({kind:'text',content:'对象结果'})});
 router.register({name:'fail',execute:()=>{throw Error('坏了');}});
 assert.equal((await router.dispatch(input('/dm-only',{id:'g1',type:'group',peer:'room1'}),{reply})).reason,'scope');
 assert.equal((await router.dispatch(input('/noop a',{id:'n1'}),{reply,context:{opaque:1}})).status,'handled');
 await router.dispatch(input('/obj',{id:'o1'}),{reply});
 assert.deepEqual(await router.dispatch(input('/fail',{id:'x1'}),{reply}),{status:'failed',reason:'command-error',command:'fail',replied:true});
 assert.deepEqual(replies,['该指令仅限私聊使用','对象结果','Error: 坏了']);
 const [call]=seen;assert(Object.isFrozen(call)&&Object.isFrozen(call.args)&&Object.isFrozen(call.sender));
 assert.deepEqual(Object.keys(call).sort(),['args','context','conversation','message','name','raw','sender']);assert.deepEqual(call.context,{opaque:1});
});
test('a failed reply is reported once and the command is not executed again',async()=>{
 const {router}=wiring(),{runs,spec}=counter();router.register(spec);
 const r=await router.dispatch(input('/ping'),{reply:async()=>{throw Error('network');}});
 assert.deepEqual([r.status,r.replied],['handled',false]);
 assert.equal((await router.dispatch(input('/ping'),{reply:async()=>{}})).status,'duplicate');assert.equal(runs.length,1);
});
test('without an open inbound channel or after close, commands are refused rather than run unclaimed',async()=>{
 const none=wiring({inbound:false}),{runs,spec}=counter();none.router.register(spec);
 assert.deepEqual(await none.router.dispatch(input('/ping')),{status:'rejected',reason:'closed'});
 const closing=wiring();closing.router.register(counter().spec);closing.c.close();
 assert.equal((await closing.router.dispatch(input('/ping'))).status,'rejected');
 assert.equal(runs.length,0);
 assert.throws(()=>closing.c.openCommands(),/closed/);assert.throws(()=>wiring().c.openCommands()&&undefined,/already open/);
});
test('the router is platform-neutral and grants nothing by itself',()=>{
 const source=fs.readFileSync(new URL('../plugin-sources/dsh-agent-io/commands.mjs',import.meta.url),'utf8');
 assert.equal([...source.matchAll(/^import /gm)].length,0,'no imports');
 assert(!/platformData|\.context\./.test(source.replace(/\/\/.*$/gm,'')),'never reads platform data or the adapter context');
});
