const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { root, profile, policy, atomic, configure, configureFeatures } = require('./ops.cjs');
const yaml = require(require.resolve('js-yaml',{paths:[profile]}));
const stage = path.join(root,'data/profiles/qqbot-validation');
const state = path.join(root,'data/maintenance/candidate.json');
const selectedRuntime=()=>require('./runtime.cjs').resolveRuntime(root);
const files = ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = dir => Object.fromEntries(files.map(f=>[f,hash(path.join(dir,f))]));
const helperHashes=()=>Object.fromEntries(['ops.cjs','remote.cjs','local-client.cjs','manage.ps1','backup-integrity.cjs','stage.cjs','runtime.cjs','read-asar.cjs'].map(f=>[f,hash(path.join(__dirname,f))]));
const cmd = process.argv[2];
if (cmd === 'seal') {
  const record=JSON.parse(fs.readFileSync(state,'utf8'));
  assert.deepEqual(record.baseline,hashes(profile),'Live profile changed while staging');
  record.candidate=hashes(stage);
  record.patch=hash(path.join(stage,policy.qqPatch));
  record.sdkPatch=hash(path.join(stage,'patches/qqbot-nodejs@1.0.5.patch'));
  record.runtime=hash(selectedRuntime().archive);record.runtimeRoot=selectedRuntime().runtimeRoot;
  record.features=hash(path.join(__dirname,'features.json'));
  record.policy=hash(path.join(__dirname,'plugin-policy.json'));
  record.helpers=helperHashes();
  record.browser=Object.fromEntries(['package.json','pnpm-lock.yaml','config.json'].map(f=>[f,hash(path.join(__dirname,'browser/0.0.83',f))]));
  record.sealedAt=new Date().toISOString();
  atomic(state,JSON.stringify(record,null,2));
  console.log('Candidate validated and sealed.');
} else if (cmd === 'check') {
  const record=JSON.parse(fs.readFileSync(state,'utf8'));
  assert(record.sealedAt,'Run Stage first');
  assert.deepEqual(record.baseline,hashes(profile),'Live profile changed: stage again');
  assert.deepEqual(record.candidate,hashes(stage),'Candidate changed: stage again');
  assert.equal(record.patch,hash(path.join(stage,policy.qqPatch)));
  assert.equal(record.sdkPatch,hash(path.join(stage,'patches/qqbot-nodejs@1.0.5.patch')));
  assert.equal(record.runtimeRoot,selectedRuntime().runtimeRoot,'Host runtime moved: stage again');
  assert.equal(record.runtime,hash(selectedRuntime().archive),'Core changed: stage again');
  assert.equal(record.features,hash(path.join(__dirname,'features.json')),'Features changed: stage again');
  assert.equal(record.policy,hash(path.join(__dirname,'plugin-policy.json')),'Policy changed: stage again');
  assert.deepEqual(record.helpers,helperHashes(),'Maintenance helpers changed: stage again');
  assert.deepEqual(record.browser,Object.fromEntries(['package.json','pnpm-lock.yaml','config.json'].map(f=>[f,hash(path.join(__dirname,'browser/0.0.83',f))])),'Browser runtime changed: stage again');
  console.log('Candidate and live baseline verified.');
} else {
  const archive=require('./read-asar.cjs').openArchive();
  let runtime;try{runtime=JSON.parse(archive.read('dsh/package.json')).version;}finally{archive.close();}
  assert.equal(runtime,policy.testedRuntime,'New core version requires compatibility review before staging');
  const patch=path.join(__dirname,policy.qqPatch);
  assert(fs.existsSync(patch),'Reviewed QQ patch for target version is required');
  assert.equal(policy.targets['@tencent-connect/dsh-qqbot'],'0.5.2','Review the approval compatibility patch and tests before changing QQ version');
  const baseline=hashes(profile);
  if(fs.existsSync(stage)) {
    const target=path.join(root,'tmp','qqbot-validation-'+Date.now());
    assert(path.dirname(target)===path.join(root,'tmp'));
    fs.renameSync(stage,target);
  }
  fs.mkdirSync(stage,{recursive:true});
  for(const f of [...files,'cordis.yml']) fs.copyFileSync(path.join(profile,f),path.join(stage,f));
  if(fs.existsSync(path.join(profile,'patches'))) fs.cpSync(path.join(profile,'patches'),path.join(stage,'patches'),{recursive:true});
  fs.mkdirSync(path.dirname(path.join(stage,policy.qqPatch)),{recursive:true});
  fs.copyFileSync(patch,path.join(stage,policy.qqPatch));
  fs.copyFileSync(path.join(__dirname,'patches/qqbot-nodejs@1.0.5.patch'),path.join(stage,'patches/qqbot-nodejs@1.0.5.patch'));
  const manifest=JSON.parse(fs.readFileSync(path.join(stage,'package.json'),'utf8'));
  manifest.dependencies={...manifest.dependencies,...policy.targets,...Object.fromEntries(Object.entries(policy.localPackages||{}).map(([n,e])=>[n,e.source]))};
  manifest.dsh.profile.bundles=[...new Set([...manifest.dsh.profile.bundles,...Object.keys(policy.localPackages||{})])];
  atomic(path.join(stage,'package.json'),JSON.stringify(manifest,null,2)+'\n');
  const settings=yaml.load(fs.readFileSync(path.join(stage,'pnpm-workspace.yaml'),'utf8'));
  settings.autoInstallPeers=false;
  settings.patchedDependencies={...settings.patchedDependencies, '@tencent-connect/dsh-qqbot@0.5.2':policy.qqPatch};
  settings.patchedDependencies['@tencent-connect/qqbot-nodejs@1.0.5']='patches/qqbot-nodejs@1.0.5.patch';
  settings.overrides={...settings.overrides,'@tencent-connect/qqbot-nodejs':'1.0.5'};
  settings.minimumReleaseAgeExclude=[...new Set([...(settings.minimumReleaseAgeExclude||[]),...Object.entries(policy.targets).map(([n,v])=>n+'@'+v),'@tencent-connect/qqbot-nodejs@1.0.5'])];
  atomic(path.join(stage,'pnpm-workspace.yaml'),yaml.dump(settings));
  configure(stage);
  configureFeatures(stage);
  atomic(state,JSON.stringify({createdAt:new Date().toISOString(),baseline},null,2));
  console.log('Prepared isolated candidate.');
}
