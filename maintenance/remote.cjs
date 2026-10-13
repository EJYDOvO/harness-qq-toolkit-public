const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {root,profile,atomic,liveStatus}=require('./ops.cjs');
const {connect}=require('./local-client.cjs');
const state=path.join(root,'data/maintenance');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
function features(){return read(path.join(__dirname,'features.json'));}
function setFeature(name,enabled){
 assert(['remoteOps','notifications','watchdog','memory','browser'].includes(name));assert(typeof enabled==='boolean');
 // Coordinate with the exclusive Windows maintenance handle and other feature writers.
 const handle=fs.openSync(path.join(state,'maintenance.lock'),'a+');let guard;
 const file=path.join(state,'features.lock');
 try{guard=fs.openSync(file,'wx');fs.writeFileSync(guard,JSON.stringify({pid:process.pid}));const f=features();f[name].enabled=enabled;atomic(path.join(__dirname,'features.json'),JSON.stringify(f,null,2)+'\n');return {feature:name,enabled,requiresApply:['memory','browser'].includes(name)};}
 finally{if(guard!==undefined){fs.closeSync(guard);fs.unlinkSync(file);}fs.closeSync(handle);}
}
function ownerSession(){const prefs=read(path.join(root,'data/qqbot/model-prefs.json'));const owner=read(path.join(state,'owner.json'));return prefs.sessionIds?.[owner.sessionKey];}
async function tasks(){const {rpc}=await connect();const id=ownerSession();if(!id)return {session:null,children:[]};const p=await rpc('session/projections',{request:{sessionId:id}});const s=await liveStatus();return {session:id,running:s.runningAgents.includes(id),children:(p.values.subagentCatalog||[]).map(c=>({id:c.id,label:c.label,mode:c.mode,running:s.runningAgents.includes(c.id)}))};}
async function stop(){const {rpc}=await connect();const t=await tasks();if(!t.session)return {stopped:[]};const stopped=[];for(const c of t.children.filter(c=>c.running&&c.mode==='continuable')){await rpc('subagents/interruptByParent',{childSessionId:c.id,parentSessionId:t.session,mode:'continuable'});stopped.push(c.id);}if(t.running){await rpc('session/cancel',{request:{sessionId:t.session}});stopped.push(t.session);}return {stopped};}
function jobs(){return fs.readdirSync(path.join(state,'jobs')).filter(n=>n.endsWith('.result.json')).sort().slice(-5).reverse().map(n=>{const v=read(path.join(state,'jobs',n));return {id:n.replace('.result.json',''),action:v.action,ok:v.ok,finishedAt:v.finishedAt,rolledBack:v.rolledBack===true};});}
function queue(action){assert(['Backup','Stage','DeployValidated','Restart','Restore','ApplyFeatures'].includes(action));assert(action!=='Restore','Restore requires an explicit reviewed backup id via manage.ps1');return new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-File',path.join(__dirname,'manage.ps1'),'-Action',action,'-Queue'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',c=>c===0?resolve(out.trim()):reject(Error(err.slice(0,500)||'queue failed')));});}
async function main(){const [cmd,a,b]=process.argv.slice(2);let value;if(cmd==='tasks')value=await tasks();else if(cmd==='stop')value=await stop();else if(cmd==='jobs')value=jobs();else if(cmd==='features')value=features();else if(cmd==='feature'){assert(['on','off'].includes(b));value=setFeature(a,b==='on');}else if(cmd==='queue')value=await queue(a);else throw Error('Commands: tasks, stop, jobs, features, feature NAME on|off, queue ACTION');console.log(JSON.stringify(value,null,2));}
module.exports={features,setFeature,tasks,stop,jobs,queue};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
