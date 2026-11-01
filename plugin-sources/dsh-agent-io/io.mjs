// Unified Agent I/O core. Platform-neutral: it never imports a platform SDK,
// Character or Interaction. Adapters own protocol details (targets, quota,
// chunking, API errors, event parsing); this module owns the logical message.
// Outbound: validation, per-Conversation order, cancellation between parts,
// duplicate suppression and an honest result. Inbound: the standard message
// handoff from an adapter's channel to its trusted Conversation entry, with
// scoped duplicate suppression. Nothing here is durable.
import {createHash} from 'node:crypto';
import {createDiagnostics} from './diagnostics.mjs';

const CODE=/^[a-z][a-z-]{0,39}$/;
const code=(value,fallback)=>typeof value==='string'&&CODE.test(value)?value:fallback;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const freeze=result=>Object.freeze({...result,parts:Object.freeze((result.parts??[]).map(p=>Object.freeze(p)))});
const notSent=(id,reason,stage='before-platform',parts=[])=>freeze({id,status:'not-sent',reason,stage,parts});
// What a logical message id stands for: its Conversation, text and attachments.
// The same id with another fingerprint is a different message, never a retry.
const fingerprint=request=>createHash('sha256').update(JSON.stringify([request.target.conversation.type,request.target.conversation.id,request.message.text??'',
 (request.message.attachments??[]).map(a=>[a.kind,a.name??'',a.resource.type,a.resource.path??a.resource.url]),
 request.message.actions?[request.message.actions.ref,request.message.actions.options.map(o=>o.value)]:null])).digest('hex');

const INBOUND_KEYS=new Set(['conversation','message','sender','timestamp','platformData']);
// Basic media (ADR-057): an attachment is a descriptor. `resource` is the trusted
// reference a Host-side caller or the platform adapter filled in (a checked local
// file or the platform's own URL); it is never model output and never becomes
// model-visible by itself. The adapter maps descriptors to platform upload and
// download; this core only checks their shape.
export const ATTACHMENT_KINDS=Object.freeze(['image','voice','video','file']);
const OUTBOUND_ATTACHMENT_KEYS=new Set(['kind','name','contentType','size','resource']);
const INBOUND_ATTACHMENT_KEYS=new Set([...OUTBOUND_ATTACHMENT_KEYS,'transcript']);
const reference=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\u0000-\u001f]/.test(value);
// Interaction actions (HITL, ADR-054): one choice the platform shows as buttons
// under the message text. Only the HITL Bridge of this package issues them
// (issueActions, not part of the provided service): a Host plugin or the model
// cannot put an approval or answer button on a message. A chosen option comes
// back to the Bridge as a platform event, never as chat input.
const ACTION_REF=/^[A-Za-z0-9_-]{8,64}$/,ACTION_VALUE=/^[A-Za-z0-9_-]{1,16}$/,ACTION_STYLES=['primary','secondary','danger'];
const label=value=>typeof value==='string'&&value.trim().length>0&&value.length<=64;
export const MAX_ACTION_OPTIONS=10;
function attachmentProblem(a,keys,{required,maxText}){
 if(!a||typeof a!=='object'||Array.isArray(a))return 'invalid-message';
 if(Object.keys(a).some(k=>!keys.has(k)))return 'unsupported';
 if(!ATTACHMENT_KINDS.includes(a.kind))return 'unsupported';
 if(a.name!==undefined&&!text(a.name))return 'invalid-message';
 if(a.contentType!==undefined&&!text(a.contentType))return 'invalid-message';
 if(a.size!==undefined&&!(Number.isSafeInteger(a.size)&&a.size>=0))return 'invalid-message';
 if(a.transcript!==undefined&&(typeof a.transcript!=='string'||a.transcript.length>maxText))return 'invalid-message';
 const r=a.resource;
 if(r===undefined)return required?'invalid-message':null;
 if(!r||typeof r!=='object'||Object.keys(r).length!==2)return 'invalid-message';
 if(r.type==='local')return reference(r.path)?null:'invalid-message';
 if(r.type==='remote')return reference(r.url)?null:'invalid-message';
 return 'unsupported';
}
const frozenAttachment=a=>Object.freeze({...a,...(a.resource?{resource:Object.freeze({...a.resource})}:{})});

export function createAgentIO(options={}){
 const maxPerConversation=options.maxPendingPerConversation??32,maxPending=options.maxPending??512,maxConcurrent=options.maxConcurrent??8,maxText=options.maxTextLength??100_000,remember=options.rememberResults??1024;
 const maxAttachments=options.maxAttachments??10,maxInboundAttachments=options.maxInboundAttachments??20;
 const now=options.now??Date.now,onEvent=typeof options.onEvent==='function'?options.onEvent:undefined;
 const diagnostics=createDiagnostics({...options.diagnostics,now});
 const trace=(request,event,fields={})=>diagnostics.scope(request?.target).emit('io',event,{logicalId:request?.id,sessionId:request?.origin?.sessionId,turn:request?.origin?.turn,...fields});
 const adapters=new Map(),conversations=new Map(),results=new Map(),ready=[];
 let pending=0,active=0,closed=false;const running=new Set();
 const channels=new Map(),received=new Map(),inboundWindow=options.inboundWindowMs??86_400_000,rememberInbound=options.rememberInbound??4096;
 const adapterKey=(platform,accountId,adapter='legacy')=>JSON.stringify([platform,adapter,accountId]);
 const issued=new WeakSet();

 /** {ref, options:[{value, label, doneLabel?, style?}]} → frozen actions the I/O accepts on a message. */
 function issueActions(spec){
  const options=spec?.options;
  if(!ACTION_REF.test(spec?.ref??'')||!Array.isArray(options)||!options.length||options.length>MAX_ACTION_OPTIONS)throw Error('Invalid actions');
  const values=new Set();
  const frozen=options.map(o=>{
   if(!ACTION_VALUE.test(o?.value??'')||values.has(o.value)||!label(o.label)||(o.doneLabel!==undefined&&!label(o.doneLabel))||(o.style!==undefined&&!ACTION_STYLES.includes(o.style)))throw Error('Invalid action option');
   values.add(o.value);
   return Object.freeze({value:o.value,label:o.label,...(o.doneLabel===undefined?{}:{doneLabel:o.doneLabel}),...(o.style===undefined?{}:{style:o.style})});
  });
  const actions=Object.freeze({ref:spec.ref,options:Object.freeze(frozen)});
  issued.add(actions);
  return actions;
 }

 function registerAdapter(adapter){
  if(closed)throw Error('Agent I/O closed');
  if(!adapter||!text(adapter.platform)||!text(adapter.accountId))throw Error('Adapter requires platform and accountId');
  for(const m of ['resolve','split','send'])if(typeof adapter[m]!=='function')throw Error('Adapter requires '+m+'()');
  if(adapter.adapter!==undefined&&!text(adapter.adapter))throw Error('Invalid adapter identity');
  const key=adapterKey(adapter.platform,adapter.accountId,adapter.adapter);
  if(adapters.has(key))throw Error('An adapter is already registered for this platform account');
  const entry={adapter};adapters.set(key,entry);
  diagnostics.scope(adapter).emit('io','attach');
  return ()=>{if(adapters.get(key)===entry){adapters.delete(key);diagnostics.scope(adapter).emit('io','detach');}};
 }

 // Only the shape is checked here; whether the origin may reach the target is
 // the adapter's decision against its trusted routing records, at send time.
 function validate(request){
  const target=request?.target,conversation=target?.conversation,message=request?.message;
  if(!target||!text(target.platform)||!text(target.accountId)||(target.adapter!==undefined&&!text(target.adapter))||!conversation||!['direct','group'].includes(conversation.type)||!text(conversation.id))return 'invalid-target';
  if(!request.origin||typeof request.origin!=='object')return 'unauthorized';
  if(!message||typeof message!=='object')return 'invalid-message';
  if(Object.keys(message).some(k=>!['text','attachments','actions'].includes(k)))return 'unsupported';
  // Actions only as issued by the Bridge, under a text, never with attachments.
  if(message.actions!==undefined){
   if(!issued.has(message.actions))return 'unauthorized';
   if(message.attachments!==undefined)return 'unsupported';
   if(typeof message.text!=='string'||!message.text.trim())return 'invalid-message';
  }
  const attachments=message.attachments;
  if(attachments!==undefined){
   if(!Array.isArray(attachments)||!attachments.length)return 'invalid-message';
   if(attachments.length>maxAttachments)return 'too-large';
   for(const a of attachments){const problem=attachmentProblem(a,OUTBOUND_ATTACHMENT_KEYS,{required:true,maxText});if(problem)return problem;}
  }
  // Text alone, attachments alone, or a caption with attachments.
  if(message.text!==undefined&&typeof message.text!=='string')return 'invalid-message';
  if(!attachments&&!message.text?.trim())return 'invalid-message';
  if((message.text?.length??0)>maxText)return 'too-large';
  if(request.id!==undefined&&!text(request.id))return 'invalid-message';
  return null;
 }

 function sendMessage(request){
  // No id means no duplicate suppression; an id is never invented here.
  const id=typeof request?.id==='string'?request.id:undefined;
  const invalid=validate(request);
  if(invalid)return Promise.resolve(report(request,notSent(id,invalid),now()));
  if(closed)return Promise.resolve(report(request,notSent(id,'closed'),now()));
  const {platform,accountId,conversation}=request.target;
  const scope=adapterKey(platform,accountId,request.target.adapter),key=JSON.stringify([scope,conversation.type,conversation.id]);
  // Ids are scoped to the platform account. Within it a logical message is handed
  // over at most once per process: the same id with the same Conversation and
  // text (repeated event, settlement, a second internal caller) gets the first
  // result; the same id with another target or text is refused as a conflict.
  const idKey=id===undefined?undefined:JSON.stringify([scope,id]),print=id===undefined?undefined:fingerprint(request);
  const known=idKey===undefined?undefined:results.get(idKey);
  if(known){
   if(known.fingerprint!==print)return Promise.resolve(report(request,notSent(id,'id-conflict'),now()));
   return known.promise.then(result=>freeze({...result,duplicate:true}));
  }
  let conv=conversations.get(key);
  if(pending>=maxPending||(conv?(conv.jobs.length+(conv.running?1:0)):0)>=maxPerConversation)return Promise.resolve(report(request,notSent(id,'queue-full'),now()));
  if(!conv)conversations.set(key,conv={key,jobs:[],running:false,waiting:false});
  const job={id,request,adapterKey:scope,entry:adapters.get(scope),started:now()};
  const promise=new Promise(resolve=>{job.resolve=resolve;});
  if(idKey!==undefined){
   // Bounded: the oldest settled ids are forgotten first. An id still queued or
   // in flight is never evicted, so it cannot be handed over twice at once.
   const entry={fingerprint:print,promise,settled:false};results.set(idKey,entry);promise.then(()=>{entry.settled=true;});
   for(const [k,e] of results){if(results.size<=remember)break;if(e.settled)results.delete(k);}
  }
  pending++;conv.jobs.push(job);
  trace(request,'queued',{status:'pending'});
  schedule(conv);
  return promise;
 }

 function schedule(conv){if(conv.running||conv.waiting||!conv.jobs.length)return;conv.waiting=true;ready.push(conv);pump();}
 function pump(){
  while(active<maxConcurrent&&ready.length){
   const conv=ready.shift();conv.waiting=false;conv.running=true;active++;
   const job=conv.jobs.shift();
   const run=execute(job);running.add(run);
   run.then(result=>{running.delete(run);pending--;active--;conv.running=false;job.resolve(report(job.request,result,job.started));if(conv.jobs.length)schedule(conv);else if(!conv.waiting)conversations.delete(conv.key);pump();});
  }
 }

 async function execute(job){
  const {id,request}=job,cancelled=()=>request.signal?.aborted===true;
  if(closed)return notSent(id,'closed');
  if(cancelled())return notSent(id,'cancelled');
  const check=()=>{
   const entry=adapters.get(job.adapterKey);if(!entry||entry!==job.entry)return {reason:'adapter-unavailable'};
   let resolved;try{resolved=entry.adapter.resolve(request.target,request.origin);}catch{return {reason:'adapter-error'};}
   return resolved?.ok===true?{adapter:entry.adapter,route:resolved.route}:{reason:code(resolved?.reason,'unauthorized')};
  };
  let current=check();if(current.reason)return notSent(id,current.reason);
  // Parts in order: the text chunks (if any), then one part per attachment.
  const body=request.message.text?.trim()?request.message.text:undefined,attachments=request.message.attachments??[];
  let texts=[];
  if(body!==undefined){
   try{texts=current.adapter.split(body);}catch{texts=null;}
   if(!Array.isArray(texts)||!texts.length||texts.some(p=>typeof p!=='string'||!p))return notSent(id,'adapter-error');
  }
  // Every attachment must be accepted before anything is sent, so an
  // unsupported kind or resource never leaves a partial message behind.
  if(attachments.length){
   if(typeof current.adapter.sendAttachment!=='function')return notSent(id,'unsupported');
   for(const a of attachments){let ok;try{ok=current.adapter.accepts?current.adapter.accepts(a)===true:true;}catch{ok=false;}if(!ok)return notSent(id,'unsupported');}
  }
  // Actions go with the last text part; the adapter must be able to show them.
  const actions=request.message.actions;
  if(actions){let ok;try{ok=current.adapter.acceptsActions?.(actions)===true;}catch{ok=false;}if(!ok)return notSent(id,'unsupported');}
  const parts=[...texts.map((value,n)=>({text:value,...(actions&&n===texts.length-1?{actions}:{})})),...attachments.map((attachment,n)=>({attachment,n}))];
  const done=[];let failure;
  for(let index=0;index<parts.length;index++){
   if(index>0){
    // Re-check between parts: cancellation, shutdown, rotation or revoked access
    // stops what has not reached the platform. Earlier parts stay sent.
    const stop=closed?'closed':cancelled()?'cancelled':(current=check()).reason;
    if(stop){failure={status:'skipped',reason:stop};break;}
   }
   const part=parts[index],media=part.attachment?{attachment:part.n}:part.actions?{actions:true}:{};
   try{
    const info={messageId:id,index,count:parts.length,...(part.actions?{actions:part.actions}:{})};
    trace(request,'part',{status:'sending',index,count:parts.length});
    const receipt=part.attachment?await current.adapter.sendAttachment(current.route,part.attachment,info):await current.adapter.send(current.route,part.text,info);
    trace(request,'part',{status:'sent',index,count:parts.length,receiptId:receipt?.receipt});
    done.push({index,status:'sent',...media,...(text(receipt?.receipt)?{receipt:receipt.receipt}:{}),...(text(receipt?.uploaded)?{uploaded:receipt.uploaded}:{})});
   }catch(error){
    let c;try{c=current.adapter.classify?.(error);}catch{}
    const outcome=c?.outcome==='not-sent'?'not-sent':'unknown';
    failure={status:outcome,reason:code(c?.reason,outcome==='unknown'?'unknown-outcome':'platform-rejected'),stage:c?.stage==='before-platform'?'before-platform':'platform'};
    trace(request,'part',{status:outcome,reason:failure.reason,stage:failure.stage,index,count:parts.length});
    done.push({index,status:outcome,...media,reason:failure.reason});
    break;
   }
  }
  for(let index=done.length;index<parts.length;index++)done.push({index,status:'skipped',...(parts[index].attachment?{attachment:parts[index].n}:parts[index].actions?{actions:true}:{})});
  if(!failure)return freeze({id,status:'sent',parts:done});
  const sent=done.some(p=>p.status==='sent');
  // An unknown part makes the whole message unknown: it must not be resent.
  if(failure.status==='unknown')return freeze({id,status:'unknown',reason:failure.reason,parts:done});
  if(sent)return freeze({id,status:'partial',reason:failure.reason,parts:done});
  return notSent(id,failure.reason,failure.stage,done);
 }

 // -- Inbound --
 // A channel is the capability to submit messages for one platform account;
 // only the adapter that opened it holds it, so platform, adapter and account
 // are never taken from the message. `deliver` is the adapter's trusted
 // Conversation entry (Host admission, Conversation Manager, native Agent
 // input). Model input never reaches this layer.
 function openInbound(channel){
  if(closed)throw Error('Agent I/O closed');
  if(!channel||!text(channel.platform)||!text(channel.adapter)||!text(channel.accountId))throw Error('Inbound channel requires platform, adapter and accountId');
  if(typeof channel.deliver!=='function')throw Error('Inbound channel requires deliver()');
  const key=adapterKey(channel.platform,channel.accountId,channel.adapter);
  if(channels.has(key))throw Error('An inbound channel is already open for this platform account');
  const entry={channel,open:true};channels.set(key,entry);
  const close=()=>{entry.open=false;if(channels.get(key)===entry)channels.delete(key);};
  return Object.freeze({receive:message=>receive(entry,message),claim:message=>claim(entry,message),close});
 }

 // Marks one platform message as consumed in the same duplicate scope as
 // receive(), without delivering it: a command handled by the I/O command
 // router can then neither run twice nor reach the Agent through receive().
 //   claimed      first sighting (also for a message without a platform id)
 //   duplicate    in flight or already settled within the window
 //   unavailable  channel closed or invalid shape
 function claim(entry,message){
  const conversation=message?.conversation,id=message?.message?.id;
  const done=status=>{diagnostics.scope({...entry.channel,conversation}).emit('io','claim',{inputId:id,status});return status;};
  if(closed||!entry.open)return done('unavailable');
  if(!conversation||!['direct','group'].includes(conversation.type)||!text(conversation.id))return done('unavailable');
  if(id===undefined)return done('claimed');
  if(!text(id))return done('unavailable');
  const {platform,adapter,accountId}=entry.channel,at=now(),key=JSON.stringify([platform,adapter,accountId,conversation.type,conversation.id,id]);
  const known=received.get(key);
  if(known&&(!known.settled||at-known.at<inboundWindow))return done('duplicate');
  received.delete(key);received.set(key,{settled:true,at});
  for(const [k,e] of received){if(received.size<=rememberInbound)break;if(e.settled)received.delete(k);}
  return done('claimed');
 }

 function validateInbound(message){
  if(!message||typeof message!=='object'||Object.keys(message).some(k=>!INBOUND_KEYS.has(k)))return 'invalid-message';
  const {conversation,sender}=message,body=message.message;
  if(!conversation||!['direct','group'].includes(conversation.type)||!text(conversation.id))return 'invalid-target';
  if(!sender||!text(sender.id))return 'unauthorized';
  if(!body||typeof body!=='object')return 'invalid-message';
  if(Object.keys(body).some(k=>!['id','text','attachments','quote'].includes(k)))return 'unsupported';
  if(body.id!==undefined&&!text(body.id))return 'invalid-message';
  if(typeof body.text!=='string')return 'invalid-message';
  if(body.text.length>maxText)return 'too-large';
  const list=value=>{
   if(value===undefined)return null;
   if(!Array.isArray(value))return 'invalid-message';
   if(value.length>maxInboundAttachments)return 'too-large';
   for(const a of value){const problem=attachmentProblem(a,INBOUND_ATTACHMENT_KEYS,{required:false,maxText});if(problem)return problem;}
   return null;
  };
  const own=list(body.attachments);if(own)return own;
  // A quoted (replied-to) message the platform resolved: what it said and carried.
  const quote=body.quote;
  if(quote!==undefined){
   if(!quote||typeof quote!=='object'||Object.keys(quote).some(k=>!['id','text','attachments'].includes(k)))return 'invalid-message';
   if(quote.id!==undefined&&!text(quote.id))return 'invalid-message';
   if(quote.text!==undefined&&(typeof quote.text!=='string'||quote.text.length>maxText))return 'invalid-message';
   const quoted=list(quote.attachments);if(quoted)return quoted;
  }
  return null;
 }
 function frozenBody(body){
  const out={...body};
  if(body.attachments)out.attachments=Object.freeze(body.attachments.map(frozenAttachment));
  if(body.quote)out.quote=Object.freeze({...body.quote,...(body.quote.attachments?{attachments:Object.freeze(body.quote.attachments.map(frozenAttachment))}:{})});
  return Object.freeze(out);
 }

 // One platform message is handed to the Agent at most once per process within
 // its scope (platform, account, Conversation, platform message id), even when
 // duplicates arrive concurrently. The result says what happened to this
 // delivery, never that the Agent has processed it:
 //   accepted   handed to the Conversation entry (native input created)
 //   duplicate  the same message is in flight or already settled here
 //   rejected   refused before any Agent input (invalid, unauthorized, closed)
 //   failed     the entry failed; stage 'before-handoff' proves no Agent input
 //              was created (a platform re-delivery may be processed), stage
 //              'unknown' may follow an input and is never replayed.
 async function receive(entry,message){
  const started=now(),done=result=>reportInbound(entry.channel,result,started,message);
  if(closed||!entry.open)return done({status:'rejected',reason:'closed'});
  const invalid=validateInbound(message);if(invalid)return done({status:'rejected',reason:invalid});
  const {platform,adapter,accountId}=entry.channel,id=message.message.id;
  const key=id===undefined?undefined:JSON.stringify([platform,adapter,accountId,message.conversation.type,message.conversation.id,id]);
  if(key!==undefined){
   const known=received.get(key);
   if(known&&(!known.settled||started-known.at<inboundWindow))return done({status:'duplicate'});
   received.delete(key);received.set(key,{settled:false,at:started});
   // Bounded: the oldest settled entries go first; in-flight ones never.
   for(const [k,e] of received){if(received.size<=rememberInbound)break;if(e.settled)received.delete(k);}
  }
  const standard=Object.freeze({platform,adapter:entry.channel.adapter,accountId,conversation:Object.freeze({...message.conversation}),message:frozenBody(message.message),sender:Object.freeze({...message.sender}),timestamp:message.timestamp,platformData:message.platformData});
  let result;
  try{
   const outcome=await entry.channel.deliver(standard);
   result=outcome?.status==='accepted'?{status:'accepted'}
    :outcome?.status==='rejected'?{status:'rejected',reason:code(outcome.reason,'unauthorized')}
    :outcome?.status==='not-delivered'?{status:'failed',stage:'before-handoff',reason:code(outcome.reason,'entry-failed')}
    :{status:'failed',stage:'unknown',reason:'invalid-outcome'};
  }catch{result={status:'failed',stage:'unknown',reason:'entry-error'};}
  if(key!==undefined){
   const record=received.get(key);
   if(result.stage==='before-handoff')received.delete(key);else if(record){record.settled=true;record.at=now();}
  }
  return done(result);
 }

 function reportInbound(channel,result,started,message){
  diagnostics.scope({...channel,conversation:message?.conversation}).emit('io','receive',{inputId:message?.message?.id,status:result.status,reason:result.reason,stage:result.stage,elapsedMs:Math.max(0,now()-started)});
  try{onEvent?.({event:'receive',platform:code(channel?.platform,'unknown'),status:result.status,reason:result.reason,stage:result.stage,elapsedMs:Math.max(0,now()-started)});}catch{}
  return Object.freeze(result);
 }

 function report(request,result,started){
  trace(request,'send',{status:result.status,reason:result.reason,stage:result.stage,elapsedMs:Math.max(0,now()-started)});
  try{onEvent?.({event:'send',platform:code(request?.target?.platform,'unknown'),status:result.status,reason:result.reason,parts:result.parts.length,elapsedMs:Math.max(0,now()-started)});}catch{}
  return result;
 }

 async function close(){
  closed=true;
  for(const conv of conversations.values())for(const job of conv.jobs.splice(0)){pending--;job.resolve(report(job.request,notSent(job.id,'closed'),job.started));}
  ready.length=0;
  await Promise.all([...running]);
  adapters.clear();
  for(const entry of channels.values())entry.open=false;
  channels.clear();received.clear();
 }

 return Object.freeze({sendMessage,registerAdapter,openInbound,issueActions,diagnostics,close});
}
