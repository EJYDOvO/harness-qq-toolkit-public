const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inventory(dir) {
  const result={};
  function walk(sub) {
    for(const item of fs.readdirSync(path.join(dir,sub),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const rel=path.posix.join(sub,item.name),file=path.join(dir,rel);
      assert(!item.isSymbolicLink(),`Backup must not contain links: ${rel}`);
      if(item.isDirectory()) walk(rel);
      else { assert(item.isFile(),`Unexpected backup entry: ${rel}`); result[rel]=hash(file); }
    }
  }
  walk('profile');
  if(fs.existsSync(path.join(dir,'feature-data')))walk('feature-data');
  assert(result['profile/package.json'],'Missing profile manifest');
  assert(result['profile/cordis.patch.yml'],'Missing profile configuration');
  result['AGENTS.md']=hash(path.join(dir,'AGENTS.md'));
  return result;
}
function seal(dir) {
  const file=path.join(dir,'manifest.json');
  const manifest=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  manifest.integrity={algorithm:'sha256',files:inventory(dir)};
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
}
function verify(dir) {
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8').replace(/^\uFEFF/,''));
  assert.equal(manifest.integrity?.algorithm,'sha256','Backup lacks integrity manifest; review it manually before using it');
  assert.deepEqual(inventory(dir),manifest.integrity.files,'Backup content changed or is incomplete');
}
module.exports={seal,verify};
if(require.main===module) {
  try { const [action,dir]=process.argv.slice(2);assert(['seal','verify'].includes(action));module.exports[action](path.resolve(dir));console.log(JSON.stringify({backupIntegrity:action,ok:true})); }
  catch(e){console.error(e.message);process.exitCode=1;}
}
