// HITL Bridge (ADR-054/057): presentation and trusted answers of the native
// Approval (`approval/request`) and `userQuestions.ask()` (`user-questions/request`)
// requests of one Conversation wiring. The Host stays the only authority: the
// native services validate a request, apply the approval policy and decide what
// an outcome means. This module only shows a request in the Conversation of its
// Session, accepts an answer from the expected person in that Conversation while
// the Session is still current and admitted, and settles the request once (or
// cancels it). Platform-neutral: the adapter supplies the rendering and turns its
// button events and text messages into the standard responses below. Nothing
// here is durable; Gateway shutdown or a restart cancels open requests.
import {randomBytes} from 'node:crypto';

const MAX_OPTIONS=10;
// The native user-questions error shape: the service restores it as its own
// UserQuestionError, so callers keep matching code ASK_ABORTED.
const aborted=message=>Object.assign(new Error(message),{name:'UserQuestionError',code:'ASK_ABORTED'});

/** The gated command of an approval, read from the Session's own tool call. */
function commandOf(request){
 if(request.callId===undefined)return undefined;
 const session=request.agent.session;
 for(let seq=session.seq-1;seq>=0;seq--){
  const event=session.eventAt(seq);
  if(event?.type!=='tool/call'||String(event.data?.callId)!==String(request.callId))continue;
  const raw=event.data?.arguments;
  if(typeof raw!=='string')return undefined;
  try{const parsed=JSON.parse(raw);if(parsed&&typeof parsed.command==='string')return parsed.command;}catch{}
  return raw.length<=500?raw:`${raw.slice(0,500)}…`;
 }
 return undefined;
}

/** One typed answer to one question: option numbers, an exact option label, or free text. */
export function parseAnswer(question,text){
 const opts=question.options??[];
 if(opts.length>0){
  if(/^[\d\s,，、;；./]+$/.test(text)){
   const nums=[...text.matchAll(/\d+/g)].map(m=>parseInt(m[0],10)).filter(n=>n>=1&&n<=opts.length);
   if(nums.length>0){
    const picked=question.multiSelect?nums:nums.slice(0,1);
    return {id:question.id,selected:[...new Set(picked.map(n=>opts[n-1]?.label).filter(l=>typeof l==='string'))]};
   }
  }
  const exact=opts.find(o=>o.label.toLowerCase()===text.toLowerCase());
  if(exact)return {id:question.id,selected:[exact.label]};
 }
 return {id:question.id,selected:[],custom:text};
}

/**
 * @param io        the Agent I/O core (sendMessage, issueActions)
 * @param manager   the Conversation Manager handle (findBySessionId)
 * @param wiring    {target(record), current(record), allowed(record), claim(input)} of the Conversation wiring
 * @param responder (record) → the platform sender id expected to answer this record's requests
 * @param render    {approval({toolName, command, reason}), question(question, {actions, index, count, conversation}), timeout?()} → text
 */
export function createHITLBridge({io,manager,wiring,responder,render,labels={},approvalTimeoutMs=300_000,questionTimeoutMs=300_000,logger}){
 if(typeof responder!=='function'||typeof render?.approval!=='function'||typeof render.question!=='function')throw Error('HITL requires responder() and render.approval/question()');
 const words={allow:'✅ 允许一次',allowDone:'✓ 已允许',deny:'❌ 拒绝',denyDone:'✓ 已拒绝',chosen:'✓ 已选',...labels};
 // One open approval and one open question per Session; refs name the request
 // (and, for questions, the current question) a button belongs to.
 const approvals=new Map(),questions=new Map(),refs=new Map();
 let closed=false;
 const newRef=()=>randomBytes(12).toString('base64url');
 // Diagnostics name the kind and outcome only, never ids or text.
 const warn=message=>{try{logger?.warn?.('agent-io hitl: '+message);}catch{}};

 // The current record of a native request's Session, when this wiring owns it.
 function owner(request){
  const id=request?.agent?.id;
  if(closed||typeof id!=='string'||!id)return undefined;
  let record;try{record=manager.findBySessionId(id);}catch{return undefined;}
  if(!record||record.sessionId!==id||!wiring.current(record)||!wiring.allowed(record)||!wiring.target(record))return undefined;
  return record;
 }
 function who(record){let id;try{id=responder(record);}catch{}return typeof id==='string'&&id?id:undefined;}
 // Still the same current, admitted Session of the Conversation the request was shown in.
 const still=entry=>!closed&&wiring.current(entry.record)&&entry.record.sessionId===entry.sessionId&&wiring.allowed(entry.record)&&!!wiring.target(entry.record);

 function open(map,entry){map.set(entry.sessionId,entry);refs.set(entry.ref,entry);}
 // Removes every trace of the request; true only for the call that finished it.
 function finish(entry){
  if(entry.done)return false;
  entry.done=true;
  const map=entry.kind==='approval'?approvals:questions;
  if(map.get(entry.sessionId)===entry)map.delete(entry.sessionId);
  refs.delete(entry.ref);clearTimeout(entry.timer);
  entry.request.signal?.removeEventListener('abort',entry.onAbort);
  entry.sending.abort();
  return true;
 }

 /**
  * One logical prompt message through the I/O (same Conversation order, current
  * Session check before every part, duplicate suppression, cancellation). A
  * question's prompt also stops with its own question: once that is answered,
  * parts not yet handed to the platform are not sent (a part in flight is).
  * → shown | maybe (the outcome is unknown: never resent) | not-shown | settled | superseded
  */
 async function present(entry,text,actions,suffix){
  const own=entry.current;
  let result;
  try{
   result=await io.sendMessage({id:`hitl:${entry.sessionId}:${entry.ref}${suffix}`,target:wiring.target(entry.record),origin:{sessionId:entry.sessionId},
    message:{text,...(actions?{actions}:{})},signal:own?AbortSignal.any([entry.sending.signal,own.signal]):entry.sending.signal});
  }catch{result={status:'unknown',parts:[]};}
  if(entry.done)return 'settled';
  if(own&&own!==entry.current)return 'superseded';
  let state;
  if(actions){const part=result.parts?.find(p=>p.actions);state=part?.status==='sent'?'shown':part?.status==='unknown'?'maybe':'not-shown';}
  else state=result.status==='sent'?'shown':['unknown','partial'].includes(result.status)?'maybe':'not-shown';
  if(state==='maybe')warn(`${entry.kind} prompt outcome unknown; not resent`);
  if(state==='not-shown')warn(`${entry.kind} prompt not sent (${result.reason??result.status})`);
  return state;
 }

 /** `approval/request` waterfall listener: the closed native outcome set. */
 function approval(request,next){
  const record=owner(request);
  if(!record)return next();
  if(request.signal?.aborted)return Promise.resolve('cancelled');
  if(approvals.has(record.sessionId))return Promise.resolve('unavailable');
  const responderId=who(record);
  if(!responderId)return Promise.resolve('unavailable');
  let text;
  try{text=render.approval({toolName:request.toolName,command:commandOf(request),reason:request.reason});}catch{text=undefined;}
  if(typeof text!=='string'||!text.trim()){warn('approval prompt unavailable');return Promise.resolve('unavailable');}
  return new Promise(resolve=>{
   const entry={kind:'approval',record,sessionId:record.sessionId,conversation:wiring.target(record).conversation,responder:responderId,ref:newRef(),request,sending:new AbortController()};
   entry.settle=outcome=>{if(finish(entry))resolve(outcome);};
   entry.onAbort=()=>entry.settle('cancelled');
   open(approvals,entry);
   request.signal?.addEventListener('abort',entry.onAbort,{once:true});
   entry.timer=setTimeout(()=>entry.settle('cancelled'),approvalTimeoutMs);
   if(request.signal?.aborted){entry.onAbort();return;}
   const actions=io.issueActions({ref:entry.ref,options:[
    {value:'allow',label:words.allow,doneLabel:words.allowDone,style:'primary'},
    {value:'deny',label:words.deny,doneLabel:words.denyDone,style:'secondary'}]});
   // A prompt that provably never reached the user cannot be answered: the
   // request is unavailable, never allowed. An unknown outcome keeps waiting for
   // a genuine answer until the timeout, without sending the buttons again.
   void present(entry,text,actions,':approval').then(state=>{if(state==='not-shown')entry.settle('unavailable');});
  });
 }

 /** `user-questions/request` waterfall listener: {answers} or an ASK_ABORTED error. */
 function question(request,next){
  const record=owner(request);
  if(!record)return next();
  if(request.signal?.aborted)return Promise.reject(aborted('ask_user_question was aborted before delivery'));
  if(!Array.isArray(request.questions)||!request.questions.length)return Promise.reject(new Error('ask_user_question with empty questions'));
  const responderId=who(record);
  if(!responderId)return Promise.reject(aborted('ask_user_question has no answerer in this conversation'));
  questions.get(record.sessionId)?.fail(aborted('superseded by a new question'));
  return new Promise((resolve,reject)=>{
   const entry={kind:'question',record,sessionId:record.sessionId,conversation:wiring.target(record).conversation,responder:responderId,ref:newRef(),request,index:0,collected:[],sending:new AbortController(),current:new AbortController()};
   entry.settle=value=>{if(finish(entry))resolve(value);};
   entry.fail=error=>{if(finish(entry))reject(error);};
   entry.onAbort=()=>entry.fail(aborted('ask_user_question was aborted before the user answered'));
   open(questions,entry);
   request.signal?.addEventListener('abort',entry.onAbort,{once:true});
   arm(entry);
   if(request.signal?.aborted){entry.onAbort();return;}
   void ask(entry);
  });
 }
 function arm(entry){clearTimeout(entry.timer);entry.timer=setTimeout(()=>expire(entry),questionTimeoutMs);}
 function expire(entry){
  if(entry.done)return;
  const {record,sessionId,ref}=entry;
  entry.fail(aborted('ask_user_question timed out before the user answered'));
  let text;try{text=render.timeout?.();}catch{text=undefined;}
  if(typeof text==='string'&&text.trim())void io.sendMessage({id:`hitl:${sessionId}:${ref}:timeout`,target:wiring.target(record),origin:{sessionId},message:{text}}).catch(()=>{});
 }
 // Single choice with a bounded number of options: buttons; otherwise text only.
 function choices(q){
  const opts=q?.options??[];
  if(q?.multiSelect===true||!opts.length||opts.length>MAX_OPTIONS)return undefined;
  const labels=opts.map(o=>typeof o?.label==='string'?o.label.trim().slice(0,64):'');
  if(labels.some(l=>!l))return undefined;
  return labels.map((label,i)=>({value:String(i),label,doneLabel:words.chosen,style:'primary'}));
 }
 // Presents the current question; buttons first, a provably unsent button prompt
 // falls back to text once. An unknown outcome is not resent: the user may have
 // seen it and can still answer by text.
 async function ask(entry){
  const q=entry.request.questions[entry.index],ref=entry.ref,count=entry.request.questions.length;
  const text=withActions=>{let t;try{t=render.question(q,{actions:withActions,index:entry.index,count,conversation:entry.conversation});}catch{t=undefined;}return typeof t==='string'&&t.trim()?t:undefined;};
  const options=choices(q);
  if(options){
   const prompt=text(true);let actions;
   try{actions=io.issueActions({ref,options});}catch{actions=undefined;}
   if(prompt&&actions){
    const state=await present(entry,prompt,actions,`:q${entry.index}`);
    if(state!=='not-shown'||entry.ref!==ref)return;
   }
  }
  if(entry.done||entry.ref!==ref)return;
  const prompt=text(false);
  if(!prompt){entry.fail(new Error('failed to deliver question to the conversation'));return;}
  const state=await present(entry,prompt,undefined,`:q${entry.index}:text`);
  if(state==='not-shown'&&entry.ref===ref)entry.fail(new Error('failed to deliver question to the conversation'));
 }
 function advance(entry,answer){
  entry.collected.push(answer);entry.index++;
  if(entry.index>=entry.request.questions.length){entry.settle({answers:entry.collected});return;}
  // The next question gets a new ref (buttons of the previous one are stale) and
  // its own controller: unsent parts of the answered one stop, the next is unaffected.
  entry.current.abort();entry.current=new AbortController();
  refs.delete(entry.ref);entry.ref=newRef();refs.set(entry.ref,entry);
  arm(entry);void ask(entry);
 }

 // The checks every answer passes: its Conversation, the expected person, a live
 // request and a Session that is still current and admitted.
 function problem(entry,input){
  const c=input?.conversation;
  if(c?.type!==entry.conversation.type||c.id!==entry.conversation.id)return 'wrong-conversation';
  if(input.sender?.id!==entry.responder)return 'unauthorized';
  if(entry.request.signal?.aborted){entry.onAbort();return 'cancelled';}
  if(!still(entry))return 'stale';
  return null;
 }

 /**
  * A platform button event of this account: {conversation:{type,id}, sender:{id}, ref, value}
  * → {status:'accepted'} | {status:'rejected', reason}. Each request (each
  * question) completes once; old, forged, foreign or late buttons are rejected.
  */
 function respond(input){
  const entry=typeof input?.ref==='string'?refs.get(input.ref):undefined;
  if(!entry||entry.done)return {status:'rejected',reason:'unknown-request'};
  const reason=problem(entry,input);
  if(reason)return {status:'rejected',reason};
  if(entry.kind==='approval'){
   if(input.value!=='allow'&&input.value!=='deny')return {status:'rejected',reason:'invalid-answer'};
   entry.settle(input.value==='allow'?'allowed-once':'rejected');
   return {status:'accepted'};
  }
  const q=entry.request.questions[entry.index],opts=q?.options??[];
  const i=/^\d{1,2}$/.test(input.value??'')?Number(input.value):-1;
  if(!choices(q)||i<0||i>=opts.length)return {status:'rejected',reason:'invalid-answer'};
  advance(entry,{id:q.id,selected:[opts[i].label]});
  return {status:'accepted'};
 }

 /**
  * A platform text message of this account: {conversation, sender, message:{id?, text}}
  * → answered | duplicate (consumed, not Agent input) | pass (ordinary chat input).
  * Only the expected person's text in the Conversation with an open question
  * answers it; the platform message is claimed once in the inbound duplicate
  * scope, so a re-delivery neither answers again nor reaches the Agent.
  */
 function answer(input){
  if(closed)return {status:'pass'};
  const text=typeof input?.message?.text==='string'?input.message.text.trim():'';
  if(!text)return {status:'pass'};
  const entry=[...questions.values()].find(e=>!e.done&&e.conversation.type===input.conversation?.type&&e.conversation.id===input.conversation?.id);
  if(!entry||problem(entry,input))return {status:'pass'};
  let claimed;try{claimed=wiring.claim(input);}catch{claimed='unavailable';}
  if(claimed==='duplicate')return {status:'duplicate'};
  if(claimed!=='claimed')return {status:'pass'};
  const q=entry.request.questions[entry.index];
  if(!q)return {status:'pass'};
  advance(entry,parseAnswer(q,text));
  return {status:'answered'};
 }

 const waiting=record=>approvals.has(record?.sessionId)||questions.has(record?.sessionId);
 /** Session release (rotation, removal, disposal): its open requests are cancelled. */
 function cancel(record){
  approvals.get(record?.sessionId)?.settle('cancelled');
  questions.get(record?.sessionId)?.fail(aborted('ask_user_question was cancelled before the user answered'));
 }
 function close(){
  if(closed)return;
  closed=true;
  for(const entry of [...approvals.values()])entry.settle('cancelled');
  for(const entry of [...questions.values()])entry.fail(aborted('the conversation bridge was closed before the user answered'));
 }
 const size=()=>({approvals:approvals.size,questions:questions.size,refs:refs.size});
 return Object.freeze({owns:request=>owner(request)!==undefined,approval,question,respond,answer,waiting,cancel,close,size});
}

// The one install of the native HITL waterfalls for every platform (ADR-054):
// a listener exists only while a platform has a Bridge open, and a request whose
// Session no Bridge owns goes on to the next answerer (Web/Desktop) unchanged.
export function createHITLHost(ctx){
 const bridges=new Set();let off=[];
 const route=kind=>(request,next)=>{for(const bridge of bridges)if(bridge.owns(request))return bridge[kind](request,next);return next();};
 return Object.freeze({register(bridge){
  bridges.add(bridge);
  if(!off.length)off=[ctx.on('approval/request',route('approval'),{prepend:true}),ctx.on('user-questions/request',route('question'),{prepend:true})];
  return ()=>{if(!bridges.delete(bridge)||bridges.size)return;for(const dispose of off.splice(0)){try{dispose?.();}catch{}}};
 },size:()=>bridges.size,installed:()=>off.length>0});
}
