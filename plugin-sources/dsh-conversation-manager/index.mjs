import {ConversationManager} from './manager.mjs';
import {PrefsStore} from './preferences.mjs';
export {ConversationManager};
export const name='conversation-manager';
export const inject=['agents'];
export function apply(ctx,config){
 const preferences=new PrefsStore(undefined,config.stateFile),adapters=new Map();let closed=false;
 if(preferences.loadError)throw Error('Conversation state unreadable; explicit recovery required');
 ctx.provide('conversationManager',Object.freeze({
  openAdapter(namespace,options){
   if(closed||typeof namespace!=='string'||!namespace||[...adapters.keys()].some(n=>n===namespace||n.startsWith(namespace+':')||namespace.startsWith(n+':')))throw Error('Conversation namespace unavailable');
   if(!options?.adapter||typeof options.adapter.key!=='function')throw Error('Trusted adapter required');
   const key=options.adapter.key;
   const adapter={...options.adapter,key(scope,peer){const value=key(scope,peer);if(typeof value!=='string'||!value.startsWith(namespace+':'))throw Error('Conversation key escaped adapter namespace');return value;}};
   const manager=new ConversationManager(options.context??ctx,ctx.agents,{...options,adapter,preferences},ctx.logger);
   const dispose=manager.disposeAll.bind(manager);let closing;
   manager.disposeAll=()=>closing??=dispose().then(()=>{if(adapters.get(namespace)===manager)adapters.delete(namespace);});
   adapters.set(namespace,manager);return manager;
  },
 }));
 ctx.effect(()=>async()=>{closed=true;const results=await Promise.allSettled([...adapters.values()].map(m=>m.disposeAll()));adapters.clear();const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Conversation service cleanup failed');});
}
