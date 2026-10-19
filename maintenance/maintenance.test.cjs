const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {configure,configureFeatures,root,profile}=require('./ops.cjs');
const yaml=require(require.resolve('js-yaml',{paths:[profile]}));
const backup=require('./backup-integrity.cjs');
test('candidate defaults preserve custom settings and never resurrect an empty whitelist',()=>{
  const dir=fs.mkdtempSync(path.join(root,'tmp/config-test-'));
  const rows=[{id:'im-qqbot',config:{appId:'test',cwd:'D:/custom',preset:'cordis',maxQueue:2,askTimeoutMs:123456,streaming:false,access:{c2cMode:'allowlist',c2cAllow:['fixture-owner'],groupMode:'disabled',groupAllow:[]},sendFile:{restrictPaths:true,extraRoots:['D:/exports']}}},{id:'subagent',config:{maxDepth:1,maxActiveSubagents:2}}];
  const file=path.join(dir,'cordis.patch.yml');fs.writeFileSync(file,yaml.dump(rows));configure(dir);
  const after=yaml.load(fs.readFileSync(file,'utf8'));
  for(const key of ['cwd','preset','maxQueue','askTimeoutMs','streaming','access','sendFile'])assert.deepEqual(after[0].config[key],rows[0].config[key]);
  assert.equal(after[1].config.maxActiveSubagents,2);
  after[0].config.access.c2cAllow=[];fs.writeFileSync(file,yaml.dump(after));assert.throws(()=>configure(dir),/non-empty/);
});
test('backup integrity detects corruption and incomplete backups before restore',()=>{
  const dir=fs.mkdtempSync(path.join(root,'tmp/backup-test-'));fs.mkdirSync(path.join(dir,'profile'));
  for(const file of ['profile/package.json','profile/cordis.patch.yml','AGENTS.md','manifest.json'])fs.writeFileSync(path.join(dir,file),'{}');
  backup.seal(dir);backup.verify(dir);
  fs.writeFileSync(path.join(dir,'profile/package.json'),'corrupt');assert.throws(()=>backup.verify(dir),/changed/);
  fs.writeFileSync(path.join(dir,'profile/package.json'),'{}');backup.verify(dir);
  fs.unlinkSync(path.join(dir,'profile/cordis.patch.yml'));assert.throws(()=>backup.verify(dir),/Missing/);
});

test('re-applying feature configuration is idempotent and keeps one browser entry',()=>{
 const dir=fs.mkdtempSync(path.join(root,'tmp/config-feature-test-')),file=path.join(dir,'cordis.patch.yml');
 fs.writeFileSync(file,yaml.dump([{id:'custom',config:{keep:'unchanged'}}]));
 configureFeatures(dir);const first=fs.readFileSync(file,'utf8');configureFeatures(dir);assert.equal(fs.readFileSync(file,'utf8'),first);
 const rows=yaml.load(first);assert.equal(rows[0].config.keep,'unchanged');assert.equal(rows.flatMap(r=>r.insert||[]).filter(r=>r.id==='mcp-browser').length,1);
 assert.equal(rows.find(r=>r.id==='task-memory'),undefined,'Absent legacy bundle must not gain a dangling override');
});
