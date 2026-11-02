// Host-owned adapter for the existing Agent I/O command router. It never reads SDK fields.
export function roleCommand(service,actor){
 if(typeof actor!=='function')throw Error('Trusted actor resolver required');
 return {name:'role',scopes:['direct'],async execute(call){
  const auth=await actor(call),args=call.args??[],operation=args[0];
  const sessionId=auth.sessionId,handle=auth.handle;
  service.authorize(handle,{sessionId,operation:'roles'});
  if(operation==='list'&&args.length===1)return call.reply(JSON.stringify(service.list(handle,{sessionId})));
  const grant=operation==='grant',reference=args[grant?2:1];
  if(grant&&args[1]!=='contact')throw Error('Only contact can be granted');
  if(!['show','grant','revoke','block','unblock'].includes(operation))throw Error('Unknown role operation');
  const target=service.reference(handle,{sessionId,principalId:reference});
  if(operation==='show'){if(args.length!==2)throw Error('Invalid role arguments');return call.reply(JSON.stringify(service.show(handle,{sessionId,target})));}
  let durationMs=null;
  if(grant&&args[3]!==undefined){const match=/^(\d+)(m|h|d)$/.exec(args[3]);if(!match)throw Error('Duration uses m/h/d');durationMs=Number(match[1])*({m:60000,h:3600000,d:86400000}[match[2]]);}
  if(args.length!==(grant?(durationMs===null?3:4):2))throw Error('Invalid role arguments');
  const result=service.change(handle,{sessionId,target,action:operation,expectedEpoch:service.policyEpoch,durationMs});
  return call.reply(JSON.stringify(result));
 }};
}
