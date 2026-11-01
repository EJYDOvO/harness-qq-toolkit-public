import fs from 'node:fs';
import path from 'node:path';
import {resolveBackend} from './backend.js';
export const name='qq-remote-ops';
export const inject=['agents'];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
// Only the current plugin instance may write this JSON snapshot. A late result
// from a retired HMR instance leaves its durable sending fence for review.
const ledgerOwners=globalThis[Symbol.for('dsh.remote-ops.notification-ledger.v1')]??=new Map();
export function apply(ctx,config){
  let runtime,releaseAttachment;
  const {state,owner,remote,atomic}=resolveBackend(ctx,config,()=>runtime);
  const outFile=path.join(state,'qq-notifications.json');
  let durable=fs.existsSync(outFile),ledger=durable?read(outFile):{enabledAt:Date.now(),deliveries:{}};
  const ownerToken={};ledgerOwners.set(outFile,ownerToken);let disposed=false,reloadRequired=false;
  const ownsLedger=()=>!disposed&&ledgerOwners.get(outFile)===ownerToken;
  const active=new Map();let busy=false;
  const trace=(value,event,fields)=>{try{value.diagnostics?.emit('remote-ops',event,fields);}catch{}};
  const persist=(next=ledger)=>{
    if(!ownsLedger())throw Error('Remote Ops ledger owner retired');
    try{atomic(outFile,JSON.stringify(next,null,2));ledger=next;durable=true;reloadRequired=false;}
    catch(error){reloadRequired=true;throw error;}
  };
  const refresh=()=>{if(reloadRequired){if(durable||fs.existsSync(outFile)){ledger=read(outFile);durable=true;}reloadRequired=false;}};
  const allowed=c=>c.message.kind==='c2c'&&c.message.senderId===owner.openid;
  const saveHealth=(connected,detail)=>atomic(path.join(state,'qq-health.json'),JSON.stringify({connected,detail,at:Date.now(),pid:process.pid}));
  // Exactly one sender per event. With Character, its durable Outbox owns the
  // delivery (notifyEvent) and this ledger only records the key and the Outbox
  // status; standalone, the Gateway's Agent I/O notifier sends it. There is no
  // direct Gateway send. The key is persisted before any send: a crash leaves
  // 'sending', which is never replayed. Statuses: sent | not-sent | partial |
  // unknown | pending (Character Outbox still delivering) | suppressed; older
  // ledgers may hold 'failed' (any error before this version).
  async function notify(key,text){
    const value=runtime;
    if(!value||!ownsLedger())return;
    // A failed atomic write may have left a durable claim. Re-read before any
    // retry; failure to read remains fail-closed. Never erase an uncertain key.
    refresh();
    if(ledger.deliveries[key])return;
    const enabled=remote.features().notifications.enabled;
    persist({...ledger,deliveries:{...ledger.deliveries,[key]:{status:enabled?'sending':'suppressed',at:Date.now()}}});
    trace(value,'enqueue',{notificationId:'qqtk:'+key,status:enabled?'sending':'suppressed'});
    if(!enabled)return;
    const kind=key.startsWith('job:')?'maintenance_result':key.startsWith('timeout:')?'task_timeout':key.startsWith('complete:')?'task_completed':key.startsWith('failed:')?'task_failed':'configured_alert';
    let result;
    try{
     if(value.notifyEvent)result=await value.notifyEvent({eventId:'qqtk:'+key,kind,text});
     else if(value.notifications)result=await value.notifications.send({id:'qqtk:'+key,conversation:{type:'direct',id:owner.openid},text,
      // Re-checked before the send: still this attachment and still the pinned Owner.
      authorize:target=>ownsLedger()&&runtime===value&&target.type==='direct'&&target.id===owner.openid});
     else result={status:'not-sent',reason:'notifications-unavailable'};
    }catch(error){result={status:typeof error?.status==='string'?error.status:'unknown'};}
    if(!ownsLedger())return;
    const entry={...ledger.deliveries[key],status:typeof result?.status==='string'?result.status:'unknown'};
    if(typeof result?.reason==='string')entry.reason=result.reason;
    persist({...ledger,deliveries:{...ledger.deliveries,[key]:entry}});
    trace(value,'settle',{notificationId:'qqtk:'+key,status:entry.status});
  }
  async function tick(){if(busy||!runtime||!ownsLedger())return;busy=true;try{
    const f=remote.features();
    for(const n of fs.readdirSync(path.join(state,'jobs')).filter(n=>n.endsWith('.result.json')).sort()){
      if(!runtime||!ownsLedger())return;
      const v=read(path.join(state,'jobs',n));if(Date.parse(v.finishedAt)<ledger.enabledAt)continue;
      await notify('job:'+n,`维护 ${v.action}：${v.ok?'成功':'失败'}${v.rolledBack?'，已回滚':''}\n任务：${n.replace('.result.json','')}\n/ops result 查看记录。`);
    }
    if(f.remoteOps.enabled)for(const [id,v] of active){
      if(!runtime||!ownsLedger())return;
      const agent=ctx.agents.get(id);if(!agent||agent.status!=='running'){active.delete(id);continue;}
      const elapsed=Date.now()-v.startedAt,quiet=Date.now()-v.lastAt;
      if(quiet>f.remoteOps.staleAfterSeconds*1000)await notify(`stale:${id}:${v.turn}`,`任务已有 ${Math.floor(quiet/60000)} 分钟没有新进展。可用 /ops tasks 查看，/ops stop 停止当前 QQ 任务及子 Agent。`);
      else if(elapsed>f.remoteOps.notifyAfterSeconds*1000&&!ctx.get?.('agentPresets')?.serviceFor?.(agent,'interactionPolicy'))await notify(`progress:${id}:${v.turn}`,'任务仍在执行。/ops tasks 可查看主 Agent 和子 Agent 状态。');
      if(!runtime||!ownsLedger())return;
      if(elapsed>f.remoteOps.maxTurnSeconds*1000){await remote.stop();await notify(`timeout:${id}:${v.turn}`,'QQ 任务达到运行时限，已停止当前任务；请缩小任务后继续。');active.delete(id);}
    }
  }catch(error){ctx.logger?.warn('Remote operations tick failed; durable state retained');}finally{busy=false;}}
  // Native 0.2.1 frames are transient rather than session assistant/chunk events.
  ctx.on('agent/assistant-stream',({agent})=>{if(active.has(agent.id))active.get(agent.id).lastAt=Date.now();});
  ctx.on('session/event',(session,event)=>{
    if(!runtime||!runtime.manager.findBySessionId(session.header.id))return;
    const id=session.header.id;
    if(event.type==='turn/start')active.set(id,{startedAt:Date.now(),lastAt:Date.now(),turn:event.data.turn});
    if(active.has(id))active.get(id).lastAt=Date.now();
    if(event.type==='turn/end'){
      const tracked=active.get(id);
      // Only long-running tracked tasks have a separate completion notification.
      if(tracked&&Date.now()-tracked.startedAt>remote.features().remoteOps.notifyAfterSeconds*1000){const failed=!!event.data?.error||event.data?.reason?.kind!=='completed';void notify(`${failed?'failed':'complete'}:${id}:${tracked.turn}`,failed?'QQ 长任务执行失败；请查看当前会话结果。':'QQ 长任务已结束；请查看当前会话结果。').catch(()=>ctx.logger?.warn('Remote Ops notification blocked; durable state retained'));}
      active.delete(id);
    }
  });
  const service={
    commands(manager){return [{name:'ops',scope:'c2c',description:'私人运维：help/status/tasks/stop/result/backup/stage/deploy/restart/features',authorized:c=>(ownsLedger()&&allowed(c))||'运维未就绪或无权限；插件重载后需重载 QQ Gateway。',handler:async c=>{
      if(!ownsLedger())throw Error('Remote Ops instance retired; reload QQ Gateway');
      const [action='help',a,b]=c.command.args;
      if(!allowed(c))return '仅部署所有者可执行运维命令。';
      if(!remote.features().remoteOps.enabled&&!['help','features','feature'].includes(action))return '远程运维已停用；/ops feature remoteOps on 可恢复。';
      if(action==='help')return '/ops status 状态\n/ops tasks 任务\n/ops stop 停止当前 QQ 任务及子 Agent\n/ops result 维护结果\n/ops backup 备份\n/ops stage 验证候选\n/ops deploy 应用候选\n/ops restart 重启\n/ops features 功能开关\n/ops feature 名称 on|off\n/ops apply 应用 memory/browser 开关\n/ops notifications 通知记录';
      if(action==='status'){const agents=[...manager.sessions.values()].map(r=>({status:r.agent.status}));return JSON.stringify({connected:true,agents,watchdog:fs.existsSync(path.join(state,'watchdog-state.json'))?read(path.join(state,'watchdog-state.json')):null},null,2);}
      if(action==='tasks')return JSON.stringify(await remote.tasks(),null,2);
      if(action==='stop')return JSON.stringify(await remote.stop());
      if(action==='result')return JSON.stringify(remote.jobs(),null,2);
      if(action==='features')return JSON.stringify(remote.features(),null,2);
      if(action==='feature'){if(!['on','off'].includes(b))return '用法：/ops feature 名称 on|off';const value=remote.setFeature(a,b==='on');return JSON.stringify(value)+(value.requiresApply?'\n/ops apply 在空闲后应用开关。':'');}
      if(action==='notifications')return JSON.stringify(Object.entries(ledger.deliveries).slice(-8).map(([id,v])=>({id,...v})),null,2);
      const actions={backup:'Backup',stage:'Stage',deploy:'DeployValidated',restart:'Restart',apply:'ApplyFeatures'};
      if(actions[action])return await remote.queue(actions[action]);
      return '未知指令；/ops help 查看支持项。';
    }}];},
    attach(value){
      if(!ownsLedger())throw Error('Remote Ops ledger owner retired');
      if(runtime)throw Error('Remote Ops already attached to a QQ gateway');
      if(value.config.access?.c2cMode!=='allowlist'||!value.config.access.c2cAllow?.includes(owner.openid))throw Error('Remote Ops owner is not admitted by QQ policy');
      refresh();persist();runtime=value;
      const ready=()=>{if(ownsLedger()&&runtime===value)saveHealth(true,'ready');};
      const disconnected=e=>{if(ownsLedger()&&runtime===value)saveHealth(false,e.willReconnect?'reconnecting':'permanent');};
      value.bot.on('ready',ready);value.bot.on('disconnected',disconnected);
      // Reconnect the persisted owner session so native scheduled follow-ups can reach QQ after restart.
      void value.manager.getOrCreate('c2c',owner.openid,owner.openid,{scope:'c2c',targetId:owner.openid}).catch(()=>ctx.logger?.warn('QQ owner session restore failed; no new authorization granted'));
      let released=false;
      const release=()=>{if(released)return;released=true;if(runtime===value){runtime=undefined;active.clear();}value.bot.off?.('ready',ready);value.bot.off?.('disconnected',disconnected);if(releaseAttachment===release)releaseAttachment=undefined;};
      releaseAttachment=release;return release;
    }
  };
  ctx.provide('qqRemoteOps',service);
  ctx.effect(()=>{const timer=setInterval(()=>void tick(),15000);return()=>{clearInterval(timer);disposed=true;try{releaseAttachment?.();}finally{runtime=undefined;active.clear();if(ledgerOwners.get(outFile)===ownerToken)ledgerOwners.delete(outFile);}};});
}
