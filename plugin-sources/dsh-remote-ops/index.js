import fs from 'node:fs';
import path from 'node:path';
import {resolveBackend} from './backend.js';
export const name='qq-remote-ops';
export const inject=['agents'];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function apply(ctx,config){
  let runtime;
  const {state,owner,remote,atomic}=resolveBackend(ctx,config,()=>runtime);
  const outFile=path.join(state,'qq-notifications.json');
  const ledger=fs.existsSync(outFile)?read(outFile):{enabledAt:Date.now(),deliveries:{}};
  const active=new Map();let busy=false;
  const persist=()=>atomic(outFile,JSON.stringify(ledger,null,2));
  const allowed=c=>c.message.kind==='c2c'&&c.message.senderId===owner.openid;
  const saveHealth=(connected,detail)=>atomic(path.join(state,'qq-health.json'),JSON.stringify({connected,detail,at:Date.now(),pid:process.pid}));
  async function notify(key,text){
    if(!runtime||ledger.deliveries[key])return;
    if(!remote.features().notifications.enabled){ledger.deliveries[key]={status:'suppressed',at:Date.now()};persist();return;}
    // Persist before sending. A crash with status=sending is ambiguous and never auto-replayed.
    ledger.deliveries[key]={status:'sending',at:Date.now()};persist();
    try{if(runtime.notifyEvent){await runtime.notifyEvent({eventId:'qqtk:'+key,kind:key.startsWith('job:')?'maintenance_result':key.startsWith('timeout:')?'task_timeout':key.startsWith('complete:')?'task_completed':key.startsWith('failed:')?'task_failed':'configured_alert',text});}else{await runtime.sender.sendMarkdown({scope:'c2c',targetId:owner.openid},text);}ledger.deliveries[key].status='sent';}
    catch{ledger.deliveries[key].status='failed';}
    persist();
  }
  async function tick(){if(busy||!runtime)return;busy=true;try{
    const f=remote.features();
    for(const n of fs.readdirSync(path.join(state,'jobs')).filter(n=>n.endsWith('.result.json')).sort()){
      const v=read(path.join(state,'jobs',n));if(Date.parse(v.finishedAt)<ledger.enabledAt)continue;
      await notify('job:'+n,`维护 ${v.action}：${v.ok?'成功':'失败'}${v.rolledBack?'，已回滚':''}\n任务：${n.replace('.result.json','')}\n/ops result 查看记录。`);
    }
    if(f.remoteOps.enabled)for(const [id,v] of active){
      const agent=ctx.agents.get(id);if(!agent||agent.status!=='running'){active.delete(id);continue;}
      const elapsed=Date.now()-v.startedAt,quiet=Date.now()-v.lastAt;
      if(quiet>f.remoteOps.staleAfterSeconds*1000)await notify(`stale:${id}:${v.turn}`,`任务已有 ${Math.floor(quiet/60000)} 分钟没有新进展。可用 /ops tasks 查看，/ops stop 停止当前 QQ 任务及子 Agent。`);
      else if(elapsed>f.remoteOps.notifyAfterSeconds*1000)await notify(`progress:${id}:${v.turn}`,'任务仍在执行。/ops tasks 可查看主 Agent 和子 Agent 状态。');
      if(elapsed>f.remoteOps.maxTurnSeconds*1000){await remote.stop();await notify(`timeout:${id}:${v.turn}`,'QQ 任务达到运行时限，已停止当前任务；请缩小任务后继续。');active.delete(id);}
    }
  }catch(error){ctx.logger?.warn('Remote operations tick failed: '+error.message);}finally{busy=false;}}
  ctx.on('session/event',(session,event)=>{
    if(!runtime||!runtime.manager.findBySessionId(session.header.id))return;
    const id=session.header.id;
    if(event.type==='turn/start')active.set(id,{startedAt:Date.now(),lastAt:Date.now(),turn:event.data.turn});
    if(active.has(id))active.get(id).lastAt=Date.now();
    if(event.type==='turn/end'){
      const tracked=active.get(id);
      // Only long-running tracked tasks have a separate completion notification.
      if(tracked&&Date.now()-tracked.startedAt>remote.features().remoteOps.notifyAfterSeconds*1000){const failed=!!event.data?.error||event.data?.reason?.kind!=='completed';void notify(`${failed?'failed':'complete'}:${id}:${tracked.turn}`,failed?'QQ 长任务执行失败；请查看当前会话结果。':'QQ 长任务已结束；请查看当前会话结果。');}
      active.delete(id);
    }
  });
  const service={
    commands(manager){return [{name:'ops',scope:'c2c',description:'私人运维：help/status/tasks/stop/result/backup/stage/deploy/restart/features',authorized:c=>allowed(c)||'仅部署所有者可执行运维命令。',handler:async c=>{
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
      if(runtime)throw Error('Remote Ops already attached to a QQ gateway');
      if(value.config.access?.c2cMode!=='allowlist'||!value.config.access.c2cAllow?.includes(owner.openid))throw Error('Remote Ops owner is not admitted by QQ policy');
      runtime=value;persist();
      const ready=()=>{if(runtime===value)saveHealth(true,'ready');};
      const disconnected=e=>{if(runtime===value)saveHealth(false,e.willReconnect?'reconnecting':'permanent');};
      value.bot.on('ready',ready);value.bot.on('disconnected',disconnected);
      // Reconnect the persisted owner session so native scheduled follow-ups can reach QQ after restart.
      void value.manager.getOrCreate('c2c',owner.openid,owner.openid,{scope:'c2c',targetId:owner.openid}).catch(e=>ctx.logger?.warn('QQ owner session restore failed: '+e.message));
      return ()=>{if(runtime===value){runtime=undefined;active.clear();}value.bot.off?.('ready',ready);value.bot.off?.('disconnected',disconnected);};
    }
  };
  ctx.provide('qqRemoteOps',service);
  ctx.effect(()=>{const timer=setInterval(()=>void tick(),15000);return()=>{clearInterval(timer);runtime=undefined;active.clear();};});
}
