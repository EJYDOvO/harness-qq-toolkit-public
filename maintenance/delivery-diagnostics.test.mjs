import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import vm from 'node:vm';
const source=readFileSync(new URL('./qqbot-src/dist/gateway/bootstrap.js',import.meta.url),'utf8');
const start=source.indexOf('export function createDeliveryRecorder'),end=source.indexOf('/**',start);
const create=vm.runInNewContext(source.slice(start,end).replace('export function','function')+';createDeliveryRecorder;',{
 diagnosticFs:fs,diagnosticPath:resolve,diagnosticHome:homedir,createHmac,randomBytes,randomUUID,setTimeout,clearTimeout,process,
});
test('delivery diagnostics are opt-in, bounded, redacted and stable only within a boot',async t=>{
 await fs.mkdir('tmp',{recursive:true});const dir=await fs.mkdtemp(resolve('tmp','qq-delivery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 assert.equal(create(false,{},dir),null);assert.deepEqual(await fs.readdir(dir),[]);
 const warnings=[],recorder=create(true,{warn:s=>warnings.push(s)},dir),raw='synthetic-private-value',hash=recorder.hash(raw);
 recorder.trace('stream-receipt',{session:hash,receipt:hash,textHash:hash,length:25,index:1,associated:true,text:raw,token:raw,error:raw,receiptRaw:raw});
 recorder.trace('assistant-settlement',{seq:4,turn:2,reply:1});await recorder.flush();
 const text=await fs.readFile(resolve(dir,'delivery.jsonl'),'utf8'),rows=text.trim().split('\n').map(JSON.parse);
 assert(!text.includes(raw));assert.equal(rows.length,2);assert.equal(rows[0].receipt,hash);assert.equal(rows[0].length,25);assert.equal(rows[0].text,undefined);assert.equal(rows[0].error,undefined);
 const second=create(true,{},dir);assert.notEqual(second.hash(raw),hash);await second.close();
 await fs.writeFile(resolve(dir,'delivery.jsonl'),'x'.repeat(1024*1024));recorder.trace('stream-open',{bubble:2});await recorder.flush();
 assert.deepEqual(warnings,[]);assert.equal((await fs.stat(resolve(dir,'delivery.jsonl.1'))).size,1024*1024);assert((await fs.stat(resolve(dir,'delivery.jsonl'))).size<1000);
 await recorder.close();recorder.trace('stream-open',{});assert.equal((await fs.readdir(dir)).length,2);
});
test('diagnostic write errors are contained and do not expose exceptions',async t=>{
 await fs.mkdir('tmp',{recursive:true});const dir=await fs.mkdtemp(resolve('tmp','qq-delivery-error-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const bad=resolve(dir,'file');await fs.writeFile(bad,'fixture');const warnings=[];
 const recorder=create(true,{warn:s=>warnings.push(s)},bad);recorder.trace('stream-request',{});await recorder.close();assert.equal(warnings.length,1);assert(!warnings[0].includes(dir));
});
test('diagnostics label status versus assistant receipts by enum only',async t=>{
 await fs.mkdir('tmp',{recursive:true});const dir=await fs.mkdtemp(resolve('tmp','qq-delivery-kind-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const recorder=create(true,{},dir);
 recorder.trace('static-receipt',{kind:'status',dynamic:true,bubble:1});recorder.trace('stream-receipt',{kind:'assistant',bubble:2});recorder.trace('static-receipt',{kind:'synthetic free text',dynamic:'yes'});await recorder.close();
 const rows=(await fs.readFile(resolve(dir,'delivery.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(r=>[r.kind,r.dynamic]),[['status',true],['assistant',undefined],[undefined,undefined]]);
});
test('diagnostics record suppressed sources as a closed enum',async t=>{
 await fs.mkdir('tmp',{recursive:true});const dir=await fs.mkdtemp(resolve('tmp','qq-delivery-source-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const recorder=create(true,{},dir);
 for(const source of ['subagent-settled','schedule','web','private free text',42])recorder.trace('suppressed',{source});await recorder.close();
 const rows=(await fs.readFile(resolve(dir,'delivery.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(r=>r.source),['subagent-settled','schedule','web','other',undefined]);
});
test('a failed proactive send is traced with its bubble fields and still rejects',async()=>{
 const begin=source.indexOf('    const sender = {'),stop=source.indexOf('    // Optional Agent policy',begin);assert(begin>0&&stop>begin);
 const traces=[],diagnostics={hash:v=>v===undefined?undefined:'a'.repeat(24),trace:(e,f)=>traces.push([e,f])};
 const failure=Object.assign(new Error('rejected'),{httpStatus:403,bizCode:22009});
 const sender=vm.runInNewContext('(function(){'+source.slice(begin,stop)+';return sender;})()',{
  diagnostics,replyLimiter:{},resolveReplyTarget:t=>({...t,msgId:undefined}),
  sendResolvedMarkdown:async()=>{throw failure;},bot:{},
 });
 assert.equal(sender.openStream,undefined,'the gateway sender offers no SDK stream');
 await assert.rejects(sender.sendMarkdown({scope:'c2c',targetId:'owner'},'完整正文',{delivery:{kind:'assistant',bubble:2}}),/rejected/);
 const row=traces.find(([e])=>e==='static-failure');assert(row);assert.equal(row[1].httpStatus,403);assert.equal(row[1].bizCode,22009);assert.equal(row[1].length,4);assert.equal(row[1].bubble,2);assert.equal(row[1].passive,false);
 assert(!traces.some(([e])=>e==='static-receipt'));
});
test('interjection decisions are recorded as closed enums only',async t=>{
 await fs.mkdir('tmp',{recursive:true});const dir=await fs.mkdtemp(resolve('tmp','qq-delivery-intervene-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const recorder=create(true,{},dir);
 recorder.trace('intervene',{decision:'priority',phase:'text',why:'judge'});recorder.trace('intervene',{decision:'free text',phase:'secret',why:'用户原话'});await recorder.close();
 const rows=(await fs.readFile(resolve(dir,'delivery.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(r=>[r.decision,r.phase,r.why]),[['priority','text','judge'],[undefined,undefined,undefined]]);
});
test('hang-on draft outcome, superseded judgement and elapsed time are closed enums or numbers',async t=>{
 await fs.mkdir('tmp',{recursive:true});const dir=await fs.mkdtemp(resolve('tmp','qq-delivery-draft-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const recorder=create(true,{},dir);
 recorder.trace('hang-on-draft',{draft:'ready',elapsedMs:1834});recorder.trace('hang-on',{draft:'late',dynamic:false});
 recorder.trace('intervene',{decision:'revise',phase:'text',why:'superseded',elapsedMs:912});
 recorder.trace('hang-on-draft',{draft:'嗯，稍等',elapsedMs:'1834'});await recorder.close();
 const rows=(await fs.readFile(resolve(dir,'delivery.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(r=>[r.event,r.draft,r.elapsedMs,r.why]),[['hang-on-draft','ready',1834,undefined],['hang-on','late',undefined,undefined],['intervene',undefined,912,'superseded'],['hang-on-draft',undefined,undefined,undefined]]);
});
