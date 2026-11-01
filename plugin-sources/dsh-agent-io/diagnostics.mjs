// Optional, process-local observation only. No authority, persistence or bodies.
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
const components=new Set(['io','conversation','interaction','hitl','notification','remote-ops','qq','identity','spawn']);
const events=new Set(['open','close','attach','detach','receive','claim','input','route','queued','part','send','cancel','reject','settle','recover','enqueue','hold','authorize','state']);
const statuses=new Set(['accepted','duplicate','rejected','failed','claimed','unavailable','pending','sending','sent','not-sent','unknown','partial','cancelled','suppressed','active','closed','allowed-once','done','completed','running','idle','before-handoff','before-platform','platform','skipped']);
const reasons=new Set(['closed','cancelled','unauthorized','invalid-target','stale','session-changed','session-unavailable','interaction-unavailable','adapter-unavailable','adapter-error','invalid-message','queue-full','id-conflict','unsupported','too-large','rate-limited','platform-rejected','unknown-outcome','timeout-or-network','entry-error','entry-failed','invalid-outcome','unverified-source','storage-error','scope','command-error','unknown-request','other']);
const ids={account:'accountId',input:'inputId',session:'sessionId',logical:'logicalId',notification:'notificationId',request:'requestId',receipt:'receiptId'};
export function createDiagnostics({enabled=false,onEvent,capacity=256,now=Date.now}={}){
 const key=randomBytes(32),boot=randomUUID(),listeners=new Set(),rows=[];
 capacity=Number.isInteger(capacity)?Math.min(1024,Math.max(1,capacity)):256;
 const active=()=>enabled||listeners.size>0;
 const observe=(fn,row)=>{try{const value=fn?.(row);if(value&&typeof value.then==='function')Promise.resolve(value).catch(()=>{});}catch{}};
 const hash=(scope,value)=>value===undefined?undefined:createHmac('sha256',key).update(JSON.stringify([scope,String(value)])).digest('hex').slice(0,24);
 function scope(context={}){
  const base=[context.platform,context.adapter,context.accountId];
  const ref=value=>hash(base,value);
  function emit(component,event,fields={}){
   if(!active())return;
   // Diagnostics must never change authorization, send results or native errors.
   try{
    if(!components.has(component)||!events.has(event))return;
    const row={v:1,boot,at:now(),component,event};
    for(const k of ['platform','adapter'])if(typeof context[k]==='string'&&/^[a-z][a-z0-9-]{0,39}$/.test(context[k]))row[k]=context[k];
    const values={...context,...fields};
    for(const [output,input]of Object.entries(ids))if(typeof values[input]==='string')row[output]=ref(values[input]);
    const conv=values.conversation;if(conv&&['direct','group'].includes(conv.type)&&typeof conv.id==='string')row.conversation=ref(JSON.stringify([conv.type,conv.id]));
    for(const k of ['turn','reply','bubble','index','count','elapsedMs','generation'])if(Number.isSafeInteger(values[k])&&values[k]>=0)row[k]=values[k];
    if(statuses.has(values.status))row.status=values.status;
    if(values.reason!==undefined)row.reason=reasons.has(values.reason)?values.reason:'other';
    if(['before-platform','platform','before-handoff','unknown'].includes(values.stage))row.stage=values.stage;
    if(['text','tool','waiting-user'].includes(values.phase))row.phase=values.phase;
    if(['assistant','status','tool-or-error'].includes(values.kind))row.kind=values.kind;
    const frozen=Object.freeze(row);rows.push(frozen);if(rows.length>capacity)rows.shift();
    if(enabled)observe(onEvent,frozen);
    for(const listener of listeners)observe(listener,frozen);
   }catch{}
  }
  return Object.freeze({emit,hash:ref});
 }
 return Object.freeze({scope,subscribe(fn){if(typeof fn!=='function')throw Error('Diagnostic observer required');listeners.add(fn);return()=>listeners.delete(fn);},snapshot:()=>rows.slice(),get enabled(){return active();}});
}
