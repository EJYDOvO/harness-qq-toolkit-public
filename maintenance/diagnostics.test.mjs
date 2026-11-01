import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnostics} from '../plugin-sources/dsh-agent-io/diagnostics.mjs';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {createConversations} from '../plugin-sources/dsh-agent-io/conversation.mjs';
const context={platform:'synthetic',adapter:'synthetic-adapter',accountId:'private-account',conversation:{type:'direct',id:'private-user'}};
test('commands finishing beyond 300 seconds execute once but cannot use an expired input reply',async()=>{
 let at=0,runs=0,sends=0;
 const io=createAgentIO(),c=createConversations(io,{now:()=>at,createInput:x=>x,interactionPolicy:()=>undefined})({...context,scopes:{direct:'dm'},admits:()=>true,manager:{getOrCreate(){throw Error('no session grant');},getSessionRecord(){},isCurrentSession:()=>false}});
 c.openInbound(()=>({status:'accepted'}));c.registerAdapter({split:t=>[t],async send(){sends++;}});
 const commands=c.openCommands();commands.register({name:'slow',execute(){runs++;at+=300_000;return 'done';}});
 const input={conversation:context.conversation,sender:{id:'private-user'},message:{id:'slow',text:'/slow'}};
 const result=await commands.dispatch(input);assert.equal(result.status,'handled');assert.equal(result.replied,false);
 assert.equal((await commands.dispatch(input)).status,'duplicate');assert.equal(runs,1);assert.equal(sends,0);c.close();await io.close();
});
test('diagnostics are optional, bounded, closed-shape and observer failures cannot change a result',async()=>{
 const off=createDiagnostics();off.scope(context).emit('io','send',{status:'sent'});assert.deepEqual(off.snapshot(),[]);
 const d=createDiagnostics({enabled:true,capacity:3,onEvent:()=>{throw Error('diagnostic failure');}}),s=d.scope(context),rows=[];
 const stop=d.subscribe(row=>{rows.push(row);return Promise.reject(Error('async observer failed'));});
 for(let i=0;i<8;i++)s.emit('io','part',{inputId:'private-input',logicalId:'private-logical',sessionId:'private-session',receiptId:'private-receipt',text:'PRIVATE_BODY',token:'PRIVATE_TOKEN',error:Error('PRIVATE_ERROR'),reason:'PRIVATE_REASON',status:'sent',index:i});
 await new Promise(r=>setImmediate(r));stop();
 assert.equal(rows.length,8);assert.equal(d.snapshot().length,3);assert.equal(rows[0].logical,rows[7].logical);assert.equal(rows[0].reason,'other');
 const serialized=JSON.stringify(rows);for(const raw of ['private-account','private-user','private-input','private-session','private-logical','private-receipt','PRIVATE_'])assert(!serialized.includes(raw));
 assert.notEqual(s.hash('same'),d.scope({...context,accountId:'other'}).hash('same'));
 assert.notEqual(s.hash('same'),createDiagnostics().scope(context).hash('same'));
});
test('redacted events reconstruct inbound, current Session, logical message, physical parts and outcome',async()=>{
 const rows=[],io=createAgentIO({diagnostics:{enabled:true,onEvent:r=>rows.push(r)}}),record={scope:'dm',peerId:'private-user',sessionId:'private-session',agent:{status:'idle',followup(){}}};
 const c=createConversations(io,{createInput:x=>x,interactionPolicy:()=>undefined})({...context,manager:{async getOrCreate(){return record;},getSessionRecord:()=>record,isCurrentSession:r=>r===record},scopes:{direct:'dm'},admits:()=>true});
 c.registerAdapter({split:t=>t.split('|'),async send(){return {receipt:'private-receipt'};}});
 const input={conversation:context.conversation,sender:{id:'private-user',displayName:'PRIVATE_NICK'},message:{id:'private-input',text:'PRIVATE_BODY'},platformData:{permissions:['owner'],token:'PRIVATE_TOKEN'}};
 const channel=c.openInbound(standard=>c.handoff(standard,{content:standard.message.text}));
 assert.equal((await channel.receive(input)).status,'accepted');assert.equal((await channel.receive(input)).status,'duplicate');
 assert.equal((await io.sendMessage({id:'private-logical',target:c.target(record),origin:{sessionId:record.sessionId},message:{text:'PRIVATE_ONE|PRIVATE_TWO'}})).status,'sent');
 const handed=rows.find(r=>r.event==='input'),receives=rows.filter(r=>r.event==='receive'),sent=rows.find(r=>r.event==='send');
 assert.deepEqual(receives.map(r=>r.status),['accepted','duplicate']);assert.equal(handed.input,receives[0].input);assert.equal(handed.session,sent.session);
 assert.equal(handed.account,sent.account);assert.equal(handed.conversation,sent.conversation);
 const parts=rows.filter(r=>r.event==='part');assert.deepEqual(parts.map(r=>[r.index,r.status]),[[0,'sending'],[0,'sent'],[1,'sending'],[1,'sent']]);assert(parts.every(r=>r.logical===sent.logical));
 assert(!JSON.stringify(rows).includes('PRIVATE_'));c.close();await io.close();
});
test('commands and failed-session replies use I/O without Character, HITL or Notifications; forged input grants reject',async()=>{
 const sent=[],io=createAgentIO();const c=createConversations(io,{createInput:x=>x,interactionPolicy:()=>undefined})({...context,scopes:{direct:'dm'},admits:()=>true,manager:{async getOrCreate(){throw Error('unavailable');},getSessionRecord(){},isCurrentSession:()=>false}});
 c.registerAdapter({split:t=>t.split('|'),async send(route,text){assert(route.inputReply);sent.push(text);}});
 const channel=c.openInbound(async standard=>{const r=await c.handoff(standard,{content:'hello'});assert.equal(r.reason,'session-unavailable');await c.reply(standard,'session error');return r;});
 const input=id=>({conversation:context.conversation,sender:{id:'private-user'},message:{id,text:'hello'}});
 assert.equal((await c.reply(input('forged'),'unsafe')).status,'not-sent');
 await channel.receive(input('error'));
 const commands=c.openCommands();commands.register({name:'help',execute:()=>'one|two'});
 const request={...input('command'),message:{id:'command',text:'/help'}};assert.equal((await commands.dispatch(request)).replied,true);assert.equal((await commands.dispatch(request)).status,'duplicate');
 assert.deepEqual(sent,['session error','one','two']);c.close();assert.equal((await c.reply(request,'late')).status,'not-sent');await io.close();
});
test('unknown outcomes and diagnostic failures preserve at-most-once handoff',async()=>{
 const io=createAgentIO({diagnostics:{enabled:true,onEvent(){throw Error('observer failed');}}});let sends=0;
 io.registerAdapter({...context,resolve:()=>({ok:true}),split:t=>[t],async send(){sends++;throw Error('PRIVATE_NETWORK_ERROR');}});
 const request={id:'logical',target:context,origin:{sessionId:'session'},message:{text:'PRIVATE_BODY'}};
 assert.equal((await io.sendMessage(request)).status,'unknown');assert.equal((await io.sendMessage(request)).duplicate,true);assert.equal(sends,1);
 const rows=io.diagnostics.snapshot();assert(rows.some(r=>r.event==='part'&&r.status==='unknown'));assert(!JSON.stringify(rows).includes('PRIVATE_'));await io.close();
});
test('input replies expire on a monotonic clock and never gain notification or Session authority',async()=>{
 let at=0,captured;const io=createAgentIO(),c=createConversations(io,{now:()=>at,createInput:x=>x,interactionPolicy:()=>undefined})({...context,scopes:{direct:'dm'},admits:()=>true,manager:{getOrCreate(){throw Error('not needed');},getSessionRecord(){},isCurrentSession:()=>false}});
 c.registerAdapter({split:t=>[t],async send(){assert.fail('expired input must not reach platform');}});
 const channel=c.openInbound(standard=>{captured=standard;return {status:'accepted'};});await channel.receive({conversation:context.conversation,sender:{id:'private-user'},message:{id:'expired',text:'test'}});
 at=300_001;await assert.rejects(()=>c.reply(captured,'late'),e=>e.status==='not-sent');c.close();await io.close();
});
test('a command completed after Gateway close cannot report a successful reply',async()=>{
 const io=createAgentIO(),c=createConversations(io,{createInput:x=>x,interactionPolicy:()=>undefined})({...context,scopes:{direct:'dm'},admits:()=>true,manager:{getOrCreate(){},getSessionRecord(){},isCurrentSession:()=>false}});
 c.openInbound(()=>({status:'accepted'}));c.registerAdapter({split:t=>[t],async send(){assert.fail('closed reply must never send');}});
 let release;const pending=new Promise(r=>release=r),commands=c.openCommands();commands.register({name:'work',async execute(){await pending;return 'done';}});
 const result=commands.dispatch({conversation:context.conversation,sender:{id:'private-user'},message:{id:'closing',text:'/work'}});c.close();release();assert.equal((await result).replied,false);await io.close();
});
test('input reply logical ids stay independent when two Conversations reuse a platform message id',async()=>{
 const io=createAgentIO(),sent=[],c=createConversations(io,{createInput:x=>x,interactionPolicy:()=>undefined})({...context,scopes:{direct:'dm'},admits:()=>true,manager:{getOrCreate(){},getSessionRecord(){},isCurrentSession:()=>false}});
 c.openInbound(()=>({status:'accepted'}));c.registerAdapter({split:t=>[t],async send(route,text){sent.push([route.target.id,text]);}});const commands=c.openCommands();commands.register({name:'help',execute:()=>'ok'});
 for(const id of ['room-a','room-b'])assert.equal((await commands.dispatch({conversation:{type:'direct',id},sender:{id},message:{id:'same-platform-id',text:'/help'}})).replied,true);
 assert.deepEqual(sent,[['room-a','ok'],['room-b','ok']]);c.close();await io.close();
});
