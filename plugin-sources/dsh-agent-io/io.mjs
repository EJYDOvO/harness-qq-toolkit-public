// Unified Agent I/O, outbound core. Platform-neutral: it never imports a
// platform SDK, Character or Interaction. Adapters own protocol details
// (targets, quota, chunking, API errors); this module owns the logical
// message: validation, per-Conversation order, cancellation between parts,
// duplicate suppression and an honest result. Nothing here is durable.
import {randomUUID} from 'node:crypto';

const CODE=/^[a-z][a-z-]{0,39}$/;
const code=(value,fallback)=>typeof value==='string'&&CODE.test(value)?value:fallback;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const freeze=result=>Object.freeze({...result,parts:Object.freeze((result.parts??[]).map(p=>Object.freeze(p)))});
const notSent=(id,reason,stage='before-platform',parts=[])=>freeze({id,status:'not-sent',reason,stage,parts});

export function createAgentIO(options={}){
 const maxPerConversation=options.maxPendingPerConversation??32,maxPending=options.maxPending??512,maxConcurrent=options.maxConcurrent??8,maxText=options.maxTextLength??100_000,remember=options.rememberResults??1024;
 const now=options.now??Date.now,onEvent=typeof options.onEvent==='function'?options.onEvent:undefined;
 const adapters=new Map(),conversations=new Map(),results=new Map(),ready=[];
 let pending=0,active=0,closed=false;const running=new Set();
 const adapterKey=(platform,accountId)=>JSON.stringify([platform,accountId]);

 function registerAdapter(adapter){
  if(closed)throw Error('Agent I/O closed');
  if(!adapter||!text(adapter.platform)||!text(adapter.accountId))throw Error('Adapter requires platform and accountId');
  for(const m of ['resolve','split','send'])if(typeof adapter[m]!=='function')throw Error('Adapter requires '+m+'()');
  const key=adapterKey(adapter.platform,adapter.accountId);
  if(adapters.has(key))throw Error('An adapter is already registered for this platform account');
  const entry={adapter};adapters.set(key,entry);
  return ()=>{if(adapters.get(key)===entry)adapters.delete(key);};
 }

 // Only the shape is checked here; whether the origin may reach the target is
 // the adapter's decision against its trusted routing records, at send time.
 function validate(request){
  const target=request?.target,conversation=target?.conversation,message=request?.message;
  if(!target||!text(target.platform)||!text(target.accountId)||!conversation||!['direct','group'].includes(conversation.type)||!text(conversation.id))return 'invalid-target';
  if(!request.origin||typeof request.origin!=='object')return 'unauthorized';
  if(!message||typeof message!=='object')return 'invalid-message';
  if(Object.keys(message).some(k=>k!=='text'))return 'unsupported';
  if(typeof message.text!=='string'||!message.text.trim())return 'invalid-message';
  if(message.text.length>maxText)return 'too-large';
  if(request.id!==undefined&&!text(request.id))return 'invalid-message';
  return null;
 }

 function sendMessage(request){
  const id=typeof request?.id==='string'?request.id:randomUUID();
  const invalid=validate(request);
  if(invalid)return Promise.resolve(report(request,notSent(id,invalid),now()));
  if(closed)return Promise.resolve(report(request,notSent(id,'closed'),now()));
  const {platform,accountId,conversation}=request.target;
  const key=JSON.stringify([platform,accountId,conversation.type,conversation.id]);
  // A logical message is sent at most once per process: a repeated id (settlement,
  // model retry, a second internal caller) gets the first send's result.
  const known=request.id===undefined?undefined:results.get(key+'\n'+id);
  if(known)return known.then(result=>freeze({...result,duplicate:true}));
  let conv=conversations.get(key);
  if(pending>=maxPending||(conv?(conv.jobs.length+(conv.running?1:0)):0)>=maxPerConversation)return Promise.resolve(report(request,notSent(id,'queue-full'),now()));
  if(!conv)conversations.set(key,conv={key,jobs:[],running:false,waiting:false});
  const job={id,request,adapterKey:adapterKey(platform,accountId),started:now()};
  const promise=new Promise(resolve=>{job.resolve=resolve;});
  if(request.id!==undefined){results.set(key+'\n'+id,promise);while(results.size>remember)results.delete(results.keys().next().value);}
  pending++;conv.jobs.push(job);schedule(conv);
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
   const entry=adapters.get(job.adapterKey);if(!entry)return {reason:'adapter-unavailable'};
   let resolved;try{resolved=entry.adapter.resolve(request.target,request.origin);}catch{return {reason:'adapter-error'};}
   return resolved?.ok===true?{adapter:entry.adapter,route:resolved.route}:{reason:code(resolved?.reason,'unauthorized')};
  };
  let current=check();if(current.reason)return notSent(id,current.reason);
  let parts;try{parts=current.adapter.split(request.message.text);}catch{parts=null;}
  if(!Array.isArray(parts)||!parts.length||parts.some(p=>typeof p!=='string'||!p))return notSent(id,'adapter-error');
  const done=[];let failure;
  for(let index=0;index<parts.length;index++){
   if(index>0){
    // Re-check between parts: cancellation, shutdown, rotation or revoked access
    // stops what has not reached the platform. Earlier parts stay sent.
    const stop=closed?'closed':cancelled()?'cancelled':(current=check()).reason;
    if(stop){failure={status:'skipped',reason:stop};break;}
   }
   try{
    const receipt=await current.adapter.send(current.route,parts[index],{messageId:id,index,count:parts.length});
    done.push({index,status:'sent',...(text(receipt?.receipt)?{receipt:receipt.receipt}:{})});
   }catch(error){
    let c;try{c=current.adapter.classify?.(error);}catch{}
    const outcome=c?.outcome==='not-sent'?'not-sent':'unknown';
    failure={status:outcome,reason:code(c?.reason,outcome==='unknown'?'unknown-outcome':'platform-rejected'),stage:c?.stage==='before-platform'?'before-platform':'platform'};
    done.push({index,status:outcome,reason:failure.reason});
    break;
   }
  }
  for(let index=done.length;index<parts.length;index++)done.push({index,status:'skipped'});
  if(!failure)return freeze({id,status:'sent',parts:done});
  const sent=done.some(p=>p.status==='sent');
  // An unknown part makes the whole message unknown: it must not be resent.
  if(failure.status==='unknown')return freeze({id,status:'unknown',reason:failure.reason,parts:done});
  if(sent)return freeze({id,status:'partial',reason:failure.reason,parts:done});
  return notSent(id,failure.reason,failure.stage,done);
 }

 function report(request,result,started){
  try{onEvent?.({event:'send',platform:code(request?.target?.platform,'unknown'),status:result.status,reason:result.reason,parts:result.parts.length,elapsedMs:Math.max(0,now()-started)});}catch{}
  return result;
 }

 async function close(){
  closed=true;
  for(const conv of conversations.values())for(const job of conv.jobs.splice(0)){pending--;job.resolve(report(job.request,notSent(job.id,'closed'),job.started));}
  ready.length=0;
  await Promise.all([...running]);
  adapters.clear();
 }

 return Object.freeze({sendMessage,registerAdapter,close});
}
