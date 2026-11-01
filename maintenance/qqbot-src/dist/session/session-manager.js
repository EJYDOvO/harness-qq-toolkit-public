export class SessionManager {
 constructor(ctx,agents,config,logger){
  const service=ctx.get('conversationManager');if(!service)throw Error('Install and configure dsh-conversation-manager before QQ');
  const namespace='qqbot:'+config.appId;
  const manager=service.openAdapter(namespace,{...config,context:ctx,adapter:{
   key:(scope,peer)=>namespace+':'+scope+':'+peer,
   lifecycleScope:scope=>scope==='c2c',
   acceptActivity:(scope,peer,sender,id)=>scope==='c2c'&&peer===sender&&typeof id==='string'&&id.length>0,
   isUserInput:target=>typeof target?.msgId==='string'&&target.msgId.length>0,
   inputId:target=>target?.msgId,
   waitingForUser:record=>manager.hitl?.waiting(record)===true,
   cancelPending(record){manager.hitl?.cancel(record);},
   prompt:record=>record.scope==='group'?config.groupPrompt:config.directPrompt,
   diagnostics(event,record){ctx.get('agentIO')?.diagnostics?.scope({platform:'qq-official',adapter:'qq-official-gateway',accountId:config.appId,conversation:record.peerId?{type:record.scope==='c2c'?'direct':'group',id:record.peerId}:undefined}).emit('conversation',event,{sessionId:record.sessionId,status:record.status});},
   release(record){if(record.typingKeepAlive){clearInterval(record.typingKeepAlive);record.typingKeepAlive=undefined;}manager.releaseOutput?.(record);try{ctx.get('agentIO')?.diagnostics?.scope({platform:'qq-official',adapter:'qq-official-gateway',accountId:config.appId,conversation:{type:record.scope==='c2c'?'direct':'group',id:record.peerId}}).emit('conversation','close',{sessionId:record.sessionId,status:'closed'});}catch{}},
  }});
  return manager;
 }
}
