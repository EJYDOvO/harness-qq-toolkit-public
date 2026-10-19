import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {apply} from '../plugin-sources/dsh-remote-ops/index.js';
import {PrefsStore} from './qqbot-src/dist/model/prefs-store.js';

test('explicit DSH homes isolate QQ preferences for the same application and peer',t=>{
 const old=process.env.DSH_HOME,root=fs.mkdtempSync(path.resolve('tmp/qq-home-isolation-'));t.after(()=>{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;});
 process.env.DSH_HOME=path.join(root,'a');const a=new PrefsStore(()=>{});a.setPreset('same-app-owner','project-a');
 process.env.DSH_HOME=path.join(root,'b');const b=new PrefsStore(()=>{});assert.equal(b.getPreset('same-app-owner'),undefined);
 process.env.DSH_HOME=path.join(root,'a');assert.equal(new PrefsStore(()=>{}).getPreset('same-app-owner'),'project-a');
});

test('QQ bridge declares real service names supported by bundled Cordis',()=>{
 const source=fs.readFileSync(new URL('./qqbot-src/dist/index.js',import.meta.url),'utf8');
 assert.match(source,/export const inject = \['agents'\]/);
 assert.doesNotMatch(source,/inject\s*=\s*\{\s*required:/);
});

test('long task progress is deduplicated and timeout stops the QQ task tree',async(t)=>{
 const root=fs.mkdtempSync(path.resolve('tmp/remote-monitor-test-')),state=path.join(root,'data/maintenance');
 fs.mkdirSync(path.join(root,'maintenance'));fs.mkdirSync(path.join(state,'jobs'),{recursive:true});
 fs.writeFileSync(path.join(state,'owner.json'),JSON.stringify({openid:'owner'}));
 fs.writeFileSync(path.join(root,'maintenance/remote.cjs'),`module.exports={setFeature(){},tasks(){},jobs(){},queue(){},features:()=>({remoteOps:{enabled:true,notifyAfterSeconds:120,staleAfterSeconds:300,maxTurnSeconds:1800},notifications:{enabled:true}}),stop:async()=>require('fs').writeFileSync(${JSON.stringify(path.join(state,'stopped'))},'yes')};`);
 fs.writeFileSync(path.join(root,'maintenance/ops.cjs'),`module.exports={atomic:(file,value)=>require('fs').writeFileSync(file,value)};`);
 let tick,service,event,now=100000;const cleanup=[],sent=[];
 t.mock.method(Date,'now',()=>now);t.mock.method(globalThis,'setInterval',f=>{tick=f;return 1;});t.mock.method(globalThis,'clearInterval',()=>{});
 apply({agents:{get:()=>({status:'running'})},on:(_,f)=>event=f,provide:(_,v)=>service=v,effect:f=>cleanup.push(f())},{root});
 t.after(()=>cleanup.forEach(f=>f()));
 service.attach({config:{access:{c2cMode:'allowlist',c2cAllow:['owner']}},bot:{on(){}},manager:{getOrCreate:async()=>{},findBySessionId:()=>true},sender:{sendMarkdown:async(_,text)=>sent.push(text)}});
 event({header:{id:'qq'}},{type:'turn/start',data:{turn:1}});
 const poll=async()=>{tick();for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
 now+=121000;await poll();await poll();assert.equal(sent.length,1);assert.match(sent[0],/仍在执行/);
 now+=1800000;await poll();assert(fs.existsSync(path.join(state,'stopped')));assert(sent.some(s=>s.includes('达到运行时限')));
 const count=sent.length;await poll();assert.equal(sent.length,count);
});
test('remote commands enforce pinned private owner even if invoked directly, and preserve re-enable path',async(t)=>{
 const root=fs.mkdtempSync(path.resolve('tmp/remote-ops-test-'));fs.mkdirSync(path.join(root,'maintenance'));fs.mkdirSync(path.join(root,'data/maintenance'),{recursive:true});fs.writeFileSync(path.join(root,'data/maintenance/owner.json'),JSON.stringify({openid:'owner'}));
 fs.writeFileSync(path.join(root,'maintenance/remote.cjs'),`let enabled=true;module.exports={features:()=>({remoteOps:{enabled},notifications:{enabled:false}}),setFeature:(_,v)=>{enabled=v;return {enabled}},queue:async a=>'QUEUED:'+a,jobs:()=>[],tasks:async()=>({running:false}),stop:async()=>({stopped:[]})};`);
 fs.writeFileSync(path.join(root,'maintenance/ops.cjs'),`module.exports={atomic:(file,value)=>require('node:fs').writeFileSync(file,value)};`);
 let service;const clean=[];apply({agents:{},on(){},provide:(_,v)=>service=v,effect:f=>clean.push(f())},{root});t.after(()=>clean.forEach(f=>f()));
 const cmd=service.commands({sessions:new Map()})[0];const call=(user,kind,...args)=>({message:{senderId:user,kind},command:{args}});
 assert.notEqual(cmd.authorized(call('other','c2c')),true);
 assert.notEqual(cmd.authorized(call('owner','group')),true);
 assert.match(await cmd.handler(call('other','c2c','restart')),/仅部署所有者/);
 assert.match(await cmd.handler(call('owner','c2c','restart')),/QUEUED:Restart/);
 await cmd.handler(call('owner','c2c','feature','remoteOps','off'));
 assert.match(await cmd.handler(call('owner','c2c','restart')),/停用/);
 await cmd.handler(call('owner','c2c','feature','remoteOps','on'));
 assert.match(await cmd.handler(call('owner','c2c','restart')),/QUEUED:Restart/);
});

test('standalone Remote Ops needs no installation root, Character or maintenance scripts',async(t)=>{
 const state=fs.mkdtempSync(path.resolve('tmp/standalone-ops-'));const cleanup=[];let service;
 apply({agents:{},get(){},on(){},provide:(_,v)=>service=v,effect:f=>cleanup.push(f())},{ownerId:'standalone-owner',stateDirectory:state});t.after(()=>cleanup.forEach(f=>f()));
 const cmd=service.commands({sessions:new Map()})[0];const c=action=>({message:{senderId:'standalone-owner',kind:'c2c'},command:{args:[action]}});
 assert.match(await cmd.handler(c('features')),/notifications/);
 await assert.rejects(()=>cmd.handler(c('restart')),/backend not configured/);
 assert.throws(()=>service.attach({config:{access:{c2cMode:'allowlist',c2cAllow:['other']}}}),/not admitted/);
 const rt={config:{access:{c2cMode:'allowlist',c2cAllow:['standalone-owner']}},manager:{sessions:new Map(),getOrCreate:async()=>{}},bot:{on(){},off(){}},sender:{sendMarkdown:async()=>{}}};
 const detach=service.attach(rt);assert.throws(()=>service.attach(rt),/already attached/);detach();service.attach(rt)();
});

test('Interaction owns generic hang-on while native frames keep Remote Ops activity current',async(t)=>{
 const state=fs.mkdtempSync(path.resolve('tmp/interaction-ops-')),events=new Map(),clean=[],sent=[];let service,tick,now=100000;
 const agent={id:'fixture-agent',status:'running'};
 t.mock.method(Date,'now',()=>now);t.mock.method(globalThis,'setInterval',f=>{tick=f;return 1;});t.mock.method(globalThis,'clearInterval',()=>{});
 apply({agents:{get:()=>agent},get:n=>n==='agentPresets'?{serviceFor:()=>({contractVersion:1})}:undefined,on:(n,f)=>events.set(n,f),provide:(_n,v)=>service=v,effect:f=>clean.push(f())},{ownerId:'owner',stateDirectory:state});
 t.after(()=>clean.forEach(f=>f()));
 service.attach({config:{access:{c2cMode:'allowlist',c2cAllow:['owner']}},manager:{sessions:new Map(),getOrCreate:async()=>{},findBySessionId:()=>true},bot:{on(){},off(){}},sender:{sendMarkdown:async(_t,text)=>sent.push(text)}});
 events.get('session/event')({header:{id:agent.id}},{type:'turn/start',data:{turn:1}});
 now+=400000;events.get('agent/assistant-stream')({agent,frame:{type:'chunk'}});tick();for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));
 assert.equal(sent.length,0,'No duplicate progress and no false stale alert while streaming');
 events.get('session/event')({header:{id:agent.id}},{type:'turn/end',data:{reason:{kind:'completed'}}});for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));
 assert.equal(sent.length,1);assert.match(sent[0],/长任务已结束/);
});
