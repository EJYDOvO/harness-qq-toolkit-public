// HITL Bridge (Iteration 06): the Agent I/O hitl module behind the reviewed QQ
// Gateway wiring (openConversation lines, openQQHITL, QQ text adapter keyboard
// and button decoding) on the real Unified Agent I/O core. The Host waterfalls
// are a stand-in with the native calling convention (listener(request, next),
// prepend), the QQ API is fake: this proves correlation, trusted answers and
// lifecycle, not delivery to a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {createHITLHost,parseAnswer} from '../plugin-sources/dsh-agent-io/hitl.mjs';
import {qqAdapter,qqConversation,openQQHITL} from './qq-conversation-fixture.mjs';

// The QQ adapter runs in a vm context: compare its objects by value.
const plain=value=>JSON.parse(JSON.stringify(value));
const tick=async(n=10)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
class ApiError extends Error{name='ApiError';constructor(status){super('API Error');this.httpStatus=status;}}
const warnings=[],logger={info(){},debug(){},error(){},warn:m=>warnings.push(m)};

// The native Host convention: ctx.on(name, listener, {prepend}) → dispose, and a
// waterfall whose listeners receive (request, next) and whose fallback is the
// next answerer (Web/Desktop) or the native "no answerer" result.
function hostContext(){
 const map=new Map();
 return {
  on(name,fn,options){const list=map.get(name)??[];if(options?.prepend)list.unshift(fn);else list.push(fn);map.set(name,list);return ()=>{const i=list.indexOf(fn);if(i>=0)list.splice(i,1);};},
  waterfall(name,request,fallback){const list=[...(map.get(name)??[])];const run=i=>i<list.length?Promise.resolve().then(()=>list[i](request,()=>run(i+1))):fallback();return run(0);},
  count:name=>(map.get(name)??[]).length,
 };
}

// A failed assertion must not leave a five-minute request timer behind.
const opened=[];
test.afterEach(()=>{for(const c of opened.splice(0))c.close();});
function setup({c2c=['owner'],groups=['g1'],send,bridge,split=t=>[t],config:extra={}}={}){
 const ctx=hostContext(),io=createAgentIO(),sessions=new Map(),sent=[];let n=0;
 const manager={
  getOrCreate:async()=>{throw Error('not used here');},
  getSessionRecord:(scope,peer)=>sessions.get(scope+':'+peer),
  isCurrentSession:record=>sessions.get(record.scope+':'+record.peerId)===record,
  findBySessionId:id=>[...sessions.values()].find(r=>r.sessionId===id),
 };
 const config={appId:'app-a',access:{c2cMode:'allowlist',c2cAllow:c2c,groupMode:'allowlist',groupAllow:groups},askTimeoutMs:60_000,requireMention:true,...extra};
 const host=createHITLHost(ctx);
 const conversation=qqConversation({io,manager,config,hitl:host});opened.push(conversation);
 conversation.openInbound(()=>({status:'accepted'}));
 conversation.registerAdapter(qqAdapter.createQQTextAdapter({split,limit:4500,send:async(target,text,info)=>{
  const message={target,text,keyboard:info.keyboard};sent.push(message);
  return send?send(message,sent.length):{id:'r'+sent.length};
 }}));
 const hitl=bridge?bridge(conversation):openQQHITL(conversation,config,logger);
 const add=(scope,peer,senderId=peer)=>{const id='s'+(++n);const record={scope,peerId:peer,sessionId:id,senderId,replyTarget:{scope,targetId:peer,msgId:'m-'+id},agent:{id,session:{seq:0,eventAt(){}}}};sessions.set(scope+':'+peer,record);return record;};
 const approve=(record,{signal,toolName='bash',callId}={})=>ctx.waterfall('approval/request',{agent:record.agent,toolName,callId,signal},()=>Promise.resolve('native'));
 const ask=(record,questions,signal)=>ctx.waterfall('user-questions/request',{agent:record.agent,questions,signal},()=>Promise.reject(Object.assign(Error('no answerer'),{code:'NO_PROVIDER'})));
 const buttons=message=>message.keyboard.content.rows.flatMap(r=>r.buttons);
 // A QQ button event as the platform sends it: C2C carries user_openid, a group
 // its group_openid and the clicking member's group_member_openid.
 const click=(message,index,{user,group}={})=>{
  const data=buttons(message)[index].action.data;
  const event=group?{group_openid:group,group_member_openid:user,data:{resolved:{button_data:data}}}:{user_openid:user??message.target.targetId,data:{resolved:{button_data:data}}};
  const response=qqAdapter.hitlResponse(event);
  return response?hitl.respond(response):{status:'rejected',reason:'not-hitl'};
 };
 const text=(record,body,{sender=record.senderId,id}={})=>hitl.answer({conversation:{type:record.scope==='group'?'group':'direct',id:record.peerId},sender:{id:sender},message:{...(id?{id}:{}),text:body}});
 return {ctx,io,sessions,sent,manager,conversation,hitl,host,add,approve,ask,buttons,click,text,config};
}
const q=(id,options,extra={})=>({id,question:'问题 '+id,...(options?{options:options.map(label=>({label}))}:{}),...extra});

test('no Bridge, no listener: Web/Desktop answer every request; a request of another Session goes on unchanged',async()=>{
 const ctx=hostContext(),host=createHITLHost(ctx);
 assert.equal(ctx.count('approval/request')+ctx.count('user-questions/request'),0,'nothing is installed before a platform opens a Bridge');
 const f=setup();
 assert.equal(f.ctx.count('approval/request'),1);assert.equal(f.ctx.count('user-questions/request'),1);
 const foreign={agent:{id:'web-session',session:{seq:0,eventAt(){}}}};
 assert.equal(await f.ctx.waterfall('approval/request',foreign,()=>Promise.resolve('native')),'native');
 await assert.rejects(f.ctx.waterfall('user-questions/request',{...foreign,questions:[q('a')]},()=>Promise.reject(Object.assign(Error('n'),{code:'NO_PROVIDER'}))),{code:'NO_PROVIDER'});
 // A QQ record whose Session is no longer current is not owned either.
 const old=f.add('c2c','owner');f.add('c2c','owner');
 assert.equal(await f.approve(old),'native');
 assert.equal(f.sent.length,0);
 f.conversation.close();
 assert.equal(f.ctx.count('approval/request')+f.ctx.count('user-questions/request'),0,'closing the last Bridge removes the listeners');
 assert.equal(host.size(),0);
});

test('approval: one prompt with two Host-issued buttons through the I/O; only the owner settles it, once',async()=>{
 const f=setup(),record=f.add('c2c','owner');
 record.agent.session={seq:1,eventAt:()=>({type:'tool/call',data:{callId:'c1',arguments:JSON.stringify({command:'rm -rf build'})}})};
 const outcome=f.approve(record,{callId:'c1'});await tick();
 assert.equal(f.sent.length,1);
 const [prompt]=f.sent;
 assert.match(prompt.text,/执行审批[\s\S]*bash[\s\S]*rm -rf build/);
 assert.deepEqual(plain(prompt.target),{scope:'c2c',targetId:'owner',msgId:'m-s1'},'the reply target of the Session record');
 const labels=f.buttons(prompt).map(b=>[b.render_data.label,b.render_data.visited_label]);
 assert.deepEqual(plain(labels),[['✅ 允许一次','✓ 已允许'],['❌ 拒绝','✓ 已拒绝']]);
 const data=JSON.parse(f.buttons(prompt)[0].action.data);
 assert.deepEqual(Object.keys(data),['t','r','v'],'button data names only the request and the option');
 assert.equal(f.hitl.waiting(record),true);
 // In C2C the clicker is the Conversation: a stranger's click is another Conversation.
 assert.deepEqual(f.click(prompt,0,{user:'stranger'}),{status:'rejected',reason:'wrong-conversation'});
 assert.deepEqual(f.hitl.respond({conversation:{type:'direct',id:'owner'},sender:{id:'stranger'},ref:data.r,value:'allow'}),{status:'rejected',reason:'unauthorized'},'a forged sender in the right Conversation');
 assert.deepEqual(f.hitl.respond({conversation:{type:'direct',id:'owner'},sender:{id:'owner'},ref:'forged-reference',value:'allow'}),{status:'rejected',reason:'unknown-request'});
 assert.deepEqual(f.hitl.respond({conversation:{type:'direct',id:'owner'},sender:{id:'owner'},ref:data.r,value:'always'}),{status:'rejected',reason:'invalid-answer'});
 assert.deepEqual(f.hitl.respond({conversation:{type:'direct',id:'other'},sender:{id:'owner'},ref:data.r,value:'allow'}),{status:'rejected',reason:'wrong-conversation'});
 assert.deepEqual(f.click(prompt,0),{status:'accepted'});
 assert.equal(await outcome,'allowed-once');
 assert.deepEqual(f.click(prompt,1),{status:'rejected',reason:'unknown-request'},'a second click (deny) after the decision is refused');
 assert.equal(f.hitl.waiting(record),false);assert.deepEqual({...f.hitl.size()},{approvals:0,questions:0,refs:0});
 // Deny, and a concurrent second approval of the same Session.
 const second=f.approve(record);await tick();
 assert.equal(await f.approve(record),'unavailable','one open approval per Session');
 assert.deepEqual(f.click(f.sent[1],1),{status:'accepted'});
 assert.equal(await second,'rejected');
});

test('approval: /stop or another abort, timeout, Session release and Gateway close cancel it and clean up',async()=>{
 const f=setup({bridge:c=>c.openHITL({responder:r=>r.senderId,render:{approval:()=>'审批',question:x=>x.question},approvalTimeoutMs:40,questionTimeoutMs:40})});
 const record=f.add('c2c','owner');
 const stop=new AbortController(),a=f.approve(record,{signal:stop.signal});await tick();
 stop.abort();assert.equal(await a,'cancelled');
 assert.deepEqual(f.click(f.sent[0],0),{status:'rejected',reason:'unknown-request'});
 assert.equal(await f.approve(record,{signal:AbortSignal.abort()}),'cancelled','already aborted: no prompt');
 assert.equal(f.sent.length,1);
 const timed=f.approve(record);await tick();
 assert.equal(await timed,'cancelled','five minutes in production; never an approval');
 assert.deepEqual(f.click(f.sent[1],0),{status:'rejected',reason:'unknown-request'},'a late click is refused');
 const released=f.approve(record);await tick();f.hitl.cancel(record);assert.equal(await released,'cancelled');
 const open=f.approve(record),asked=f.ask(record,[q('a')]);await tick();
 f.conversation.close();
 assert.equal(await open,'cancelled');
 await assert.rejects(asked,e=>e.name==='UserQuestionError'&&e.code==='ASK_ABORTED');
 assert.deepEqual({...f.hitl.size()},{approvals:0,questions:0,refs:0});
});

test('approval prompt delivery: refused is unavailable, unknown keeps waiting without resending, never an approval',async()=>{
 const refused=setup({send:()=>{throw new ApiError(403);}}),r1=refused.add('c2c','owner');
 assert.equal(await refused.approve(r1),'unavailable');assert.equal(refused.sent.length,1);
 const lost=setup({send:()=>{throw new ApiError(0);}}),r2=lost.add('c2c','owner');
 const pending=lost.approve(r2);await tick(20);
 assert.equal(lost.sent.length,1,'the buttons are not sent again');assert.equal(lost.hitl.waiting(r2),true);
 assert.deepEqual(lost.click(lost.sent[0],0),{status:'accepted'},'a genuine click on a prompt that did arrive still counts');
 assert.equal(await pending,'allowed-once');
 // A queued prompt whose request is aborted first never reaches QQ.
 let release;const slow=setup({send:m=>m.text==='先发'?new Promise(r=>{release=()=>r({id:'x'});}):{id:'y'}}),r3=slow.add('c2c','owner');
 const first=slow.io.sendMessage({target:slow.conversation.target(r3),origin:{sessionId:r3.sessionId},message:{text:'先发'}});
 const stop=new AbortController(),queued=slow.approve(r3,{signal:stop.signal});await tick();
 stop.abort();release();await first;
 assert.equal(await queued,'cancelled');assert.deepEqual(slow.sent.map(m=>m.text),['先发'],'same Conversation order; the cancelled prompt is not sent');
});

test('a partial prompt: text parts out, the keyboard part refused, is unavailable for an approval; a question waits for text',async()=>{
 const cut=t=>t.split('|'),keyboardRefused=m=>{if(m.keyboard)throw new ApiError(400);return {id:'p'};};
 const f=setup({split:cut,send:keyboardRefused,bridge:c=>c.openHITL({responder:r=>r.senderId,render:{approval:()=>'第一段|第二段',question:x=>'问|'+x.question}})});
 const record=f.add('c2c','owner');
 assert.equal(await f.approve(record),'unavailable');
 assert.deepEqual(f.sent.map(m=>[m.text,!!m.keyboard]),[['第一段',false],['第二段',true]],'the buttons belong to the last part and are not sent again');
 const answers=f.ask(record,[q('a',['甲','乙'])]);await tick(20);
 assert.deepEqual(f.sent.slice(2).map(m=>[m.text,!!m.keyboard]),[['问',false],['问题 a',true],['问',false],['问题 a',false]],'refused buttons: one text-only resend');
 assert.deepEqual(f.text(record,'1'),{status:'answered'});assert.deepEqual((await answers).answers,[{id:'a',selected:['甲']}]);
});

test('approval through revocation, Session rotation and a group: only the expected member in the current Session',async()=>{
 const f=setup(),record=f.add('c2c','owner');
 const rotated=f.approve(record);await tick();
 const next=f.add('c2c','owner');
 assert.deepEqual(f.click(f.sent[0],0),{status:'rejected',reason:'stale'},'a rotated Session cannot be approved');
 f.hitl.cancel(record);assert.equal(await rotated,'cancelled');
 const revoked=f.approve(next);await tick();
 f.config.access.c2cAllow.length=0;
 assert.deepEqual(f.click(f.sent[1],0),{status:'rejected',reason:'stale'},'revoked access refuses the answer');
 f.hitl.cancel(next);assert.equal(await revoked,'cancelled');
 const g=setup(),room=g.add('group','g1','member-a');
 const decision=g.approve(room);await tick();
 assert.deepEqual(g.click(g.sent[0],0,{group:'g1',user:'member-b'}),{status:'rejected',reason:'unauthorized'},'another group member cannot approve');
 assert.deepEqual(g.click(g.sent[0],0,{group:'g2',user:'member-a'}),{status:'rejected',reason:'wrong-conversation'});
 assert.equal(qqAdapter.hitlResponse({group_openid:'g1',user_openid:'member-a',data:{resolved:{button_data:g.sent[0].keyboard.content.rows[0].buttons[0].action.data}}}),undefined,'a group click without the member field is not an answer');
 assert.deepEqual(g.click(g.sent[0],0,{group:'g1',user:'member-a'}),{status:'accepted'});
 assert.equal(await decision,'allowed-once');
});

test('questions: buttons for single choice, text for the rest, one question at a time, old buttons stale',async()=>{
 const f=setup(),record=f.add('c2c','owner');
 const answers=f.ask(record,[q('color',['红','绿']),q('size',['S','M','L'],{multiSelect:true}),q('note'),q('plan',['批准','修改'],{detail:'计划：先备份再迁移'})]);await tick();
 const [first]=f.sent;
 assert.match(first.text,/问题 color[\s\S]*1\. 红[\s\S]*点击下方按钮/);
 assert.deepEqual(plain(f.buttons(first).map(b=>b.render_data.label)),['红','绿']);
 assert.deepEqual(f.click(first,1,{user:'stranger'}),{status:'rejected',reason:'wrong-conversation'});
 assert.deepEqual(f.click(first,1),{status:'accepted'});await tick();
 assert.deepEqual(f.click(first,0),{status:'rejected',reason:'unknown-request'},'the previous question\'s buttons are stale');
 const second=f.sent[1];assert.equal(second.keyboard,undefined,'multi-select: text only');assert.match(second.text,/可多选[\s\S]*回复多个编号/);
 assert.deepEqual(f.text(record,'1,3',{sender:'stranger'}),{status:'pass'},'another person\'s text is ordinary input');
 assert.deepEqual(f.text(record,'1,3',{id:'in-1'}),{status:'answered'});await tick();
 assert.deepEqual(f.text(record,'1,3',{id:'in-1'}),{status:'duplicate'},'a re-delivered answer neither answers again nor reaches the Agent');
 assert.equal(f.sent[2].keyboard,undefined);
 assert.deepEqual(f.text(record,'   '),{status:'pass'});
 assert.deepEqual(f.text(record,'自由回答',{id:'in-2'}),{status:'answered'});await tick();
 assert.match(f.sent[3].text,/计划：先备份再迁移/,'the native detail a plan review needs is shown');
 assert.deepEqual(f.text(record,'修改',{id:'in-3'}),{status:'answered'});
 assert.deepEqual((await answers).answers,[{id:'color',selected:['绿']},{id:'size',selected:['S','L']},{id:'note',selected:[],custom:'自由回答'},{id:'plan',selected:['修改']}]);
 assert.deepEqual(f.text(record,'1'),{status:'pass'},'without an open question text is chat input');
 assert.deepEqual({...f.hitl.size()},{approvals:0,questions:0,refs:0});
});

test('questions: timeout, abort, supersede and release reject with the native ASK_ABORTED; the timeout notice goes through the I/O',async()=>{
 const f=setup({bridge:c=>c.openHITL({responder:r=>r.senderId,render:{approval:()=>'审批',question:x=>x.question,timeout:()=>'⚠️ 提问已超时'},questionTimeoutMs:40})});
 const record=f.add('c2c','owner'),native=e=>e.name==='UserQuestionError'&&e.code==='ASK_ABORTED';
 await assert.rejects(f.ask(record,[q('a')]),native);await tick();
 assert.deepEqual(f.sent.map(m=>m.text),['问题 a','⚠️ 提问已超时']);
 assert.deepEqual(f.text(record,'迟到'),{status:'pass'},'a late answer is ordinary input');
 const stop=new AbortController(),aborted=f.ask(record,[q('b')],stop.signal);await tick();stop.abort();await assert.rejects(aborted,native);
 const old=f.ask(record,[q('c')]);await tick();const current=f.ask(record,[q('d')]);
 await assert.rejects(old,native);
 assert.deepEqual(f.text(record,'答'),{status:'answered'});assert.equal((await current).answers[0].id,'d','the replacement is answered, not the superseded one');
 const released=f.ask(record,[q('e')]);await tick();f.hitl.cancel(record);await assert.rejects(released,native);
 await assert.rejects(f.ask(record,[q('f')],AbortSignal.abort()),native);
});

test('question delivery: refused buttons fall back to text once; an unknown outcome is never resent',async()=>{
 const fallback=setup({send:m=>{if(m.keyboard)throw new ApiError(400);return {id:'t'};}}),r1=fallback.add('c2c','owner');
 const a=fallback.ask(r1,[q('x',['甲','乙'])]);await tick(20);
 assert.deepEqual(fallback.sent.map(m=>!!m.keyboard),[true,false]);assert.match(fallback.sent[1].text,/回复编号选择/);
 assert.deepEqual(fallback.text(r1,'2'),{status:'answered'});assert.deepEqual((await a).answers,[{id:'x',selected:['乙']}]);
 const lost=setup({send:()=>{throw new ApiError(0);}}),r2=lost.add('c2c','owner');
 const b=lost.ask(r2,[q('y',['甲','乙'])]);await tick(20);
 assert.equal(lost.sent.length,1,'not resent after an unknown outcome');
 assert.deepEqual(lost.text(r2,'甲'),{status:'answered'});assert.deepEqual((await b).answers,[{id:'y',selected:['甲']}]);
 const down=setup({send:()=>{throw new ApiError(403);}}),r3=down.add('c2c','owner');
 await assert.rejects(down.ask(r3,[q('z')]),/failed to deliver question/);
});

test('actions are Host-issued only: a self-made button set or one with attachments is refused before the platform',async()=>{
 const f=setup(),record=f.add('c2c','owner');
 const target=f.conversation.target(record),origin={sessionId:record.sessionId};
 const forged=await f.io.sendMessage({target,origin,message:{text:'批准？',actions:{ref:'forged-reference',options:[{value:'allow',label:'允许'}]}}});
 assert.equal(forged.status,'not-sent');assert.equal(forged.reason,'unauthorized');
 const issued=f.io.issueActions({ref:'issued-reference',options:[{value:'a',label:'A'}]});
 assert.equal((await f.io.sendMessage({target,origin,message:{text:'x',actions:issued,attachments:[{kind:'file',resource:{type:'local',path:'/tmp/a'}}]}})).reason,'unsupported');
 assert.equal((await f.io.sendMessage({target,origin,message:{text:' ',actions:issued}})).reason,'invalid-message');
 assert.throws(()=>f.io.issueActions({ref:'x',options:[]}),/Invalid actions/);
 assert.throws(()=>f.io.issueActions({ref:'issued-reference',options:[{value:'a b',label:'A'}]}),/Invalid action option/);
 assert.equal(f.sent.length,0);
 const entry=fs.readFileSync(new URL('../plugin-sources/dsh-agent-io/index.mjs',import.meta.url),'utf8');
 assert(entry.includes("ctx.provide('agentIO',Object.freeze({sendMessage:io.sendMessage,registerAdapter:io.registerAdapter,openInbound:io.openInbound,openConversation,diagnostics:io.diagnostics}))"),'the provided service cannot issue actions');
});

test('Interaction sees the wait; the QQ text gate answers before the merge guard; hitl.enabled:false leaves QQ requests native',async()=>{
 const f=setup(),record=f.add('c2c','owner');
 const answers=f.ask(record,[q('a',['是','否'])]);await tick();
 // The reviewed QQ text gate (hitlAnswers) on the real Bridge.
 const source=fs.readFileSync(new URL('./qqbot-src/dist/gateway/middleware-setup.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
 const start=source.indexOf('export function hitlAnswers'),end=source.indexOf('export function setupMiddlewares',start);
 const cached=[],gate=vm.runInNewContext(source.slice(start,end).replace('export function','function')+';hitlAnswers')({hitl:f.hitl},{cacheMsgId:(...a)=>cached.push(a)});
 const run=async(content,senderId='owner')=>{const c={message:{kind:'c2c',senderId,messageId:'mx-'+content,content},replyTarget:{scope:'c2c',targetId:senderId,msgId:'mx'},stop(reason){this.stopped=reason;}};let passed=false;await gate(c,async()=>{passed=true;});return {passed,stopped:c.stopped};};
 assert.deepEqual(await run('你好','stranger'),{passed:true,stopped:undefined});
 assert.deepEqual(await run('<@bot> 2'),{passed:false,stopped:'hitl:answered'});
 assert.equal(cached.length,1);
 assert.deepEqual((await answers).answers,[{id:'a',selected:['否']}]);
 assert.deepEqual(await run('普通消息'),{passed:true,stopped:undefined});
 const off=setup({config:{hitl:{enabled:false}}}),r=off.add('c2c','owner');
 assert.equal(off.hitl,undefined);
 assert.equal(off.ctx.count('approval/request'),0);
 assert.equal(await off.ctx.waterfall('approval/request',{agent:r.agent},()=>Promise.resolve('native')),'native');
});

test('the replaced path: no QQ HITL channel, button decoding or direct send outside the Bridge and the I/O adapter',()=>{
 const read=f=>fs.readFileSync(new URL('./qqbot-src/dist/'+f,import.meta.url),'utf8');
 const bootstrap=read('gateway/bootstrap.js'),setup=read('gateway/middleware-setup.js'),manager=read('session/session-manager.js');
 for(const old of ['question-channel.js','approval-channel.js','question-answer.js','button-utils.js'])for(const [name,s] of [['bootstrap',bootstrap],['middleware',setup]])assert(!s.includes(old),name+' imports '+old);
 assert(!/approvalChannel|questionChannel/.test(bootstrap+setup+manager),'no old channel reference remains');
 for(const [file,name]of [['approval-channel.js','ApprovalChannel'],['question-channel.js','QuestionChannel']]){
  const retired=vm.runInNewContext(read('features/'+file).replace('export class','class')+';'+name);
  assert.throws(()=>new retired(),/retired; use conversation.openHITL/,'accidental legacy imports cannot resurrect direct senders');
 }
 assert(/conversation\.openHITL\(/.test(bootstrap));assert(/manager\.hitl\?\.waiting\(record\)/.test(manager));assert(/manager\.hitl\?\.cancel\(record\)/.test(manager));
 const hitl=fs.readFileSync(new URL('../plugin-sources/dsh-agent-io/hitl.mjs',import.meta.url),'utf8');
 assert(!/sendMarkdown|\.ask\s*=|__qqQuestionPatched/.test(hitl),'the Bridge neither sends directly nor patches userQuestions.ask');
 assert.deepEqual(parseAnswer(q('n',['A','B']),'b'),{id:'n',selected:['B']});
});

test('the Bridge itself hands a request it does not own to the next answerer, and completes a request once',async()=>{
 const f=setup(),record=f.add('c2c','owner');
 const {createHITLBridge}=await import('../plugin-sources/dsh-agent-io/hitl.mjs');
 const bridge=createHITLBridge({io:f.io,manager:f.manager,wiring:{target:()=>undefined,current:()=>false,allowed:()=>false,claim:()=>'unavailable'},responder:r=>r.senderId,render:{approval:()=>'a',question:()=>'q'}});
 assert.equal(await bridge.approval({agent:record.agent},()=>'native'),'native','not current here: the next answerer decides');
 assert.equal(await bridge.question({agent:record.agent,questions:[q('a')]},()=>'native'),'native');
 bridge.close();
 // Answered, then aborted: the outcome stays the answer and nothing is left behind.
 const stop=new AbortController(),outcome=f.approve(record,{signal:stop.signal});await tick();
 assert.deepEqual(f.click(f.sent[0],1),{status:'accepted'});stop.abort();
 assert.equal(await outcome,'rejected');assert.deepEqual({...f.hitl.size()},{approvals:0,questions:0,refs:0});
});

test('an answered question stops: its queued or unsent parts never follow, the next question is not cancelled',async()=>{
 // Q1 queued behind earlier output and answered before it went out.
 let release;const held=new Promise(r=>{release=()=>r({id:'held'});});
 const bridge=c=>c.openHITL({responder:r=>r.senderId,render:{approval:()=>'审批',question:x=>x.question}});
 const a=setup({send:m=>m.text==='earlier'?held:{id:'ok'},bridge}),r1=a.add('c2c','owner');
 const earlier=a.io.sendMessage({target:a.conversation.target(r1),origin:{sessionId:r1.sessionId},message:{text:'earlier'}});
 const first=a.ask(r1,[q('a'),q('b')]);await tick();
 assert.deepEqual(a.text(r1,'答一',{id:'x1'}),{status:'answered'});
 release();await earlier;await tick(20);
 assert.deepEqual(a.sent.map(m=>m.text),['earlier','问题 b'],'the answered question is not sent late; the next one is');
 assert.deepEqual(a.text(r1,'答二',{id:'x2'}),{status:'answered'});assert.equal((await first).answers.length,2);
 // Q1 in parts, answered while its first part is in flight: that part completes, the rest is skipped.
 let open;const inFlight=new Promise(r=>{open=()=>r({id:'p1'});});
 const b=setup({split:t=>t.split('|'),send:m=>m.text==='一'?inFlight:{id:'ok'},bridge:c=>c.openHITL({responder:r=>r.senderId,render:{approval:()=>'审批',question:x=>x.id==='a'?'一|二|三':'下一题'}})}),r2=b.add('c2c','owner');
 const second=b.ask(r2,[q('a'),q('b')]);await tick();
 assert.deepEqual(b.text(r2,'答',{id:'y1'}),{status:'answered'});open();await tick(20);
 assert.deepEqual(b.sent.map(m=>m.text),['一','下一题'],'the part already handed to QQ stays sent; parts not yet started are not');
 b.text(r2,'答',{id:'y2'});await second;
 // An unknown first prompt is not resent and does not cancel the next question.
 const c=setup({send:m=>{if(m.text.startsWith('问题 a'))throw new ApiError(0);return {id:'ok'};}}),r3=c.add('c2c','owner');
 const third=c.ask(r3,[q('a',['甲','乙']),q('b')]);await tick(20);
 assert.deepEqual(c.text(r3,'1',{id:'z1'}),{status:'answered'});await tick(20);
 assert.deepEqual(c.sent.map(m=>m.text.split('\n')[0]),['问题 a','问题 b'],'one attempt for the unknown prompt, then the next question');
 c.text(r3,'答',{id:'z2'});await third;
});
