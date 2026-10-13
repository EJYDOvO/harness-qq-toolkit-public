const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {root}=require('./ops.cjs');const {verify}=require('./backup-integrity.cjs');
const base=path.join(root,'data/maintenance/backups');
function plan(now=Date.now()){
 const config=JSON.parse(fs.readFileSync(path.join(__dirname,'features.json'),'utf8')).retention;
 const entries=fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>({id:e.name,dir:path.resolve(base,e.name),mtime:fs.statSync(path.join(base,e.name)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
 return entries.filter((e,i)=>i>=config.keepNewest&&now-e.mtime>config.minAgeDays*86400000).map(e=>({id:e.id,path:e.dir}));
}
function remove(candidates){
 const lock=fs.openSync(path.join(root,'data/maintenance/maintenance.lock'),'a+');
 try{for(const candidate of candidates){const resolved=fs.realpathSync(candidate.path);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(base).toLowerCase(),'Backup escaped backup root');assert(!fs.lstatSync(resolved).isSymbolicLink());verify(resolved);fs.rmSync(resolved,{recursive:true,force:false});}}finally{fs.closeSync(lock);}
}
if(require.main===module){try{const candidates=plan();console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'preview',candidates},null,2));if(process.argv.includes('--apply'))remove(candidates);}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={plan};
