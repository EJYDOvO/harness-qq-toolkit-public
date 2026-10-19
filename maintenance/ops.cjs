const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, 'data/profiles/desktop');
const requireProfile = createRequire(path.join(profile, 'package.json'));
const yaml = requireProfile('js-yaml');
const policy = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin-policy.json'), 'utf8'));
const readYaml = file => yaml.load(fs.readFileSync(file, 'utf8'));
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}
function patchRows(dir = profile) {
  const rows = readYaml(path.join(dir, 'cordis.patch.yml'));
  assert(Array.isArray(rows), 'Profile patch must be a list');
  return rows;
}
function row(rows, id) {
  const found = rows.filter(x => x.id === id);
  assert(found.length <= 1, `Duplicate override: ${id}`);
  if (found.length) return found[0];
  const result = { id, config: {} }; rows.push(result); return result;
}
function configure(dir = profile) {
  const rows = patchRows(dir);
  const qq = row(rows, 'im-qqbot');
  const prefs = JSON.parse(fs.readFileSync(path.join(root, 'data/qqbot/model-prefs.json'), 'utf8'));
  const existing = [...new Set(Object.keys(prefs.sessionIds || {}).filter(k => k.startsWith(`qqbot:${qq.config.appId}:c2c:`)).map(k => k.split(':').at(-1)))];
  const current = qq.config.access?.c2cAllow;
  assert(current ? current.length > 0 : existing.length === 1, 'Cannot choose an owner: specify a non-empty private QQ whitelist explicitly.');
  qq.disabled ??= false;
  qq.config = {
    preset: 'cordis', cwd: path.join(root, 'default-workspace').replaceAll('\\', '/'),
    requireMention: true, streaming: true, showToolResults: false, debug: false,
    sessionIdleTimeout: 7200000, processingTimeoutMs: 1800000, askTimeoutMs: 600000,
    maxQueue: 8, textChunkLimit: 3500,
    ...qq.config,
    access: { c2cMode: 'allowlist', c2cAllow: current || existing,
      groupMode: 'disabled', groupAllow: [], ...qq.config.access },
    sendFile: { restrictPaths: true, ...qq.config.sendFile },
  };
  // Keep the upstream Creator preset, so future core releases can evolve its tool list.
  row(rows, 'subagent').config = { maxDepth: 1, maxActiveSubagents: 3, ...row(rows, 'subagent').config };
  atomic(path.join(dir, 'cordis.patch.yml'), yaml.dump(rows, { lineWidth: 120, noRefs: true }));
  console.log(JSON.stringify({ configured: true, preset: qq.config.preset, allowedPrivateUsers: qq.config.access.c2cAllow.length, groups: qq.config.access.groupMode, ...row(rows,'subagent').config }));
}
function coreVersion() {
  const archive = require('./read-asar.cjs').openArchive();
  try { return JSON.parse(archive.read('dsh/package.json')).version; } finally { archive.close(); }
}
function configureFeatures(dir=profile) {
  const rows=patchRows(dir),features=JSON.parse(fs.readFileSync(path.join(__dirname,'features.json'),'utf8'));
  const bundles=fs.existsSync(path.join(dir,'package.json'))?JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8')).dsh?.profile?.bundles??[]:[];
  if(bundles.includes('dsh-task-memory-local')) Object.assign(row(rows,'task-memory'),{disabled:bundles.includes('dsh-character-core')||!features.memory.enabled,config:{storageRoot:path.join(root,'data/storages/task-memory').replaceAll('\\','/'),injectPrompt:false,injectLimit:5,injectMaxChars:1200,injectMaxEntryChars:300,maxEntries:500}});
  Object.assign(row(rows,'mcp-browser'),{name:'@deepseek-ai/dsh-mcp-client',disabled:!features.browser.enabled,config:{serverName:'browser',transport:'stdio',command:path.join(root,'resources/runtime/primary-runtime/dependencies/node/bin/node.exe'),args:[path.join(__dirname,'browser/0.0.83/node_modules/@playwright/mcp/cli.js'),'--config',path.join(__dirname,'browser/0.0.83/config.json')],cwd:path.join(root,'default-workspace'),toolCallTimeoutMs:60000,failOnStartupError:false}});
  // A new row must use insert; overrides reference rows provided by installed bundles.
  const browser=rows.find(x=>x.id==='mcp-browser');rows.splice(rows.indexOf(browser),1);
  const previous=rows.find(x=>Array.isArray(x.insert)&&x.insert.some(y=>y.id==='mcp-browser'));
  if(previous)previous.insert=previous.insert.filter(y=>y.id!=='mcp-browser');
  rows.push({insert:[browser]});
  atomic(path.join(dir,'cordis.patch.yml'),yaml.dump(rows.filter(x=>!Array.isArray(x.insert)||x.insert.length),{lineWidth:120,noRefs:true}));
}
async function liveStatus(withPresets = false) {
  const logs = fs.readdirSync(path.join(root, 'tmp')).filter(n => /^desktop-.*\.stdout\.log$/.test(n))
    .map(n => ({ file: path.join(root, 'tmp', n), time: fs.statSync(path.join(root, 'tmp', n)).mtimeMs }))
    .sort((a,b) => b.time-a.time).slice(0, 10);
  for (const {file} of logs) {
    const urls = [...fs.readFileSync(file, 'utf8').matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/g)];
    for (const match of urls.reverse()) {
      try {
        const u = new URL(match[1]);
        const response = await fetch(new URL('/dsh-market/status' + u.search, u), { signal: AbortSignal.timeout(2500) });
        if (!response.ok) continue;
        const value = await response.json();
        if (typeof value.boot === 'string') {
          if (withPresets) {
            const entry = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(2500) });
            const cookie = entry.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
            const response = await fetch(new URL('/api/agentPresets/list',u), {
              method: 'POST', headers: { 'Content-Type':'application/json', Cookie:cookie, Origin:u.origin },
              body: JSON.stringify({ type:'client-request',rpcId:'qq-maintenance-health',method:'agentPresets/list',payload:{args:{}} }),
              signal: AbortSignal.timeout(5000)
            });
            const rpc = await response.json();
            assert(rpc.result?.ok === true, 'Preset inspection failed');
            value.presets = rpc.result.value.presets;
            const creator = value.presets.find(x => x.id === 'cordis');
            assert(creator && !creator.broken, 'Creator preset failed to activate');
            const pluginResponse=await fetch(new URL('/api/pluginManager/listPlugins',u),{
              method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:u.origin},
              body:JSON.stringify({type:'client-request',rpcId:'maintenance-plugin-health',method:'pluginManager/listPlugins',payload:{args:{}}}),signal:AbortSignal.timeout(5000)
            });
            const pluginsEnvelope=await pluginResponse.json();assert(pluginsEnvelope.result?.ok,'Plugin inspection failed');
            const plugins=pluginsEnvelope.result.value,manifest=JSON.parse(fs.readFileSync(path.join(profile,'package.json'),'utf8'));
            const checks=['im-qqbot'];
            if(manifest.dependencies['dsh-remote-ops-local'])checks.push('qq-remote-ops','mcp-browser');
            if(manifest.dsh?.profile?.bundles?.includes('dsh-task-memory-local'))checks.push('task-memory');
            value.featurePlugins=plugins.filter(p=>checks.includes(p.patchId)).map(p=>({id:p.patchId,enabled:p.enabled,phase:p.fiberPhase}));
            for(const id of checks){const p=value.featurePlugins.find(p=>p.id===id);assert(p,`Missing plugin: ${id}`);assert(!p.enabled||p.phase==='active',`Plugin failed to activate: ${id}`);}
            assert(value.featurePlugins.find(p=>p.id==='im-qqbot')?.enabled,'QQ is disabled');
          }
          return value;
        }
      } catch {}
    }
  }
  throw new Error('No authenticated local Harness status endpoint is reachable.');
}
function verify(dir = profile) {
  const rows = patchRows(dir), qq = row(rows, 'im-qqbot').config;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
  const settings = readYaml(path.join(dir,'pnpm-workspace.yaml'));
  assert.equal(settings.autoInstallPeers, false, 'Profile must use the bundled core runtime');
  const a = require('./read-asar.cjs').openArchive();
  let runtime; try { runtime = JSON.parse(a.read('dsh/package.json')).version; } finally { a.close(); }
  const characterEnabled=manifest.dsh?.profile?.bundles?.includes('dsh-character-core');
  assert.equal(qq.preset, characterEnabled ? 'qq-character' : 'cordis');
  if(characterEnabled){
    assert.equal(qq.access.c2cAllow.length,1,'Character V1 requires exactly one Owner');
    assert.equal(qq.access.groupMode,'disabled');
    assert(!manifest.dsh.profile.bundles.includes('@tencent-connect/dsh-qqbot'),'Core owns the only QQ gateway');
    assert(!manifest.dsh.profile.bundles.includes('dsh-remote-ops-local'),'Core owns Remote Ops');
    const pins=JSON.parse(fs.readFileSync(path.join(dir,'character-artifacts.json'),'utf8'));
    for(const [name,pin]of Object.entries(pins)){
      assert.equal(manifest.dependencies[name],pin.source,'Character artifact source changed');
      assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(pin.source.slice(5))).digest('hex'),pin.sha256,'Character artifact integrity failed');
    }
  }
  assert.equal(qq.access.c2cMode, 'allowlist');
  assert(qq.access.c2cAllow.length > 0);
  assert(qq.access.c2cAllow.every(id=>typeof id==='string' && id.length>0 && id!=='*'), 'Private whitelist must name individual users');
  assert(['disabled','allowlist'].includes(qq.access.groupMode));
  assert.equal(qq.sendFile.restrictPaths, true);
  for (const [name, version] of Object.entries(policy.targets)) {
    assert.equal(manifest.dependencies[name], version, `Version must be pinned: ${name}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'node_modules',name,'package.json'),'utf8')).version, version);
  }
  for(const [name,entry] of Object.entries(policy.localPackages||{})) {
    assert.equal(manifest.dependencies[name],entry.source,`Local package pin changed: ${name}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'node_modules',name,'package.json'),'utf8')).version,entry.version);
    assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(entry.source.slice(5))).digest('hex'),entry.sha256,`Local artifact changed: ${name}`);
  }
  assert.equal(settings.patchedDependencies?.[`@tencent-connect/dsh-qqbot@${policy.targets['@tencent-connect/dsh-qqbot']}`], policy.qqPatch);
  assert.equal(settings.patchedDependencies?.['@tencent-connect/qqbot-nodejs@1.0.5'],'patches/qqbot-nodejs@1.0.5.patch');
  const sdkManifest=JSON.parse(fs.readFileSync(path.join(__dirname,'sdk-upstream-1.0.5/manifest.json'),'utf8'));
  for(const file of Object.keys(sdkManifest.files))assert.equal(fs.readFileSync(path.join(dir,'node_modules/@tencent-connect/qqbot-nodejs',file),'utf8').replaceAll('\r\n','\n'),fs.readFileSync(path.join(__dirname,'sdk-src',file),'utf8').replaceAll('\r\n','\n'),`Installed SDK differs: ${file}`);
  const channel = fs.readFileSync(path.join(dir,'node_modules/@tencent-connect/dsh-qqbot/dist/features/approval-channel.js'),'utf8');
  assert(channel.includes('session.eventAt(seq)'), 'QQ approval patch is missing');
  assert(channel.includes('button.n !== entry.nonce'), 'QQ approval replay protection is missing');
  const sources=JSON.parse(fs.readFileSync(path.join(__dirname,'qqbot-upstream-0.5.2/manifest.json'),'utf8'));
  for(const file of Object.keys(sources.files)) {
    const deployed=fs.readFileSync(path.join(dir,'node_modules/@tencent-connect/dsh-qqbot',file),'utf8').replaceAll('\r\n','\n');
    const reviewed=fs.readFileSync(path.join(__dirname,'qqbot-src',file),'utf8').replaceAll('\r\n','\n');
    assert.equal(deployed,reviewed,`Installed QQ source differs from reviewed patch: ${file}`);
  }
  assert.equal(fs.readFileSync(path.join(dir,policy.qqPatch),'utf8'),fs.readFileSync(path.join(__dirname,policy.qqPatch),'utf8'),'Installed patch differs from maintained source');
  console.log(JSON.stringify({ ok: true, runtime, testedRuntime: policy.testedRuntime, runtimeReviewRequired: runtime !== policy.testedRuntime, plugins: policy.targets, access: { privateUsers: qq.access.c2cAllow.length, groupMode: qq.access.groupMode } }));
}
function access(action, scope, id) {
  if(action === 'list') return accessUnlocked(action,scope,id);
  const dir=path.join(root,'data/maintenance');
  fs.mkdirSync(dir,{recursive:true});
  // Windows denies this open while manage.ps1 holds its FileShare.None handle.
  // Conversely, that exclusive handle cannot be opened until this one closes.
  const handle=fs.openSync(path.join(dir,'maintenance.lock'),'a+');
  const accessLock=path.join(dir,'access.lock');
  let accessHandle;
  try {
    accessHandle=fs.openSync(accessLock,'wx');
    fs.writeFileSync(accessHandle,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));
    return accessUnlocked(action,scope,id);
  } finally {
    if(accessHandle!==undefined){fs.closeSync(accessHandle);fs.unlinkSync(accessLock);}
    fs.closeSync(handle);
  }
}
function accessUnlocked(action, scope, id) {
  assert(['list','add','remove'].includes(action));
  const rows = patchRows(), qq = row(rows,'im-qqbot');
  if (action !== 'list') {
    assert(['c2c','group'].includes(scope));
    assert(typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id), 'Use a QQ openid, not a QQ number');
    const key = scope === 'c2c' ? 'c2cAllow' : 'groupAllow';
    const old = qq.config.access[key] || [];
    const next = action === 'add' ? [...new Set([...old,id])] : old.filter(x => x !== id);
    assert(scope !== 'c2c' || next.length > 0, 'Refusing to remove the last private administrator');
    qq.config.access[key] = next;
    qq.config.access[scope === 'c2c' ? 'c2cMode' : 'groupMode'] = next.length ? 'allowlist' : 'disabled';
    const backup = path.join(root,'data/maintenance/access-backups',new Date().toISOString().replaceAll(':','-')+'.yml');
    atomic(backup, fs.readFileSync(path.join(profile,'cordis.patch.yml')));
    atomic(path.join(profile,'cordis.patch.yml'),yaml.dump(rows,{lineWidth:120,noRefs:true}));
  }
  console.log(JSON.stringify(qq.config.access, null, 2));
}
async function updates() {
  const installed = JSON.parse(fs.readFileSync(path.join(profile,'package.json'),'utf8')).dependencies;
  const result = [];
  for (const name of Object.keys(policy.targets)) {
    try {
      const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name) + '/latest', { signal: AbortSignal.timeout(15000) });
      assert(response.ok, `Registry returned ${response.status}`);
      const data = await response.json();
      result.push({ name, installed: installed[name], reviewedTarget: policy.targets[name], latest: data.version, peerDependencies: data.peerDependencies });
    } catch(e) { result.push({ name, error: e.message }); }
  }
  console.log(JSON.stringify(result,null,2));
}
async function main() {
  const [cmd,...args] = process.argv.slice(2);
  if (cmd === 'configure') configure(args[0]);
  else if(cmd === 'configure-features') configureFeatures(args[0]);
  else if (cmd === 'verify') verify(args[0]);
  else if (cmd === 'access') access(...args);
  else if (cmd === 'updates') await updates();
  else if (cmd === 'status' || cmd === 'idle' || cmd === 'health') {
    const s = await liveStatus(cmd === 'health');
    const idle = s.agentGuardAvailable === true && Array.isArray(s.runningAgents) && !s.runningAgents.length && !s.busy && !s.active;
    const runtime=coreVersion();
    console.log(JSON.stringify({ reachable: true, idle, boot: s.boot, coreVersion: runtime, marketVersion: s.version, runtimeReviewRequired: runtime!==policy.testedRuntime, runningAgents: s.runningAgents, installed: s.installed, presets:s.presets,featurePlugins:s.featurePlugins }));
    if(cmd === 'idle' && !idle) process.exitCode = 2;
  } else throw new Error('Commands: status, health, idle, verify [profileDir], configure [profileDir], updates, access list|add|remove [c2c|group] [openid]');
}
module.exports = { root, profile, policy, atomic, liveStatus, configure, configureFeatures, verify };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
