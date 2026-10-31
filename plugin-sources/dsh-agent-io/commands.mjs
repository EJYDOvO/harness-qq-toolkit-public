// Command recognition and routing for the Unified Agent I/O (an I/O-internal
// L1 module, not a plugin). Platform-neutral: no platform SDK, Character or
// Interaction import. The platform adapter hands over a standard command
// candidate after its own protocol steps (mention markers, group @ gate); this
// module recognizes and parses it, claims the platform message once in the
// inbound duplicate scope (so it can neither run twice nor reach the Agent
// later) and routes it. The registered Host or business command authorizes and
// executes it. Nothing here grants authority: the router compares no ids and
// reads no platform data; authorize() decides with the trusted sender the
// adapter supplied, never with model output.
const NAME=/^[a-z0-9][a-z0-9_.-]{0,31}$/;
const TYPES=['direct','group'];
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const DEFAULT_MESSAGES=Object.freeze({
 unauthorized:'⚠️ 无权限执行此命令',
 direct:'该指令仅限私聊使用',
 group:'该指令仅限群聊使用',
});

/**
 * @param prefixes  command prefixes (default ['/'])
 * @param claim     (input) → 'claimed'|'duplicate'|'unavailable': marks the platform
 *                  message as consumed in the inbound duplicate scope
 * @param admits    (type, id) → boolean: the platform admission of the Conversation
 * @param messages  reply texts for refusals (defaults keep the QQ SDK wording)
 */
export function createCommandRouter({prefixes=['/'],claim,admits,messages={}}={}){
 if(!Array.isArray(prefixes)||!prefixes.length||prefixes.some(p=>!text(p)))throw Error('Command prefixes must be non-empty strings');
 if(typeof claim!=='function'||typeof admits!=='function')throw Error('Command router requires claim() and admits()');
 const words={...DEFAULT_MESSAGES,...messages};
 const registry=new Map(),specs=new Set();

 /**
  * spec: {name: string|string[], execute(call), authorize?(call) → true|string|false,
  *        scopes?: ['direct'|'group'], description?, usage?, hidden?, category?}
  * → unregister()
  */
 function register(spec){
  const names=(Array.isArray(spec?.name)?spec.name:[spec?.name]).map(n=>typeof n==='string'?n.toLowerCase():n);
  if(!names.length||names.some(n=>!NAME.test(n??'')))throw Error('Command names must match '+NAME);
  if(typeof spec.execute!=='function')throw Error('Command requires execute()');
  if(spec.authorize!==undefined&&typeof spec.authorize!=='function')throw Error('Command authorize must be a function');
  if(spec.scopes!==undefined&&(!Array.isArray(spec.scopes)||!spec.scopes.length||spec.scopes.some(s=>!TYPES.includes(s))))throw Error('Command scopes must be direct and/or group');
  for(const n of names)if(registry.has(n))throw Error('Duplicate command name: '+n);
  for(const n of names)registry.set(n,spec);
  specs.add(spec);
  return ()=>{if(!specs.delete(spec))return;for(const n of names)if(registry.get(n)===spec)registry.delete(n);};
 }

 function list(){
  return [...specs].map(s=>Object.freeze({names:Object.freeze((Array.isArray(s.name)?s.name:[s.name]).map(n=>n.toLowerCase())),description:s.description,usage:s.usage,hidden:s.hidden===true,category:s.category}));
 }

 /** text → {name, args, raw} | undefined (not a command candidate). */
 function parse(value){
  const content=typeof value==='string'?value.trim():'';
  const prefix=prefixes.find(p=>content.startsWith(p));
  if(!prefix)return undefined;
  const match=/^(\S+)(?:\s+([\s\S]*))?$/.exec(content.slice(prefix.length));
  if(!match)return undefined;
  const raw=match[2]??'';
  return {name:match[1].toLowerCase(),args:raw?raw.split(/\s+/).filter(Boolean):[],raw};
 }

 /**
  * One command candidate of the adapter's account.
  * input:   {conversation:{type,id}, sender:{id}, message:{id?, text}}
  * reply:   (text) → Promise: the adapter's protocol reply to this message
  * context: opaque adapter context handed to authorize/execute only
  * → pass       not a registered command: the adapter continues its ordinary chat path
  *   duplicate  this platform message was already claimed: nothing runs, no Agent input
  *   rejected   not admitted / invalid / no inbound channel: nothing runs, no reply
  *   denied     scope or authorization refused (reply sent)
  *   handled    executed (result replied)
  *   failed     execute threw (error replied)
  * Every status except pass means the message must not reach the Agent.
  */
 async function dispatch(input,{reply,context}={}){
  const parsed=parse(input?.message?.text);
  if(!parsed)return {status:'pass'};
  const spec=registry.get(parsed.name);
  // Unknown commands stay ordinary chat input, as before the extraction.
  if(!spec)return {status:'pass',reason:'unknown-command'};
  const conversation=input.conversation,sender=input.sender;
  if(!conversation||!TYPES.includes(conversation.type)||!text(conversation.id)||!text(sender?.id))return {status:'rejected',reason:'invalid-message'};
  let admitted=false;try{admitted=admits(conversation.type,conversation.id)===true;}catch{}
  if(!admitted)return {status:'rejected',reason:'unauthorized'};
  let claimed;try{claimed=claim(input);}catch{claimed='unavailable';}
  if(claimed==='duplicate')return {status:'duplicate'};
  if(claimed!=='claimed')return {status:'rejected',reason:'closed'};
  const call=Object.freeze({name:parsed.name,args:Object.freeze(parsed.args),raw:parsed.raw,
   conversation:Object.freeze({type:conversation.type,id:conversation.id}),sender:Object.freeze({id:sender.id}),
   message:Object.freeze({...(text(input.message.id)?{id:input.message.id}:{}),text:input.message.text}),context});
  const answer=async value=>{
   const out=typeof value==='string'?value:value?.kind==='text'&&typeof value.content==='string'?value.content:typeof value?.text==='string'?value.text:'';
   if(!out||typeof reply!=='function')return true;
   try{await reply(out);return true;}catch{return false;}
  };
  if(spec.scopes&&!spec.scopes.includes(conversation.type)){
   const replied=await answer(spec.scopes.includes('direct')?words.direct:words.group);
   return {status:'denied',reason:'scope',command:parsed.name,replied};
  }
  if(spec.authorize){
   let verdict;try{verdict=spec.authorize(call);}catch{verdict=false;}
   if(verdict!==true){
    const replied=await answer(typeof verdict==='string'&&verdict?verdict:words.unauthorized);
    return {status:'denied',reason:'unauthorized',command:parsed.name,replied};
   }
  }
  let result;
  try{result=await spec.execute(call);}
  catch(error){
   const replied=await answer('Error: '+(error instanceof Error?error.message:String(error)));
   return {status:'failed',reason:'command-error',command:parsed.name,replied};
  }
  const replied=await answer(result);
  return {status:'handled',command:parsed.name,replied};
 }

 return Object.freeze({register,list,parse,dispatch});
}
