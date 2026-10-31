// QQ Official basic media through the Unified Agent I/O. Runs the reviewed
// sources (gateway bridge and adapter registration, sendMedia, qqbot_send_file,
// inbound normalization and body assembly) on the real I/O core and Conversation
// wiring, with real temporary files and a fake QQ bot. Proves wiring, refusals
// and result semantics, not QQ upload or phone delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
import {stat,realpath} from 'node:fs/promises';
import {createAgentIO} from '../plugin-sources/dsh-agent-io/io.mjs';
import {qqAdapter,qqConversation,createTurnControls} from './qq-conversation-fixture.mjs';

const dist=new URL('./qqbot-src/dist/',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,dist),'utf8').replaceAll('\r\n','\n');
const strip=source=>source.replace(/^import [^;]*;\n/gm,'').replace(/^export (?=(?:async )?function|class|const)/gm,'');
const slice=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,start);return source.slice(a,b);};
const tick=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
class ApiError extends Error{name='ApiError';constructor(status){super('API Error');this.httpStatus=status;}}

// Real files: media root, agent cwd, and a directory outside both.
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qq-media-'))),media=path.join(root,'media'),cwd=path.join(root,'cwd'),outside=path.join(root,'outside');
for(const d of [media,cwd,outside])fs.mkdirSync(d);
const file=(dir,name,body='x')=>{const p=path.join(dir,name);fs.writeFileSync(p,body);return p;};
const real=p=>fs.realpathSync(p);
let junctions=true;try{fs.symlinkSync(outside,path.join(cwd,'escape'),'junction');}catch{junctions=false;}
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

const {ReplyLimiter}=vm.runInNewContext(strip(read('transport/reply-limiter.js'))+'\n;({ReplyLimiter})');
const {resolveReplyTarget,sendResolvedMarkdown}=vm.runInNewContext(strip(read('transport/reply-target.js'))+'\n;({resolveReplyTarget,sendResolvedMarkdown})',{MsgType:{MARKDOWN:2},getCachedReplyIds:()=>[]});
const fileTool=vm.runInNewContext(strip(read('media/send-file-tool.js'))+'\n;({registerSendFileTool,verifyLocalFile,attachmentKind})',{stat,realpath,createHash,basename:path.basename,isAbsolute:path.isAbsolute,relative:path.relative,resolve:path.resolve,MEDIA_ROOT:media,process,AbortSignal});
const bootstrap=read('gateway/bootstrap.js');
const {sendMedia}=vm.runInNewContext(strip(slice(bootstrap,'const MEDIA_TYPES','export async function bootstrapGateway'))+'\n;({sendMedia})',{verifyLocalFile:fileTool.verifyLocalFile,resolveReplyTarget,MediaFileType:{IMAGE:1,VIDEO:2,VOICE:3,FILE:4},process});

function mediaBot(){
 const calls=[],uploadFailures=[],messageFailures=[],gates=[];
 return {calls,uploadFailures,messageFailures,gates,creds:{appId:'app-a'},
  sendMarkdown:async(target,content)=>{const g=gates.shift();if(g)await g;calls.push({stage:'text',msgId:target.msgId,content});return {id:'text-'+calls.length};},
  send:async opts=>{calls.push({stage:'text',msgId:undefined,content:opts.markdown.content});return {id:'text-'+calls.length};},
  async uploadMedia(opts){calls.push({stage:'upload',fileType:opts.fileType,localPath:opts.localPath,fileName:opts.fileName,srvSendMsg:opts.srvSendMsg,targetId:opts.target.targetId});const f=uploadFailures.shift();if(f)throw f;return {file_uuid:'uuid-'+calls.length,file_info:'info-'+calls.length};},
  mediaApi:{async sendMediaMessage(scope,targetId,info,creds,opts){calls.push({stage:'message',scope,targetId,info,msgId:opts.msgId});const f=messageFailures.shift();if(f)throw f;return {id:'media-'+calls.length};}},
 };
}
function gateway({access={c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'disabled',groupAllow:[]}}={}){
 const io=createAgentIO(),requests=[],spy={...io,sendMessage:r=>{requests.push(r);return io.sendMessage(r);}};
 const agent={id:'agent-1'},record={sessionKey:'qqbot:app-a:c2c:owner',sessionId:'s1',agent,replyTarget:{scope:'c2c',targetId:'owner',msgId:'m1'},scope:'c2c',peerId:'owner'};
 const sessions=new Map([['c2c:owner',record]]),agents=new Map([['s1',agent]]);
 const manager={getOrCreate:async()=>record,getSessionRecord:(s,p)=>sessions.get(s+':'+p),findBySessionId:id=>[...sessions.values()].find(r=>r.sessionId===id),findByAgent:a=>[...sessions.values()].find(r=>r.agent===a),
  isCurrentSession:r=>sessions.get(r.scope+':'+r.peerId)===r&&agents.get(r.sessionId)===r.agent,approvalChannel:{pending:new Map()},questionChannel:{pending:new Map()}};
 const logs=[],logger={info:m=>logs.push(['info',m]),debug(){},warn:m=>logs.push(['warn',m]),error:m=>logs.push(['error',m])};
 const config={appId:'app-a',textChunkLimit:4500,access,sendFile:{restrictPaths:true,extraRoots:[]},cwd};
 const bot=mediaBot(),cleanups=[],defs=[],ctx={get:n=>n==='tools'?{register:d=>defs.push(d)}:undefined,effect:f=>cleanups.push(f())};
 const conversation=qqConversation({io:spy,manager,config});
 // The gateway's own sender, bridge (submit, Turn controls) and adapter registration, as reviewed.
 const {sender,replyLimiter}=vm.runInNewContext('(function(){'+slice(bootstrap,'    const replyLimiter = new ReplyLimiter({ limit: 4 });','    // Optional Agent policy. No Character')+';return {sender,replyLimiter};})()',{ReplyLimiter,deliveryRecorder:null,bot,resolveReplyTarget,sendResolvedMarkdown});
 const handler=vm.runInNewContext('(function(){'+slice(bootstrap,'    const policyFor =','    return outboundHandler;')+';return outboundHandler;})()',
  {ctx,manager,sender,config,logger,toolsRegistry:undefined,diagnostics:null,io:spy,conversation,createOutboundHandler:()=>()=>{},createTurnControls,AbortController,AbortSignal,randomUUID});
 vm.runInNewContext('(function(){'+slice(bootstrap,'    // Unified Agent I/O text adapter',"    ctx\n        .on('session/event'")+'})()',
  {conversation,createQQTextAdapter:qqAdapter.createQQTextAdapter,config,chunkMarkdownText:t=>[t],sender,diagnostics:null,outboundHandler:handler,ctx,sendMedia,bot,replyLimiter});
 fileTool.registerSendFileTool(ctx,null,manager,config,logger);
 const tool=defs.find(d=>d.name==='qqbot_send_file');
 const turn=n=>handler({header:{id:'s1'}},{type:'turn/start',data:{turn:n}});
 const send=(args,exec={agent})=>tool.execute(args,exec);
 return {io:spy,requests,record,sessions,agents,manager,config,bot,tool,send,turn,logs,conversation};
}
const uploads=g=>g.bot.calls.filter(c=>c.stage==='upload').length;

test('qqbot_send_file sends one attachment message to the current conversation through the Unified I/O',async()=>{
 const g=gateway();g.turn(1);const png=file(media,'chart.png');
 const out=await g.send({file_path:png});
 assert.deepEqual({...out},{fileName:'chart.png',fileSize:1,target:'c2c:owner',fileUuid:'uuid-1',messageId:'media-2'});
 const [req]=g.requests;
 assert.match(req.id,/^qq:s1:1:file:[0-9a-f]{16}$/);assert.deepEqual({...req.origin},{sessionId:'s1'});assert.equal(req.target.conversation.id,'owner');
 assert.deepEqual(JSON.parse(JSON.stringify(req.message)),{attachments:[{kind:'image',name:'chart.png',size:1,resource:{type:'local',path:real(png)}}]});
 assert.deepEqual(g.bot.calls.map(c=>c.stage),['upload','message']);
 assert.equal(g.bot.calls[0].srvSendMsg,false,'upload never sends by itself');assert.equal(g.bot.calls[1].msgId,'m1','passive reply to the current input');
 assert.equal(g.bot.calls[0].fileType,1);
 const doc=file(cwd,'report.pdf');await g.send({file_path:doc});
 assert.equal(g.bot.calls.at(-2).fileType,4);assert.equal(g.bot.calls.at(-2).fileName,'report.pdf');
 assert(!g.logs.some(([,m])=>/owner/.test(m)),'no raw openid in the log');
});
test('the model cannot pick a recipient: another target is refused, the current one is accepted, no record means no send',async()=>{
 const g=gateway({access:{c2cMode:'open',c2cAllow:[],groupMode:'open',groupAllow:[]}});g.turn(1);const png=file(media,'a.png');
 for(const target of ['c2c:someone-else','group:owner','group:grp'])await assert.rejects(g.send({file_path:png,target}),/current conversation/);
 await assert.rejects(g.send({file_path:png,target:'nonsense'}),/格式错误/);
 assert.equal(uploads(g),0,'open access does not let the model reach anyone else');
 await g.send({file_path:png,target:'c2c:owner'});assert.equal(uploads(g),1);
 await assert.rejects(g.send({file_path:png},{agent:{id:'worker'}}),/没有 QQ 会话/);
 await assert.rejects(g.send({file_path:png},{}),/没有 QQ 会话/);
 assert.equal(uploads(g),1);
});
test('the path whitelist holds: outside roots, a junction out of the roots, directories and missing files are refused',async t=>{
 const g=gateway();g.turn(1);
 await assert.rejects(g.send({file_path:file(outside,'secret.txt')}),/不在允许的目录内/);
 await assert.rejects(g.send({file_path:media}),/不是普通文件/);
 await assert.rejects(g.send({file_path:path.join(media,'missing.png')}),/文件不存在/);
 if(junctions){file(outside,'leak.png');await assert.rejects(g.send({file_path:path.join(cwd,'escape','leak.png')}),/不在允许的目录内/,'resolved through the junction');}
 else t.diagnostic('junction creation unavailable; link escape not exercised');
 assert.equal(uploads(g),0);
});
test('a repeated call for the same file in one Turn is not resent; an unknown result is never retried blindly',async()=>{
 const g=gateway();g.turn(1);const png=file(media,'once.png');
 await g.send({file_path:png});await g.send({file_path:png});
 assert.equal(uploads(g),1,'duplicate of the first result');
 g.turn(2);await g.send({file_path:png});assert.equal(uploads(g),2,'a new Turn is a new message');
 g.bot.messageFailures.push(new ApiError(0));const v=file(media,'maybe.mp4');
 await assert.rejects(g.send({file_path:v}),/结果未知.*不会自动重发/);
 await assert.rejects(g.send({file_path:v}),/结果未知/);
 assert.equal(g.bot.calls.filter(c=>c.localPath===real(v)).length,1,'uploaded once, never again');
});
test('upload failures and refusals are provably not sent and may be retried; a rejected media message is not-sent',async()=>{
 const g=gateway();g.turn(1);const png=file(media,'retry.png');
 g.bot.uploadFailures.push(new ApiError(500));
 await assert.rejects(g.send({file_path:png}),/未发送（upload-failed）/);
 assert.equal(g.bot.calls.filter(c=>c.stage==='message').length,0);
 const out=await g.send({file_path:png});assert.equal(out.messageId,'media-3','a provable failure may be retried');
 g.bot.messageFailures.push(new ApiError(400));
 await assert.rejects(g.send({file_path:file(media,'bad.png')}),/未发送（platform-rejected）/);
});
test('send-time checks: revoked access, a rotated Session, /stop and a cancelled tool call stop the file before upload',async()=>{
 const revoked=gateway();revoked.turn(1);revoked.config.access.c2cAllow=[];
 await assert.rejects(revoked.send({file_path:file(media,'r.png')}),/unauthorized/);assert.equal(uploads(revoked),0);
 const rotated=gateway();rotated.turn(1);rotated.agents.delete('s1');
 await assert.rejects(rotated.send({file_path:file(media,'s.png')}),/stale/);assert.equal(uploads(rotated),0);
 const stopped=gateway();stopped.turn(1);let open;stopped.bot.gates.push(new Promise(r=>open=r));
 const ahead=stopped.manager.submitOutput(stopped.record,'先发的文字',{turn:1});await tick();
 const queued=stopped.send({file_path:file(media,'q.png')});await tick();
 stopped.manager.cancelOutput(stopped.record);open();await ahead;
 await assert.rejects(queued,/cancelled/);assert.equal(uploads(stopped),0);
 const aborted=gateway();aborted.turn(1);
 await assert.rejects(aborted.send({file_path:file(media,'c.png')},{agent:aborted.record.agent,signal:AbortSignal.abort()}),/cancelled/);assert.equal(uploads(aborted),0);
});
test('sendMedia re-checks the trusted resource before any upload and classifies each stage',async t=>{
 const g=gateway();g.turn(1);
 const gone=file(media,'gone.png');let open;g.bot.gates.push(new Promise(r=>open=r));
 const ahead=g.manager.submitOutput(g.record,'文字',{turn:1});await tick();
 const queued=g.manager.submitOutput(g.record,{attachments:[{kind:'image',name:'gone.png',resource:{type:'local',path:real(gone)}}]},{turn:1});await tick();
 fs.rmSync(gone);open();await ahead;
 const r=await queued;assert.deepEqual([r.status,r.reason,r.stage],['not-sent','invalid-resource','before-platform']);assert.equal(uploads(g),0);
 // A real path outside the roots handed in directly: the whitelist re-check refuses it.
 const outsideReal=await g.manager.submitOutput(g.record,{attachments:[{kind:'file',resource:{type:'local',path:real(file(outside,'direct.txt'))}}]},{turn:1});
 assert.equal(outsideReal.reason,'invalid-resource','outside the allowed roots at send time');
 if(junctions){
  // A link that stays inside the roots: only the "still its own real path" check catches the redirection.
  fs.symlinkSync(media,path.join(cwd,'inner'),'junction');file(media,'inner.png');
  const redirected=await g.manager.submitOutput(g.record,{attachments:[{kind:'image',resource:{type:'local',path:path.join(cwd,'inner','inner.png')}}]},{turn:1});
  assert.equal(redirected.reason,'invalid-resource','a resource that is not its own real path is refused');
 }else t.diagnostic('junction creation unavailable');
 g.bot.messageFailures.push(new ApiError(503));
 const unknown=await g.manager.submitOutput(g.record,{attachments:[{kind:'file',name:'x.zip',resource:{type:'local',path:real(file(cwd,'x.zip'))}}]},{turn:1});
 assert.deepEqual([unknown.status,unknown.reason],['unknown','platform-unavailable']);
 assert.equal(uploads(g),1);
});
test('text with several attachments: caption first, then each attachment in order; a later failure leaves a partial',async()=>{
 const g=gateway();g.turn(1);const a=real(file(media,'1.png')),b=real(file(cwd,'2.mp4')),c=real(file(cwd,'3.silk'));
 const att=(kind,p)=>({kind,resource:{type:'local',path:p}});
 const ok=await g.manager.submitOutput(g.record,{text:'三个附件',attachments:[att('image',a),att('video',b),att('voice',c)]},{turn:1});
 assert.equal(ok.status,'sent');assert.deepEqual(ok.parts.map(p=>p.attachment),[undefined,0,1,2]);
 assert.deepEqual(g.bot.calls.filter(x=>x.stage!=='message').map(x=>x.stage==='text'?x.content:x.fileType),['三个附件',1,2,3]);
 g.bot.uploadFailures.push(undefined,new ApiError(413));
 const partial=await g.manager.submitOutput(g.record,{attachments:[att('image',a),att('video',b),att('voice',c)]},{turn:1});
 assert.deepEqual([partial.status,partial.reason],['partial','upload-failed']);assert.deepEqual(partial.parts.map(p=>p.status),['sent','not-sent','skipped']);
});
test('unsupported attachments are refused before any part: remote URLs, unknown kinds, and an adapter without media',async()=>{
 const g=gateway();g.turn(1);
 const remote=await g.manager.submitOutput(g.record,{text:'不发',attachments:[{kind:'image',resource:{type:'remote',url:'https://example.invalid/a.png'}}]},{turn:1});
 assert.deepEqual([remote.status,remote.reason],['not-sent','unsupported']);
 const odd=await g.manager.submitOutput(g.record,{attachments:[{kind:'sticker',resource:{type:'local',path:'/x'}}]},{turn:1});
 assert.equal(odd.reason,'unsupported');assert.equal(g.bot.calls.length,0,'not even the caption');
 const io=createAgentIO(),routes={resolve:()=>({ok:true,route:{}}),split:t=>[t],send:async()=>({})};
 io.registerAdapter({platform:'p',accountId:'a',...routes});
 const r=await io.sendMessage({target:{platform:'p',accountId:'a',conversation:{type:'direct',id:'x'}},origin:{sessionId:'s'},message:{attachments:[{kind:'file',resource:{type:'local',path:'/f'}}]}});
 assert.equal(r.reason,'unsupported');
});
test('the replaced path: no direct SDK media send remains outside the I/O adapter',()=>{
 const strip=s=>s.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
 for(const f of ['gateway/bootstrap.js','media/send-file-tool.js'])assert(!/\.send(Image|Video|Voice|File)\(/.test(strip(read(f))),f);
 const tool=strip(read('media/send-file-tool.js'));assert(/manager\.submitOutput\(/.test(tool));assert(!/\bbot\./.test(tool),'the tool holds no QQ bot');
});

// ── Inbound ──
const kinds=ct=>ct==='image'||ct?.startsWith('image/')?'image':ct==='video'||ct?.startsWith('video/')?'video':ct==='voice'||ct?.startsWith('audio/')?'voice':'file';
const inbound=vm.runInNewContext(strip(read('transport/inbound.js'))+'\n;({normalizeQQMessage,deliverInbound})',{QQ_SCOPES:qqAdapter.QQ_SCOPES,classifyContentType:kinds,clearGroupHistory(){},setInterval:()=>0,clearInterval(){}});
const qqCtx=({content='看看',attachments=[],downloaded=[],quote,downloadedQuote}={})=>({message:{kind:'c2c',senderId:'owner',messageId:'in-1',content,attachments},state:{downloadedFiles:downloaded,...(quote?{quote}:{}),...(downloadedQuote?{downloadedQuoteFiles:downloadedQuote}:{})},bot:{sendMarkdown:async()=>{},sendTyping:async()=>{}}});
const sample={
 attachments:[{content_type:'image/png',filename:'p.png',size:10,url:'https://qq.example/p'},{content_type:'application/pdf',filename:'b.pdf',size:1024,url:'https://qq.example/b'},{content_type:'voice',filename:'v.silk',url:'https://qq.example/v',asr_refer_text:' 你好 '}],
 downloaded:[{filename:'p.png',contentType:'image',localPath:'/media/p_1.png',attachment:0}],
 quote:{text:'原话',attachments:[{contentType:'image/jpeg',filename:'q.jpg',url:'https://qq.example/q'}]},downloadedQuote:[{filename:'q.jpg',localPath:'/media/q_1.jpg',attachment:0}],
};
test('inbound: QQ attachments and the quote become descriptors with trusted resources, no raw platform fields',()=>{
 const s=inbound.normalizeQQMessage(qqCtx(sample));
 assert.deepEqual(JSON.parse(JSON.stringify(s.message)),{id:'in-1',text:'看看',attachments:[
  {kind:'image',name:'p.png',contentType:'image/png',size:10,resource:{type:'local',path:'/media/p_1.png'}},
  {kind:'file',name:'b.pdf',contentType:'application/pdf',size:1024,resource:{type:'remote',url:'https://qq.example/b'}},
  {kind:'voice',name:'v.silk',contentType:'voice',transcript:'你好',resource:{type:'remote',url:'https://qq.example/v'}}],
  quote:{text:'原话',attachments:[{kind:'image',name:'q.jpg',contentType:'image/jpeg',resource:{type:'local',path:'/media/q_1.jpg'}}]}});
 const many=inbound.normalizeQQMessage(qqCtx({attachments:Array.from({length:30},(_,i)=>({content_type:'image',filename:i+'.png'}))}));
 assert.equal(many.message.attachments.length,20,'bounded like the I/O contract');
 const bad=inbound.normalizeQQMessage(qqCtx({attachments:[{content_type:'image',filename:'x'.repeat(300),url:'https://a/\u0000'}]}));
 assert.deepEqual(JSON.parse(JSON.stringify(bad.message.attachments)),[{kind:'image',contentType:'image'}],'oversized names and control characters are dropped, not passed on');
});
test('inbound: the I/O accepts and freezes descriptors; the model-visible body is assembled from them as before',async()=>{
 const io=createAgentIO(),inputs=[];
 const record={scope:'c2c',peerId:'owner',sessionId:'s1',agent:{status:'idle',followup:m=>inputs.push(m),whenIdle:async()=>{}}};
 const manager={getOrCreate:async()=>record,getSessionRecord:()=>record,isCurrentSession:r=>r===record};
 const config={appId:'app-a',access:{c2cMode:'allowlist',c2cAllow:['owner'],groupMode:'disabled',groupAllow:[]}};
 const conversation=qqConversation({io,manager,config});let seen;
 const channel=conversation.openInbound(s=>{seen=s;return inbound.deliverInbound(s,conversation,config,{info(){},warn(){},error(){}});});
 const ctx=qqCtx(sample),standard=inbound.normalizeQQMessage(ctx);standard.platformData.hold={};
 assert.equal((await channel.receive(standard)).status,'accepted');
 assert(Object.isFrozen(seen.message.attachments[0].resource)&&Object.isFrozen(seen.message.quote.attachments));
 const body=inputs[0].content[0].text;
 for(const line of ['[Quoted message begins]\n原话\n[Quoted message ends]','看看\n[Voice message] 你好\n[图片] [文件]','- Image: /media/p_1.png','- File: b.pdf (1.0KB)','- ASR: 你好','[Reference attachments]\n  - Image: /media/q_1.jpg'])assert(body.includes(line),line);
 assert(!body.includes('https://qq.example/b'),'a file that was not downloaded is described, its platform URL is not shown');
 // A message with only an attachment is still input.
 const only=inbound.normalizeQQMessage(qqCtx({content:'',attachments:[{content_type:'video/mp4',filename:'m.mp4',url:'https://qq.example/m'}]}));only.message.id='in-2';only.platformData.hold={};
 assert.equal((await channel.receive(only)).status,'accepted');assert.match(inputs[1].content[0].text,/Video: m\.mp4 \(download failed\)[\s\S]*\[视频\]/);
});

// Downloads are associated by attachment index, never by file name.
const downloadsFor=downloadMediaAttachments=>vm.runInNewContext(strip(read('gateway/middleware-setup.js'))+'\n;attachmentDownloads',{downloadMediaAttachments})({media:{enabled:true}},{warn(){},debug(){}});
const collide={
 attachments:[{content_type:'image/png',filename:'image.png',size:1,url:'https://qq.example/A'},{content_type:'image/png',filename:'image.png',size:1,url:'https://qq.example/B'},
  {content_type:'file',filename:'r.pdf',size:1,url:'https://qq.example/C'},{content_type:'file',filename:'r.pdf',size:1,url:'https://qq.example/D'},{content_type:'image/png',size:1,url:'https://qq.example/N'}],
 quote:{text:'q',attachments:[{contentType:'image/jpeg',url:'https://qq.example/Q1'},{contentType:'voice',url:'https://qq.example/QV'},{contentType:'image/jpeg',url:'https://qq.example/Q2'}]},
};
async function associate(download){
 const ctx={message:{kind:'c2c',senderId:'owner',messageId:'in-9',content:'看',attachments:collide.attachments},state:{quote:collide.quote}};
 await downloadsFor(download)(ctx,async()=>{});
 const s=inbound.normalizeQQMessage(ctx),own=s.message.attachments.map(a=>a.resource),quoted=s.message.quote.attachments.map(a=>a.resource);
 return {own,quoted};
}
function assertOwnFiles({own,quoted},content){
 assert.equal(content(own[0]),'https://qq.example/A');assert.equal(content(own[1]),'https://qq.example/B','same name, different file');
 assert.deepEqual({...own[2]},{type:'remote',url:'https://qq.example/C'},'a failed download keeps its platform URL, never another attachment\'s file');
 assert.equal(content(own[3]),'https://qq.example/D');assert.equal(content(own[4]),'https://qq.example/N','an attachment without a name is downloaded on its own');
 assert.equal(content(quoted[0]),'https://qq.example/Q1');assert.equal(quoted[1].type,'remote','quoted voice is not downloaded');
 assert.equal(content(quoted[2]),'https://qq.example/Q2','quoted attachments without names get their own files');
}
test('inbound downloads: same-name, nameless, failed and quoted attachments each keep their own file',async()=>{
 // Stand-in with the upstream result shape: {filename, contentType, localPath}, nothing for a failure.
 const files=new Map();let n=0;
 const result=await associate(async list=>{
  if(list.length!==1)throw Error('one attachment per download');
  const [a]=list;if(!a.url||kinds(a.content_type)==='voice'||a.url.endsWith('/C'))return [];
  const localPath=`/media/${a.filename||'attachment'}_${++n}`;files.set(localPath,a.url);return [{filename:a.filename,contentType:kinds(a.content_type),localPath}];
 });
 assertOwnFiles(result,r=>r?.type==='local'?files.get(r.path):undefined);
 // Results without an attachment index are never associated by name.
 const s=inbound.normalizeQQMessage(qqCtx({attachments:[{content_type:'image',filename:'p.png',url:'https://qq.example/p'}],downloaded:[{filename:'p.png',localPath:'/media/p_1.png'}]}));
 assert.equal(s.message.attachments[0].resource.type,'remote');
});
const qqbotDist=path.join(process.env.QQBOT_TEST_PROFILE??new URL('../data/profiles/qqbot-validation/',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'node_modules/@tencent-connect/dsh-qqbot/dist');
test('inbound downloads with the installed dsh-qqbot download helper (network stubbed)',{skip:fs.existsSync(path.join(qqbotDist,'transport/attachment.js'))?false:'no validation profile with the installed dsh-qqbot'},async()=>{
 const mediaRoot=fs.mkdtempSync(path.join(os.tmpdir(),'qq-dl-'));
 const crypto=await import('node:crypto');
 const helper=vm.runInNewContext(strip(fs.readFileSync(path.join(qqbotDist,'transport/attachment.js'),'utf8').replaceAll('\r\n','\n'))+'\n;downloadMediaAttachments',{
  mkdirSync:fs.mkdirSync,writeFileSync:fs.writeFileSync,basename:path.basename,extname:path.extname,join:path.join,sep:path.sep,randomBytes:crypto.randomBytes,
  MEDIA_ROOT:mediaRoot,Buffer,URL,AbortSignal,dns:{promises:{resolve4:async()=>['203.0.113.7']}},
  fetch:async url=>url.endsWith('/C')?{ok:false,status:500}:{ok:true,arrayBuffer:async()=>new TextEncoder().encode(url).buffer}});
 try{assertOwnFiles(await associate((list,media,logger)=>helper(list,media,logger)),r=>r?.type==='local'?fs.readFileSync(r.path,'utf8'):undefined);}
 finally{fs.rmSync(mediaRoot,{recursive:true,force:true});}
});
