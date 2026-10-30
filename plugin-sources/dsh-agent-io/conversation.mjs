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
const TYPES=['direct','group'];
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const CODE=/^[a-z][a-z-]{0,39}$/;

// host: {createInput(spec) → native UserMessage, interactionPolicy(agent) → policy|undefined}
export function createConversations(io,host){
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
  let inbound,release,closed=false;

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
   return Object.freeze({platform,accountId,conversation:Object.freeze({type,id:record.peerId})});
  }

  // Native input for a current record. Interaction, when enabled for the Agent,
  // receives input during a run (and explicit revisions); otherwise followup.
  // Ownership and admission are read here, after every await of the caller, so
  // access revoked while a Session was obtained creates no input.
  function submit(record,content,{revise=false}={}){
   if(!current(record))return {status:'not-delivered',reason:'session-changed'};
   if(!types.has(record.scope)||!allowed(record.scope,record.peerId))return {status:'rejected',reason:'unauthorized'};
   if(typeof content!=='string'||!content)return {status:'rejected',reason:'empty-message'};
   const p=policy(record),interactive=!!p&&typeof p.intervene==='function';
   // A failed lookup is not a plain Agent: no input is created, and the I/O lets
   // the platform re-deliver the message.
   if(p===null)return {status:'not-delivered',reason:'interaction-unavailable'};
   if(revise&&typeof p?.revise!=='function')return {status:'not-delivered',reason:'no-interaction'};
   const message=host.createInput({content:[{type:'text',text:content}],source:{kind:'user'}});
   onInput?.(record,message,p||undefined);
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
   if(standard?.platform!==platform||standard.accountId!==accountId)return {status:'rejected',reason:'invalid-target'};
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
   return submit(record,body);
  }

  /**
   * The trusted route of an outbound target for an origin Session: the peer is
   * still admitted, and origin.sessionId is the Manager's current Session of
   * exactly this Conversation with its live Agent. Only Host-filled evidence is
   * compared; nothing trusts model ids or platformData.
   */
  function route(to,origin){
   if(to?.platform!==platform||to.accountId!==accountId)return {ok:false,reason:'invalid-target'};
   const scope=scopes.get(to.conversation?.type),peer=to.conversation?.id;
   if(!scope||!text(peer))return {ok:false,reason:'invalid-target'};
   if(!text(origin?.sessionId))return {ok:false,reason:'unauthorized'};
   if(!allowed(scope,peer))return {ok:false,reason:'unauthorized'};
   const record=manager.getSessionRecord(scope,peer);
   if(!record||record.sessionId!==origin.sessionId||!current(record))return {ok:false,reason:'stale'};
   if(record.scope!==scope||record.peerId!==peer)return {ok:false,reason:'invalid-target'};
   return {ok:true,record};
  }

  /** The account's inbound channel; deliver(standard) is the adapter's entry, normally ending in handoff(). */
  function openInbound(deliver){
   if(closed)throw Error('Conversation closed');
   if(inbound)throw Error('Inbound already open for this Conversation wiring');
   const channel=io.openInbound({platform,adapter,accountId,deliver});
   inbound=channel;
   return Object.freeze({receive:channel.receive,close:()=>{channel.close();if(inbound===channel)inbound=undefined;}});
  }

  /**
   * The account's outbound adapter. The route check above runs first; the
   * adapter's own check(record, target) adds protocol conditions (e.g. a usable
   * reply target); only an explicit {ok:true} lets a part go out, anything else
   * (no answer, a malformed one, an exception) refuses it before send.
   * send(route, text, info) receives route.record.
   */
  function registerAdapter(parts){
   if(closed)throw Error('Conversation closed');
   if(release)throw Error('An adapter is already registered for this Conversation wiring');
   const check=typeof parts?.check==='function'?parts.check:undefined;
   const unregister=io.registerAdapter({
    platform,accountId,split:parts?.split,send:parts?.send,classify:parts?.classify,
    resolve(to,origin){
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
   closed=true;inbound?.close();inbound=undefined;release?.();release=undefined;
  }

  return Object.freeze({platform,adapter,accountId,target,policy,handoff,submit,route,openInbound,registerAdapter,close});
 };
}
