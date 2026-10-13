// Export reviewed source snapshots only. Never copy a live profile or its Git history wholesale.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const destination=path.resolve(__dirname,'..');
const root=path.resolve(process.argv[2]||'D:/DeepSeek-Harness');
assert(root!==destination,'Installation and export repository must be different');
const hash=data=>createHash('sha256').update(data).digest('hex');
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true}).trim();
const exported=[];const revisions={};
function save(relative,bytes){
 const target=path.resolve(destination,relative);assert(target.startsWith(destination+path.sep),'Export escaped repository');
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
 exported.push({path:relative.replaceAll('\\','/'),sha256:hash(bytes)});
}
function copy(from,to=from){const file=path.join(root,from);assert(fs.statSync(file).isFile());let bytes=fs.readFileSync(file);if(from==='maintenance/.gitattributes')bytes=Buffer.from('* -text\n');save(to,bytes);}
for(const relative of ['maintenance','plugin-sources/dsh-remote-ops','plugin-sources/dsh-task-memory']){
 const source=path.join(root,relative);assert.equal(git(source,'status','--porcelain'),'','Checkpoint and review source changes before exporting: '+relative);
 revisions[relative]=git(source,'rev-parse','HEAD');
 for(const entry of git(source,'ls-files').split('\n').filter(Boolean)){
  assert(!entry.split('/').includes('node_modules')&&!entry.split('/').includes('.git'),'Unexpected tracked dependency');
  const resolved=fs.realpathSync(path.join(source,entry));assert(resolved.startsWith(fs.realpathSync(source)+path.sep),'Tracked link escaped source');
  copy(relative+'/'+entry);
 }
}
copy('default-workspace/AGENTS.md');revisions['default-workspace']=git(path.join(root,'default-workspace'),'rev-parse','HEAD');
const policy=JSON.parse(fs.readFileSync(path.join(root,'maintenance/plugin-policy.json')));
const archives=Object.values(policy.localPackages).map(p=>({path:p.source.slice(5),sha256:p.sha256}));
archives.push({path:path.join(root,'plugin-packages/dsh-plugin-bilibili-0.2.4.tgz')});
for(const entry of archives){const file=path.resolve(entry.path);assert.equal(path.dirname(file),path.join(root,'plugin-packages'));const bytes=fs.readFileSync(file);if(entry.sha256)assert.equal(hash(bytes),entry.sha256);save('plugin-packages/'+path.basename(file),bytes);}
for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])copy('data/profiles/desktop/'+name,'templates/profile/'+name);
const yaml=require(require.resolve('js-yaml',{paths:[path.join(root,'data/profiles/desktop')]}));
const rows=yaml.load(fs.readFileSync(path.join(root,'data/profiles/desktop/cordis.patch.yml'),'utf8'));
const qq=rows.find(r=>r.id==='im-qqbot').config;
const template={id:'im-qqbot',disabled:true,config:{}};
for(const key of ['preset','cwd','requireMention','streaming','showToolResults','debug','sessionIdleTimeout','processingTimeoutMs','askTimeoutMs','maxQueue','textChunkLimit'])if(qq[key]!==undefined)template.config[key]=qq[key];
Object.assign(template.config,{appId:'<LOCAL_QQ_APP_ID>',appSecret:'<LOCAL_QQ_APP_SECRET>',access:{c2cMode:'allowlist',c2cAllow:['<LOCAL_OWNER_OPENID>'],groupMode:'disabled',groupAllow:[]},sendFile:{restrictPaths:true}});
const selected=[template,{id:'subagent',config:{maxDepth:1,maxActiveSubagents:3}},{id:'task-memory',disabled:false,config:{storageRoot:'D:/DeepSeek-Harness/data/storages/task-memory',injectPrompt:false,injectLimit:5,injectMaxChars:1200,injectMaxEntryChars:300,maxEntries:500}}];
save('templates/profile/cordis.patch.example.yml',Buffer.from('# Reference only. QQ is disabled until local credentials and owner are supplied.\n'+yaml.dump(selected,{lineWidth:120,noRefs:true})));
save('templates/owner.example.json',Buffer.from(JSON.stringify({openid:'<LOCAL_OWNER_OPENID>',sessionKey:'qqbot:<LOCAL_QQ_APP_ID>:c2c:<LOCAL_OWNER_OPENID>'},null,2)+'\n'));
for(const [name,folder] of [['qqbot','@tencent-connect/dsh-qqbot'],['bilibili','dsh-plugin-bilibili']])copy('data/profiles/desktop/node_modules/'+folder+'/LICENSE','licenses/'+name+'-LICENSE');
save('templates/model.example.json',Buffer.from(JSON.stringify({provider:'navigator',model:'gemma-4-31b-it',note:'Configure provider URL and credentials locally using the official application UI. They are intentionally absent from this repository.'},null,2)+'\n'));
fs.writeFileSync(path.join(destination,'source-snapshot.json'),JSON.stringify({schemaVersion:1,exportedAt:new Date().toISOString(),testedRuntime:policy.testedRuntime,sourceRevisions:revisions,files:exported},null,2)+'\n');
console.log(JSON.stringify({exportedFiles:exported.length,bytes:exported.reduce((n,e)=>n+fs.statSync(path.join(destination,e.path)).size,0),sourceRevisions:revisions}));
