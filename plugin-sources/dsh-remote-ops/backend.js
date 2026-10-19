import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function atomic(file,content){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,content);fs.renameSync(temp,file);}
export function resolveBackend(ctx,config,getRuntime){
  const root=config.root;
  if(root&&!path.isAbsolute(root))throw Error('Legacy installation root must be absolute');
  const state=config.stateDirectory??(root&&path.join(root,'data','maintenance'));
  if(!state||!path.isAbsolute(state))throw Error('Remote Ops requires an explicit stateDirectory');
  const ownerFile=config.ownerFile??(root&&path.join(state,'owner.json'));
  const ownerId=config.ownerId??(ownerFile&&read(ownerFile).openid);
  if(typeof ownerId!=='string'||!ownerId||ownerId==='*')throw Error('Remote Ops requires an explicit private owner');
  fs.mkdirSync(state,{recursive:true});fs.mkdirSync(path.join(state,'jobs'),{recursive:true});
  let remote=ctx.get?.('qqMaintenance');
  if(config.backend==='service'&&!remote)throw Error('Configured qqMaintenance service unavailable; no fallback');
  if(!remote&&root){
    // Optional legacy Windows maintenance adapter; never imported in standalone mode.
    const req=createRequire(path.join(root,'maintenance','remote.cjs'));
    remote=req(path.join(root,'maintenance','remote.cjs'));
  }
  if(!remote){
    const file=path.join(state,'ops-features.json');
    const defaults={remoteOps:{enabled:true,notifyAfterSeconds:120,staleAfterSeconds:300,maxTurnSeconds:1800},notifications:{enabled:true}};
    const features=()=>fs.existsSync(file)?read(file):structuredClone(defaults);
    const ownAgents=()=>[...(getRuntime()?.manager.sessions.values()??[])].filter(r=>r.scope==='c2c'&&r.peerId===ownerId&&r.senderId===ownerId).map(r=>r.agent);
    remote={features,setFeature(name,enabled){if(!['remoteOps','notifications'].includes(name)||typeof enabled!=='boolean')throw Error('Feature unsupported by standalone backend');const f=features();f[name].enabled=enabled;atomic(file,JSON.stringify(f));return {feature:name,enabled,requiresApply:false};},
      async tasks(){return {sessions:ownAgents().map(a=>({id:a.id,running:a.status==='running'}))};},
      async stop(){const stopped=[];for(const a of ownAgents()){if(a.status!=='running')continue;if(typeof a.cancel!=='function')throw Error('Host cancel unavailable; provide qqMaintenance.stop');await a.cancel({kind:'user'});stopped.push(a.id);}return {stopped};},
      jobs(){return [];},async queue(){throw Error('Maintenance backend not configured; provide trusted qqMaintenance service or explicit legacy root');}
    };
  }
  for(const key of ['features','setFeature','tasks','stop','jobs','queue'])if(typeof remote[key]!=='function')throw Error('Incomplete qqMaintenance backend: '+key);
  return {state,owner:{openid:ownerId},remote,atomic};
}
