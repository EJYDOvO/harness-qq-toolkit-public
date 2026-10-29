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
   waitingForUser:record=>!!(manager.questionChannel?.pending.has(record.sessionKey)||manager.approvalChannel?.pending.has(record.sessionKey)),
   cancelPending(record){manager.questionChannel?.cancelPending(record.sessionKey);manager.approvalChannel?.cancelPending(record.sessionKey);},
   prompt:record=>record.scope==='group'?config.groupPrompt:config.directPrompt,
   release(record){if(record.typingKeepAlive){clearInterval(record.typingKeepAlive);record.typingKeepAlive=undefined;}},
  }});
  return manager;
 }
}
