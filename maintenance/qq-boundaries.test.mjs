import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const profile=process.env.QQBOT_TEST_PROFILE || path.resolve('data/profiles/qqbot-validation');
const moduleUrl=p=>pathToFileURL(path.join(profile,'node_modules/@tencent-connect/dsh-qqbot/dist',p)).href;
const {setupMiddlewares}=await import(moduleUrl('gateway/middleware-setup.js'));
const {registerSendFileTool}=await import(moduleUrl('media/send-file-tool.js'));
const {QuestionChannel}=await import(moduleUrl('features/question-channel.js'));
const logger={debug(){},info(){},warn(){},error(){}};
const defaults={appId:'test',access:{c2cMode:'allowlist',c2cAllow:['owner-openid'],groupMode:'disabled',groupAllow:[]},historyLimit:10,requireMention:true,maxQueue:8,processingTimeoutMs:30000,media:{enabled:false}};
function accessMiddleware(config){const middlewares=[];setupMiddlewares({use:m=>middlewares.push(m)},config,{},logger);return middlewares[2];}
async function allowed(config,kind,id){let passed=false;await accessMiddleware(config)({message:{kind,senderId:id,groupOpenid:id},log:logger,stop(){}},async()=>{passed=true});return passed;}
test('private whitelist allows owner and rejects outsiders; disabled group rejects everyone',async()=>{
  assert.equal(await allowed(defaults,'c2c','owner-openid'),true);
  assert.equal(await allowed(defaults,'c2c','stranger-openid'),false);
  assert.equal(await allowed(defaults,'group','owner-openid'),false);
});
test('empty whitelist fails closed for private and group messages',async()=>{
  const config={...defaults,access:{c2cMode:'allowlist',c2cAllow:[],groupMode:'allowlist',groupAllow:[]}};
  assert.equal(await allowed(config,'c2c','stranger-openid'),false);
  assert.equal(await allowed(config,'group','stranger-openid'),false);
});
test('file delivery rejects a junction escape and disabled/unknown recipients',async(t)=>{
  const dir=fs.mkdtempSync(path.resolve('tmp/qq-file-boundary-'));
  const workspace=path.join(dir,'workspace'),outside=path.join(dir,'outside');
  fs.mkdirSync(workspace);fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace,'ok.txt'),'test only');
  fs.writeFileSync(path.join(outside,'not-allowed.txt'),'test only');
  fs.symlinkSync(outside,path.join(workspace,'escape'),'junction');
  t.after(()=>fs.unlinkSync(path.join(workspace,'escape')));
  let definition;const sent=[];
  const send=async(target,source)=>{sent.push({target,source});return {upload:{file_uuid:'fixture'}}};
  registerSendFileTool({get:()=>({register:d=>{definition=d}})},
    {sendFile:send,sendImage:send,sendVideo:send,sendVoice:send},
    {findByAgent:()=>({replyTarget:{scope:'c2c',targetId:'owner-openid'}})},
    {...defaults,cwd:workspace,sendFile:{restrictPaths:true,extraRoots:[]}},logger);
  await definition.execute({file_path:path.join(workspace,'ok.txt')},{agent:{}});
  assert.equal(sent.length,1);
  await assert.rejects(definition.execute({file_path:path.join(workspace,'escape/not-allowed.txt')},{agent:{}}));
  await assert.rejects(definition.execute({file_path:path.join(workspace,'ok.txt'),target:'group:disabled-group'},{agent:{}}));
  await assert.rejects(definition.execute({file_path:path.join(workspace,'ok.txt'),target:'c2c:stranger-openid'},{agent:{}}));
  assert.equal(sent.length,1);
  // Unlink the junction itself; never recursively traverse it during cleanup.
});
test('question cancellation during send settles immediately instead of waiting for timeout',async()=>{
  let release;const sent=new Promise(r=>{release=r});
  const record={sessionKey:'test',scope:'c2c',senderId:'owner-openid',replyTarget:{targetId:'owner-openid'}};
  const q=new QuestionChannel({}, {sendMarkdown:()=>sent},{askTimeoutMs:5000},logger);
  const controller=new AbortController();
  const answer=q.askViaQQ(record,{signal:controller.signal,questions:[{id:'q',question:'test',options:[]}]});
  const observed=answer.then(()=> 'answered',e=>e.code);
  controller.abort();release();
  const outcome=await Promise.race([observed,new Promise(r=>setTimeout(()=>r('hung'),60))]);
  q.cancelPending('test');
  assert.equal(outcome,'ASK_ABORTED');
});
test('question buttons accept only current nonce, initiating user and integer option; text fallback works',async()=>{
  const record={sessionKey:'buttons',scope:'c2c',senderId:'owner-openid',replyTarget:{targetId:'owner-openid'}};
  const sent=[];
  const q=new QuestionChannel({getSessionRecord:()=>record},{sendMarkdown:async(...args)=>sent.push(args)},{askTimeoutMs:5000},logger);
  const request={questions:[{id:'same-id',question:'test',options:[{label:'A'},{label:'B'}]}]};
  const click=(button,user='owner-openid')=>q.handleInteraction({user_openid:user,data:{resolved:{button_data:JSON.stringify(button)}}});
  const first=q.askViaQQ(record,request);
  const button=JSON.parse(sent[0][2].keyboard.content.rows[0].buttons[0].action.data);
  assert.equal(click({...button,n:'old'}),false);
  assert.equal(click(button,'stranger'),false);
  assert.equal(click({...button,i:0.5}),false);
  assert.equal(click(button),true);
  assert.deepEqual((await first).answers,[{id:'same-id',selected:['A']}]);
  const second=q.askViaQQ(record,request);
  assert.equal(click(button),false);
  assert.equal(q.tryAnswer('c2c','owner-openid','2'),true);
  assert.deepEqual((await second).answers,[{id:'same-id',selected:['B']}]);
  assert.equal(q.pending.size,0);
});
test('late failure of superseded question cannot delete its replacement',async()=>{
  const record={sessionKey:'replace',scope:'c2c',senderId:'owner-openid',replyTarget:{targetId:'owner-openid'}};
  let fail;let count=0;
  const q=new QuestionChannel({getSessionRecord:()=>record},{sendMarkdown:()=> ++count===1?new Promise((_,reject)=>{fail=reject}):Promise.resolve()},{askTimeoutMs:5000},logger);
  const request={questions:[{id:'q',question:'test',options:[]}]};
  const old=q.askViaQQ(record,request).catch(e=>e.code);
  const current=q.askViaQQ(record,request);
  assert.equal(await old,'ASK_ABORTED');
  fail(Error('late delivery failure'));await new Promise(r=>setImmediate(r));
  assert.equal(q.pending.size,1);
  assert.equal(q.tryAnswer('c2c','owner-openid','answer'),true);
  assert.equal((await current).answers[0].custom,'answer');
});
