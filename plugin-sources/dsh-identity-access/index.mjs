import {createIdentityAccess,roleCommandSpec} from './access.mjs';
export {createIdentityAccess,roleCommandSpec};
export const name='identity-access';
export const inject=['tools'];
// Trusted Host service: no model tool, RPC or route. Platform wiring obtains
// its Conversation access with identityAccess.conversation({platform, adapter, accountId}).
export function apply(ctx,config){
 const service=createIdentityAccess(config);
 const presetOf=agent=>{try{return ctx.get('agentPresets')?.composedPreset?.(agent.ctx);}catch{return undefined;}};
 const minimal=new Set([service.roles.contact,service.roles.guest]);
 // Global tool gate, checked by the native tool pipeline before every execution:
 // a role-managed Session needs a current Owner authorization, and a contact/guest
 // Preset never executes tools, whether or not its lease is known to this instance.
 const denial=exec=>{
  const agent=exec?.agent;if(!agent)return undefined;
  const managed=service.managedSession(agent.id);
  let lease;try{lease=service.sessionLease(agent.id);}catch{lease=undefined;if(managed||minimal.has(presetOf(agent)))return 'Identity & Access unavailable';}
  if(lease){try{service.authorize(lease,{sessionId:agent.id,operation:'tool'});return undefined;}catch{return 'Role does not authorize tools';}}
  return managed||minimal.has(presetOf(agent))?'Role does not authorize tools':undefined;
 };
 ctx.tools.guard(denial);
 // Native guards run during preparation; an earlier tool or reload can revoke
 // that lease while a prepared call is queued. Recheck at the body boundary.
 ctx.on('tools/execute',(exec,next)=>{
  const reason=denial(exec);return reason===undefined?next():{content:[{type:'text',text:'Error: '+reason}],isError:true,error:{message:reason}};
 });
 ctx.provide('identityAccess',service);
 ctx.effect(()=>()=>service.close());
}
