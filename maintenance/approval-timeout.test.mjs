import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// Same module resolution as approval.test.mjs: the candidate profile by default,
// QQBOT_TEST_PROFILE for a deployed profile. Synthetic sender and Agent; no QQ network.
const modulePath = process.env.QQBOT_TEST_PROFILE
  ? pathToFileURL(path.join(process.env.QQBOT_TEST_PROFILE,'node_modules/@tencent-connect/dsh-qqbot/dist/features/approval-channel.js'))
  : new URL('../data/profiles/qqbot-validation/node_modules/@tencent-connect/dsh-qqbot/dist/features/approval-channel.js',import.meta.url);
const { ApprovalChannel } = await import(modulePath.href);

function fixture() {
  const record = {sessionKey:'private-owner',scope:'c2c',senderId:'owner',replyTarget:{targetId:'owner'}};
  const manager = {findBySessionId:id=>id==='qq-session'?record:undefined,getSessionRecord:()=>record};
  let handler,cleanup;const sent=[];
  const channel=new ApprovalChannel(manager,{sendMarkdown:async(...a)=>{sent.push(a);}},{info(){},error(){}});
  channel.install({on:(_e,h)=>{handler=h;},effect:f=>{cleanup=f();}});
  const request={agent:{id:'qq-session',session:{seq:1,eventAt:()=>({type:'tool/call',data:{callId:'c1',arguments:JSON.stringify({command:'New-Item C:/x'})}})}},toolName:'powershell',callId:'c1',signal:new AbortController().signal};
  const click=data=>channel.handleInteraction({user_openid:'owner',data:{resolved:{button_data:JSON.stringify(data)}}});
  return {channel,sent,run:()=>handler(request,async()=>'fallback'),click,button:i=>JSON.parse(sent[0][2].keyboard.content.rows[0].buttons[i].action.data),cleanup:()=>cleanup()};
}

test('an unanswered approval is cancelled after five minutes and a late click is refused',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();const pending=f.run();await Promise.resolve();await Promise.resolve();
  assert.equal(f.sent.length,1);const allow=f.button(0);
  t.mock.timers.tick(299_999);assert.equal(f.channel.pending.size,1);
  t.mock.timers.tick(1);assert.equal(await pending,'cancelled');assert.equal(f.channel.pending.size,0);
  assert.equal(f.click(allow),false,'a click after the timeout must not approve anything');f.cleanup();
});

test('a decision before the timeout clears the timer so it cannot settle again',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();const pending=f.run();await Promise.resolve();await Promise.resolve();
  assert.equal(f.click(f.button(1)),true);assert.equal(await pending,'rejected');
  t.mock.timers.tick(300_000);assert.equal(f.channel.pending.size,0);
  const next=f.run();await Promise.resolve();await Promise.resolve();assert.equal(f.channel.pending.size,1,'a later request is unaffected by the old timer');
  f.cleanup();assert.equal(await next,'cancelled');
});
