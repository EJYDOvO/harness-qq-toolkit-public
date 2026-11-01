// Conversation wiring between one platform account, the Unified Agent I/O and
// the account's Conversation Manager handle. Platform-neutral: no platform SDK,
// Character or Interaction import. The Manager stays the only Session routing
// authority; this module only applies its answers the same way in both
// directions:
//   inbound   admission → getOrCreate → isCurrentSession → native UserMessage →
//             Interaction intervene/revise when enabled, otherwise followup
//   outbound  target → the Manager's current record → isCurrentSession, checked
//             by the I/O before every part
// One Conversation reference {platform, accountId, conversation:{type, id}} names
// a Conversation everywhere; the adapter's scopes map it to the Manager's
// existing (scope, peer) keys, so stored Session keys do not change.
import {createCommandRouter} from './commands.mjs';
import {createHITLBridge} from './hitl.mjs';
import {createHash} from 'node:crypto';

const TYPES=['direct','group'];
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const CODE=/^[a-z][a-z-]{0,39}$/;

// host: {createInput(spec) → native UserMessage, interactionPolicy(agent) → policy|undefined,
//        hitl?: {register(bridge) → unregister}: the one install of the native HITL listeners}
export function createConversations(io,host){
 const clock=host.now??(()=>performance.now());
 return function openConversation(options){
  const {platform,adapter,accountId,manager,admits}=options??{};
  if(!text(platform)||!text(adapter)||!text(accountId))throw Error('Conversation requires platform, adapter and accountId');
  // Without the Manager's own ownership check no handoff or reply could be
  // proven to belong to the current Session: refuse to start.
  if(!['getOrCreate','getSessionRecord','isCurrentSession'].every(m=>typeof manager?.[m]==='function'))throw Error('Conversation Manager ownership check required');
  if(typeof admits!=='function')throw Error('Conversation requires the platform admission check');
  const scopes=new Map(),types=new Map();
  for(const type of TYPES){
   const scope=options.scopes?.[type];if(scope===undefined)continue;
   if(!text(scope)||types.has(scope))throw Error('Conversation scopes must be distinct strings');
   scopes.set(type,scope);types.set(scope,type);
  }
  if(!scopes.size)throw Error('Conversation requires at least one scope');
  const onInput=typeof options.onInput==='function'?options.onInput:undefined;
  let inbound,release,commands,hitl,closed=false;
  // Notification grants issued by this wiring's notifiers (openNotifications);
  // an origin carrying anything else is not a notification.
  const grants=new WeakSet();
  const inputReplies=new WeakMap();
  const diagnostics=io.diagnostics?.scope({platform,adapter,accountId});
  const rememberInput=input=>{inputReplies.set(input,{at:clock(),conversation:Object.freeze({...input.conversation}),messageId:input.message?.id});return input;};

  const allowed=(scope,peer)=>{try{return admits(scope,peer)===true;}catch{return false;}};
  // undefined: no Interaction for this Agent. null: the lookup failed; callers
  // withhold (no input, no Interaction output) rather than act as "no policy".
  function policy(record){
   if(!record?.agent)return undefined;
   try{return host.interactionPolicy(record.agent)??undefined;}catch{return null;}
  }
  const current=record=>!closed&&manager.isCurrentSession(record)===true;

  /** The logical target of a Manager record; the same reference inbound uses. */
  function target(record){
   const type=types.get(record?.scope);
   if(!type||!text(record.peerId))return undefined;
   return Object.freeze({platform,adapter,accountId,conversation:Object.freeze({type,id:record.peerId})});
  }

  // Native input for a current record. Interaction, when enabled for the Agent,
  // receives input during a run (and explicit revisions); otherwise followup.
  // Ownership and admission are read here, after every await of the caller, so
  // access revoked while a Session was obtained creates no input.
  function submit(record,content,{revise=false,input}={}){
   if(!current(record))return {status:'not-delivered',reason:'session-changed'};
   if(!types.has(record.scope)||!allowed(record.scope,record.peerId))return {status:'rejected',reason:'unauthorized'};
   if(typeof content!=='string'||!content)return {status:'rejected',reason:'empty-message'};
   const p=policy(record),interactive=!!p&&typeof p.intervene==='function';
   // A failed lookup is not a plain Agent: no input is created, and the I/O lets
   // the platform re-deliver the message.
   if(p===null)return {status:'not-delivered',reason:'interaction-unavailable'};
   if(revise&&typeof p?.revise!=='function')return {status:'not-delivered',reason:'no-interaction'};
   const message=host.createInput({content:[{type:'text',text:content}],source:{kind:'user'}});
   // This synchronous admission hook must not hand input to the Agent itself.
   // Failure here is provably before the native/Interaction handoff below.
   try{onInput?.(record,message,p||undefined,input);}
   catch(error){return {status:'not-delivered',reason:'entry-error',error};}
   diagnostics?.emit('conversation','input',{sessionId:record.sessionId,conversation:target(record)?.conversation,inputId:input?.message?.id,status:'accepted'});
   if(p)p.admitInput?.(message);
   let mode;
   if(revise){p.revise(message);mode='revise';}
   else if(interactive&&record.agent.status==='running'){p.intervene(message);mode='intervene';}
   else{record.agent.followup(message);mode='followup';}
   return {status:'accepted',record,message,mode,interactive};
  }

  /**
   * The trusted handoff of one standard inbound message of this account.
   * replyTarget is the adapter's opaque target (the Manager's activity evidence);
   * content is the model-visible text, or a function producing it after
   * admission (null/empty: nothing to hand over).
   * → accepted {record, message, mode} | rejected {reason} | not-delivered {reason, error?}
   */
  async function handoff(standard,{replyTarget,content}={}){
   if(closed)return {status:'rejected',reason:'closed'};
   if(standard?.platform!==platform||standard.adapter!==adapter||standard.accountId!==accountId)return {status:'rejected',reason:'invalid-target'};
   const scope=scopes.get(standard.conversation?.type),peer=standard.conversation?.id;
   if(!scope||!text(peer))return {status:'rejected',reason:'invalid-target'};
   if(!text(standard.sender?.id))return {status:'rejected',reason:'unauthorized'};
   // Defence in depth after the platform chain: the same configuration admits
   // the Conversation; a scope the platform disabled is never opened here.
   if(!allowed(scope,peer))return {status:'rejected',reason:'unauthorized'};
   const body=typeof content==='function'?content():content;
   if(typeof body!=='string'||!body)return {status:'rejected',reason:'empty-message'};
   let record;
   try{record=await manager.getOrCreate(scope,peer,standard.sender.id,replyTarget);}
   catch(error){return {status:'not-delivered',reason:'session-unavailable',error};}
   // getOrCreate re-checks after each of its awaits, but disposal, rotation or a
   // revocation can still land before this continuation runs: never hand input to
   // a Session that is no longer current, nor to a record of another Conversation;
   // submit() re-reads admission.
   if(record?.scope!==scope||record.peerId!==peer)return {status:'not-delivered',reason:'session-changed'};
   diagnostics?.emit('conversation','route',{sessionId:record.sessionId,conversation:standard.conversation,inputId:standard.message?.id,status:'active'});
   return submit(record,body,{input:standard});
  }

  /**
   * The trusted route of an outbound target for an origin Session: the peer is
   * still admitted, and origin.sessionId is the Manager's current Session of
   * exactly this Conversation with its live Agent. Only Host-filled evidence is
   * compared; nothing trusts model ids or platformData.
   */
  function route(to,origin){
   if(to?.platform!==platform||to.adapter!==adapter||to.accountId!==accountId)return {ok:false,reason:'invalid-target'};
   const scope=scopes.get(to.conversation?.type),peer=to.conversation?.id;
   if(!scope||!text(peer))return {ok:false,reason:'invalid-target'};
   if(!text(origin?.sessionId))return {ok:false,reason:'unauthorized'};
   if(!allowed(scope,peer))return {ok:false,reason:'unauthorized'};
   const record=manager.getSessionRecord(scope,peer);
   if(!record||record.sessionId!==origin.sessionId||!current(record))return {ok:false,reason:'stale'};
   if(record.scope!==scope||record.peerId!==peer)return {ok:false,reason:'invalid-target'};
   return {ok:true,record};
  }

  /**
   * The stable-target route of a notification (ADR-059): no current Session is
   * required, because a legitimate reminder may come from a rotated Session;
   * instead the Conversation must still be admitted and the notification
   * authority that holds the grant must re-authorize this exact target now.
   * Chat and HITL replies never take this path.
   */
  function notificationRoute(to,grant){
   if(to?.platform!==platform||to.adapter!==adapter||to.accountId!==accountId)return {ok:false,reason:'invalid-target'};
   const scope=scopes.get(to.conversation?.type),peer=to.conversation?.id;
   if(!scope||!text(peer))return {ok:false,reason:'invalid-target'};
   if(closed||grant.closed())return {ok:false,reason:'closed'};
   if(!allowed(scope,peer))return {ok:false,reason:'unauthorized'};
   let granted=false;try{granted=grant.authorize(Object.freeze({type:to.conversation.type,id:peer}))===true;}catch{granted=false;}
   if(!granted)return {ok:false,reason:'unauthorized'};
   return {ok:true,route:Object.freeze({...(grant.reply?{inputReply:true,inputId:grant.messageId}:{notification:true}),target:Object.freeze({type:to.conversation.type,id:peer,scope})})};
  }

  /**
   * The account's notifier (Notification, ADR-054/057): a Host notification
   * authority (e.g. Character Identity's durable Outbox, Remote Ops' ledger)
   * sends explicit, already-recorded events to a stable Conversation through the
   * same I/O queue as chat (same Conversation order, bounded queue, duplicate
   * suppression by id, cancellation, honest result). send({id, conversation,
   * text, authorize, signal}): authorize(target) is that authority's own check
   * (Owner, binding, event validity), run before every part together with this
   * wiring's admission; anything but true refuses the part. Text only.
   */
  function openNotifications(){
   if(closed)throw Error('Conversation closed');
   let stopped=false;
   function send({id,conversation,text:body,authorize,signal}={}){
    if(typeof id!=='string'||!id||typeof authorize!=='function')return Promise.resolve(Object.freeze({id,status:'not-sent',reason:'invalid-message',stage:'before-platform',parts:Object.freeze([])}));
    const grant=Object.freeze({authorize,closed:()=>stopped});grants.add(grant);
    return io.sendMessage({id,target:{platform,adapter,accountId,conversation:{type:conversation?.type,id:conversation?.id}},origin:{notification:grant},message:{text:body},...(signal?{signal}:{})});
   }
   return Object.freeze({send,close(){stopped=true;}});
  }

  /** The account's inbound channel; deliver(standard) is the adapter's entry, normally ending in handoff(). */
  function openInbound(deliver){
   if(closed)throw Error('Conversation closed');
   if(inbound)throw Error('Inbound already open for this Conversation wiring');
   const channel=io.openInbound({platform,adapter,accountId,deliver:standard=>deliver(rememberInput(standard))});
   inbound=channel;
   return Object.freeze({receive:channel.receive,claim:channel.claim,close:()=>{channel.close();if(inbound===channel)inbound=undefined;}});
  }

  /**
   * The account's command router (Agent I/O commands module): recognition,
   * parsing and routing with this wiring's admission, claiming each platform
   * message in the inbound duplicate scope of this account. Commands are
   * registered and executed by the Host or business plugins; the adapter calls
   * dispatch() at its command position and keeps a non-pass result away from
   * the Agent.
   */
  function openCommands(options={}){
   if(closed)throw Error('Conversation closed');
   if(commands)throw Error('Commands already open for this Conversation wiring');
   const router=createCommandRouter({...options,
    admits:(type,id)=>{const scope=scopes.get(type);return !closed&&!!scope&&allowed(scope,id);},
    claim:input=>{if(closed||!inbound)return 'unavailable';const result=inbound.claim(input);if(result==='claimed')rememberInput(input);return result;}});
   commands=Object.freeze({...router,dispatch:(input,args={})=>router.dispatch(input,{...args,reply:async body=>{const result=await reply(input,body);if(result.status!=='sent')throw Error('Input reply not accepted');return result;}})});
   return commands;
  }

  // A short-lived response to a verified/claimed platform input, not a stable
  // notification grant and not a Session capability. Commands (/new included)
  // and Session-creation errors can answer without creating another Session.
  function reply(input,body){
   const evidence=inputReplies.get(input);
   if(!evidence||closed)return Promise.resolve({status:'not-sent',reason:'unauthorized',stage:'before-platform',parts:[]});
   const grant=Object.freeze({reply:true,messageId:evidence.messageId,closed:()=>closed,
    authorize:to=>clock()-evidence.at>=0&&clock()-evidence.at<300_000&&to.type===evidence.conversation.type&&to.id===evidence.conversation.id});grants.add(grant);
   const id=evidence.messageId?'input-reply:'+createHash('sha256').update(JSON.stringify([evidence.conversation.type,evidence.conversation.id,evidence.messageId])).digest('hex'):undefined;
   diagnostics?.emit('conversation','queued',{inputId:evidence.messageId,logicalId:id,conversation:evidence.conversation,status:'pending'});
   return io.sendMessage({...(id?{id}:{}),target:{platform,adapter,accountId,conversation:evidence.conversation},origin:{notification:grant},message:{text:body}}).then(result=>{
    if(result.status!=='sent')throw Object.assign(Error('Input reply not accepted'),{status:result.status});return result;
   });
  }

  /**
   * The account's HITL Bridge (Agent I/O hitl module, optional): native Approval
   * and userQuestions requests of this account's current Sessions are shown in
   * their Conversation through sendMessage() and answered only by the expected
   * person there. The adapter passes its button events to respond() and, at its
   * answer position, text messages to answer(); its Conversation Manager hooks
   * use waiting() and cancel(). Without an open Bridge the native answerers
   * (Web/Desktop) receive every request unchanged.
   */
  function openHITL(options={}){
   if(closed)throw Error('Conversation closed');
   if(hitl)throw Error('HITL already open for this Conversation wiring');
   if(typeof host.hitl?.register!=='function')throw Error('HITL is unavailable in this Agent I/O host');
   if(typeof manager.findBySessionId!=='function')throw Error('HITL requires the Manager Session lookup');
   const bridge=createHITLBridge({...options,io,manager,diagnostics,wiring:{target,current,
    allowed:record=>types.has(record?.scope)&&allowed(record.scope,record.peerId),
    claim:input=>closed||!inbound?'unavailable':inbound.claim(input)}});
   const unregister=host.hitl.register(bridge);
   const handle={bridge,unregister};hitl=handle;
   const stop=()=>{bridge.close();unregister();if(hitl===handle)hitl=undefined;};
   return Object.freeze({respond:bridge.respond,answer:bridge.answer,waiting:bridge.waiting,cancel:bridge.cancel,size:bridge.size,close:stop});
  }

  /**
   * The account's outbound adapter. The route check above runs first; the
   * adapter's own check(record, target) adds protocol conditions (e.g. a usable
   * reply target); only an explicit {ok:true} lets a part go out, anything else
   * (no answer, a malformed one, an exception) refuses it before send.
   * send(route, text, info) and the optional accepts(attachment) /
   * sendAttachment(route, attachment, info) receive route.record.
   */
  function registerAdapter(parts){
   if(closed)throw Error('Conversation closed');
   if(release)throw Error('An adapter is already registered for this Conversation wiring');
   const check=typeof parts?.check==='function'?parts.check:undefined;
   const unregister=io.registerAdapter({
    platform,adapter,accountId,split:parts?.split,send:parts?.send,classify:parts?.classify,
    // HITL actions: optional; without acceptsActions the I/O refuses them.
    ...(typeof parts?.acceptsActions==='function'?{acceptsActions:parts.acceptsActions}:{}),
    // Basic media: optional; without sendAttachment the I/O refuses attachments.
    ...(typeof parts?.sendAttachment==='function'?{sendAttachment:parts.sendAttachment,...(typeof parts.accepts==='function'?{accepts:parts.accepts}:{})}:{}),
    resolve(to,origin){
     if(origin?.notification!==undefined)return grants.has(origin.notification)?notificationRoute(to,origin.notification):{ok:false,reason:'unauthorized'};
     const r=route(to,origin);if(!r.ok)return r;
     if(check){
      let c;try{c=check(r.record,to);}catch{return {ok:false,reason:'adapter-error'};}
      if(c?.ok!==true)return {ok:false,reason:typeof c?.reason==='string'&&CODE.test(c.reason)?c.reason:'invalid-target'};
     }
     return {ok:true,route:{record:r.record}};
    },
   });
   release=unregister;
   return ()=>{unregister();if(release===unregister)release=undefined;};
  }

  function close(){
   diagnostics?.emit('conversation','close',{status:'closed'});
   closed=true;if(hitl){hitl.bridge.close();hitl.unregister();hitl=undefined;}inbound?.close();inbound=undefined;release?.();release=undefined;commands=undefined;
  }

  return Object.freeze({platform,adapter,accountId,target,policy,handoff,submit,route,reply,openInbound,openCommands,openHITL,openNotifications,registerAdapter,diagnostics,close});
 };
}
