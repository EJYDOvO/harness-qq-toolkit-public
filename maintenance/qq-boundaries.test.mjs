import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const profile=process.env.QQBOT_TEST_PROFILE || path.resolve('data/profiles/qqbot-validation');
const moduleUrl=p=>pathToFileURL(path.join(profile,'node_modules/@tencent-connect/dsh-qqbot/dist',p)).href;
const {setupMiddlewares}=await import(moduleUrl('gateway/middleware-setup.js'));
const {registerSendFileTool}=await import(moduleUrl('media/send-file-tool.js'));
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
