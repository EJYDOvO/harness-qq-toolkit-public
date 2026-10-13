import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const modulePath = process.env.QQBOT_TEST_PROFILE
  ? pathToFileURL(path.join(process.env.QQBOT_TEST_PROFILE,'node_modules/@tencent-connect/dsh-qqbot/dist/features/approval-channel.js'))
  : new URL('../data/profiles/qqbot-validation/node_modules/@tencent-connect/dsh-qqbot/dist/features/approval-channel.js',import.meta.url);
const { ApprovalChannel } = await import(modulePath.href);

function fixture(send = async () => {}) {
  const record = {sessionKey:'private-owner',scope:'c2c',senderId:'owner',replyTarget:{targetId:'owner'}};
  const manager = {findBySessionId:id=>id==='qq-session'?record:undefined,getSessionRecord:()=>record};
  let handler, cleanup, registrationCount=0;
  const sent=[];
  const channel=new ApprovalChannel(manager,{sendMarkdown:async(...a)=>{sent.push(a);return send(...a)}},{info(){},error(){}});
  const ctx={on:(e,h)=>{handler=h;registrationCount++},effect:f=>{cleanup=f()}};
  channel.install(ctx);channel.install(ctx);
  const controller=new AbortController();
  const request={agent:{id:'qq-session',session:{seq:1,eventAt:()=>({type:'tool/call',data:{callId:'c1',arguments:JSON.stringify({command:'Get-Location'})}})}},toolName:'powershell',callId:'c1',signal:controller.signal};
  const click=(data,user='owner')=>channel.handleInteraction({user_openid:user,data:{resolved:{button_data:JSON.stringify(data)}}});
  const tick=()=>new Promise(r=>setImmediate(r));
  return {channel,ctx,request,controller,sent,click,tick,run:r=>handler(r||request,async()=> 'fallback'),cleanup:()=>cleanup(),count:()=>registrationCount};
}
test('current session API renders command; only exact nonce and owner can approve',async()=>{
  const f=fixture();const p=f.run();await f.tick();assert.equal(f.count(),1);assert.match(f.sent[0][1],/Get-Location/);
  const button=JSON.parse(f.sent[0][2].keyboard.content.rows[0].buttons[0].action.data);
  assert.equal(f.click({...button,n:'stale'}),false);assert.equal(f.click(button,'other-user'),false);
  assert.equal(f.click({...button,d:'unexpected'}),false);assert.equal(f.click(button),true);
  assert.equal(await p,'allowed-once');assert.equal(f.click(button),false);f.cleanup();
});
test('denial, concurrent request, and abort settle without leaking pending approval',async()=>{
  const f=fixture();const p=f.run();assert.equal(await f.run(),'unavailable');await f.tick();
  const deny=JSON.parse(f.sent[0][2].keyboard.content.rows[0].buttons[1].action.data);
  f.click(deny);assert.equal(await p,'rejected');const p2=f.run();f.controller.abort();assert.equal(await p2,'cancelled');f.cleanup();
});
test('pre-aborted request does not send; unrelated sessions fall through',async()=>{
  const f=fixture();f.controller.abort();assert.equal(await f.run(),'cancelled');assert.equal(f.sent.length,0);
  assert.equal(await f.run({...f.request,agent:{id:'unrelated'}}),'fallback');f.cleanup();
});
test('transport failure and plugin disposal fail closed',async()=>{
  const f=fixture(async()=>{throw Error('offline')});assert.equal(await f.run(),'unavailable');f.cleanup();
  const g=fixture();const p=g.run();g.cleanup();assert.equal(await p,'cancelled');
});
