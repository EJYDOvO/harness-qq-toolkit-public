// Offline assembly of the patched QQ Gateway on a target DSH Host.
// The portable flow installs the pinned dsh-qqbot/qqbot-nodejs with the reviewed
// patches into a new isolated Home; the Host then runs with QQBOT_BASE_URL and
// QQBOT_TOKEN_BASE_URL on a loopback mock (token, /gateway, WebSocket, message
// API) and the model on a loopback OpenAI-compatible stream. Synthetic account,
// Owner and credentials only: no QQ server, real model or production data.
//
//   node maintenance/offline-gateway.mjs --runtime <DSH runtime root> --home <new empty dir outside the repo>
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{WebSocketServer}=require('ws'),portable=require('../scripts/portable.cjs');
const args=process.argv.slice(2),flag=k=>{const i=args.indexOf('--'+k);if(i<0||!args[i+1])throw Error('Required --'+k);return path.resolve(args[i+1]);};
const runtime=flag('runtime'),home=flag('home'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const OWNER='offline-owner',STRANGER='offline-stranger',APP='offline-app',REPLY='OFFLINE_GATEWAY_REPLY';
const seen={token:0,gateway:0,identify:null,model:[],sent:[],other:[]};let socket,seq=1;
const server=http.createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;
 const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
 if(req.method==='POST'&&req.url==='/app/getAppAccessToken'){const b=JSON.parse(body);assert.equal(b.appId,APP);seen.token++;return json({access_token:'offline-token',expires_in:7200});}
 if(req.method==='GET'&&req.url==='/gateway'){seen.gateway++;return json({url:`ws://127.0.0.1:${server.address().port}/ws`});}
 const to=/^\/v2\/users\/([^/]+)\/messages$/.exec(req.url);
 if(req.method==='POST'&&to){seen.sent.push({to:to[1],auth:req.headers.authorization,body:JSON.parse(body)});return json({id:'offline-receipt-'+seen.sent.length,timestamp:new Date().toISOString()});}
 if(req.method==='POST'&&req.url.endsWith('/chat/completions')){
  const request=JSON.parse(body);seen.model.push({stream:request.stream,messages:request.messages?.length});
  const chunk=v=>res.write('data: '+JSON.stringify({id:'offline',object:'chat.completion.chunk',created:0,model:request.model,...v})+'\n\n');
  res.writeHead(200,{'content-type':'text/event-stream'});chunk({choices:[{index:0,delta:{role:'assistant',content:REPLY},finish_reason:null}]});
  chunk({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});res.end('data: [DONE]\n\n');return;
 }
 seen.other.push(req.method+' '+req.url);json({code:404},404);
});
new WebSocketServer({server,path:'/ws'}).on('connection',ws=>{socket=ws;ws.send(JSON.stringify({op:10,d:{heartbeat_interval:30000}}));
 ws.on('message',raw=>{const p=JSON.parse(raw);if(p.op===2){seen.identify={token:p.d?.token,intents:p.d?.intents};ws.send(JSON.stringify({op:0,s:seq++,t:'READY',d:{version:1,session_id:'offline-session',user:{id:'offline-bot',username:'offline',bot:true},shard:[0,1]}}));}else if(p.op===1)ws.send(JSON.stringify({op:11}));});});
const c2c=(sender,id,content)=>socket.send(JSON.stringify({op:0,s:seq++,t:'C2C_MESSAGE_CREATE',d:{id,author:{id:sender,user_openid:sender},content,timestamp:new Date().toISOString()}}));
const until=async(test,ms,what)=>{const end=Date.now()+ms;while(!test()){if(Date.now()>end)throw Error('Timed out waiting for '+what);await sleep(100);}};
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
// app.asar is readable only through the Host's own Electron runtime.
function hostVersion(){
 const exe=path.join(runtime,process.platform==='win32'?'DeepSeek Harness.exe':'deepseek-harness'),out=path.join(path.dirname(home),path.basename(home)+'.version');
 require('node:child_process').spawnSync(exe,['-e',`require('fs').writeFileSync(${JSON.stringify(out)},require(${JSON.stringify(runtime+'/resources/app.asar/dsh/package.json')}).version)`],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true});
 try{return fs.readFileSync(out,'utf8');}finally{fs.rmSync(out,{force:true});}
}
const report={ok:false,runtime:hostVersion(),qqNetwork:false,checks:[]};let host;
try{
 const configFile=path.join(path.dirname(home),path.basename(home)+'.config.json');
 fs.writeFileSync(configFile,JSON.stringify({runtimeRoot:runtime,profileName:'offline',qq:{appId:APP,ownerId:OWNER,appSecretEnv:'OFFLINE_QQ_SECRET'},model:{provider:'offline-model',id:'fixture',baseURL:base+'/v1',apiKeyEnv:'OFFLINE_MODEL_KEY'}}),{flag:'wx'});
 portable.prepare(configFile,home);const installed=portable.install(home);assert(installed.patchesVerified);
 report.checks.push(`Portable Profile installed pinned QQ packages; patched files hash-verified (${installed.packages} local packages)`);
 const m=JSON.parse(fs.readFileSync(home+'/portable-profile.json','utf8'));
 const env={...process.env,DSH_HOME:home,ELECTRON_RUN_AS_NODE:'1',TEMP:home+'/tmp',TMP:home+'/tmp',QQBOT_BASE_URL:base,QQBOT_TOKEN_BASE_URL:base,OFFLINE_QQ_SECRET:'synthetic-secret',OFFLINE_MODEL_KEY:'synthetic-key'};
 fs.mkdirSync(home+'/tmp',{recursive:true});
 const err=fs.openSync(home+'/host.stderr.log','w'),out=fs.openSync(home+'/host.stdout.log','w');
 host=spawn(m.runtime.exe,['--expose-internals',m.runtime.resources+'/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js','--profile',m.profileName,'--port','0','--no-open'],{cwd:home,env,windowsHide:true,stdio:['ignore',out,err]});
 await until(()=>seen.identify,90000,'Gateway IDENTIFY on the loopback mock');
 assert.equal(seen.identify.token,'QQBot offline-token');assert(seen.token>=1&&seen.gateway>=1);
 report.checks.push('Patched Gateway assembled on the Host: token and /gateway from the loopback mock, WebSocket IDENTIFY, READY');
 await sleep(1500);
 c2c(STRANGER,'offline-stranger-1','hello from a stranger');await sleep(4000);
 assert.equal(seen.model.length,0,'A non-allowlisted sender must not reach the model');assert(!seen.sent.some(s=>s.to===STRANGER&&JSON.stringify(s.body).includes(REPLY)));
 report.checks.push('Non-allowlisted C2C sender: no Session turn and no model call');
 c2c(OWNER,'offline-owner-1','hello offline gateway');
 await until(()=>seen.sent.some(s=>s.to===OWNER&&JSON.stringify(s.body).includes(REPLY)),60000,'Owner reply through the message API');
 const reply=seen.sent.find(s=>s.to===OWNER&&JSON.stringify(s.body).includes(REPLY));
 assert.equal(reply.auth,'QQBot offline-token');assert.equal(reply.body.msg_id,'offline-owner-1','Passive reply to the inbound message');assert(seen.model.length>=1);
 const sessions=fs.existsSync(home+'/sessions')?fs.readdirSync(home+'/sessions',{recursive:true}).filter(f=>String(f).endsWith('.zstd')):[];assert(sessions.length>=1,'Native Session persisted');
 report.checks.push('Owner C2C message -> native Session -> model stream -> session/event outbound -> passive reply POST (msg_id kept)');
 const stderr=fs.readFileSync(home+'/host.stderr.log','utf8');assert(!/entries did not activate/.test(stderr),'Inactive plugin entries: '+stderr.slice(0,400));
 report.checks.push('No inactive plugin entries in Host stderr');
 report.requests={token:seen.token,gateway:seen.gateway,model:seen.model.length,sent:seen.sent.map(s=>({to:s.to===OWNER?'owner':s.to===STRANGER?'stranger':'other',msgType:s.body.msg_type})),unexpected:seen.other};
 report.ok=true;
}catch(error){report.error=error.stack;}
finally{
 if(host&&host.exitCode===null){host.kill();await new Promise(r=>{host.once('exit',r);setTimeout(r,5000);});}
 server.close();socket?.terminate();
 console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1;
}
