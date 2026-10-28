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
