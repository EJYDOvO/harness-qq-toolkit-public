import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {createConversations} from '../plugin-sources/dsh-agent-io/conversation.mjs';
const incoming={conversation:{type:'direct',id:'same-user'},sender:{id:'same-user'},message:{id:'same-message',text:'synthetic private text'}};
const target={platform:'chat',accountId:'account',conversation:incoming.conversation};
const message=(id='logical')=>({id,target,origin:{sessionId:'session'},message:{text:'one|two'}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('adapter identity is part of inbound duplicate scope, including after HMR',async()=>{
 const io=createAgentIO();let delivered=0;
 const open=adapter=>io.openInbound({platform:'chat',adapter,accountId:'account',deliver:async()=>{delivered++;return {status:'accepted'};}});
 const a=open('official');assert.equal((await a.receive(incoming)).status,'accepted');a.close();
 const b=open('second');assert.equal((await b.receive(incoming)).status,'accepted');assert.equal(delivered,2);await io.close();
});
test('queued and multipart sends cannot acquire a replacement Adapter during HMR',async()=>{
 const io=createAgentIO(),gate=deferred(),started=deferred(),sent=[];
 const old=io.registerAdapter({platform:'chat',accountId:'account',resolve:()=>({ok:true}),split:t=>t.split('|'),async send(_r,t){sent.push('old:'+t);started.resolve();await gate.promise;}});
 const first=io.sendMessage(message()),queued=io.sendMessage(message('queued'));await started.promise;old();
 io.registerAdapter({platform:'chat',accountId:'account',resolve:()=>({ok:true}),split:t=>t.split('|'),async send(_r,t){sent.push('new:'+t);}});gate.resolve();
 assert.equal((await first).status,'partial');assert.equal((await queued).status,'not-sent');assert.deepEqual(sent,['old:one']);await io.close();
});
test('a handoff cannot claim a different Adapter under the same platform account',async()=>{
 let calls=0;
 const wiring=createConversations(createAgentIO(),{createInput:x=>x,interactionPolicy:()=>undefined})({platform:'chat',adapter:'official',accountId:'account',manager:{async getOrCreate(){calls++;},getSessionRecord(){},isCurrentSession:()=>false},admits:()=>true,scopes:{direct:'dm'}});
 const result=await wiring.handoff({...incoming,platform:'chat',adapter:'forged',accountId:'account'},{content:'text'});
 assert.equal(result.reason,'invalid-target');assert.equal(calls,0);wiring.close();
});
test('simulated second Adapter with the same account/user/message strings keeps an independent send namespace',async()=>{
 const io=createAgentIO(),sent=[];
 for(const adapter of ['official','second'])io.registerAdapter({platform:'chat',adapter,accountId:'account',resolve:()=>({ok:true}),split:t=>[t],async send(_r,text){sent.push([adapter,text]);}});
 for(const adapter of ['official','second'])assert.equal((await io.sendMessage({...message('same-id'),target:{...target,adapter}})).status,'sent');
 assert.deepEqual(sent,[['official','one|two'],['second','one|two']]);await io.close();
});
