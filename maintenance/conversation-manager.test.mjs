import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {PrefsStore} from '../plugin-sources/dsh-conversation-manager/preferences.mjs';

const temporary=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'state.json');};
test('all ordinary preference mutations propagate write failure and retain memory/disk state',t=>{
 const prefs=new PrefsStore(undefined,temporary(t));
 prefs.setOverride('platform:a',{provider:'p',model:'m'});prefs.setPreset('platform:a','preset');prefs.setSessionId('platform:a','session');
 const before=fs.readFileSync(prefs.prefsPath,'utf8');prefs.persist=()=>{throw Error('fixture write failure');};
 for(const [method,args]of [['setOverride',['platform:a',{provider:'p',model:'changed'}]],['clearOverride',['platform:a']],['setSessionId',['platform:a','changed']],['clearSessionId',['platform:a']],['setPreset',['platform:a','changed']],['clearPreset',['platform:a']]]){
  assert.throws(()=>prefs[method](...args),/write failure/);assert.equal(prefs.getPreset('platform:a'),'preset');assert.equal(prefs.getSessionId('platform:a'),'session');assert.equal(prefs.getOverride('platform:a').model,'m');assert.equal(fs.readFileSync(prefs.prefsPath,'utf8'),before);
 }
});
test('one Host service owns shared durable preferences and exclusive platform namespaces',async t=>{
 const stateFile=temporary(t),source=fs.readFileSync(new URL('../plugin-sources/dsh-conversation-manager/index.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export {ConversationManager};','').replaceAll('export ','');
 class Manager{constructor(ctx,agents,config){this.config=config;}async disposeAll(){if(this.config.fail)throw Error('fixture handle cleanup failed');}}
 const apply=vm.runInNewContext(source+';apply;',{ConversationManager:Manager,PrefsStore});let service,cleanup;
 apply({agents:{},logger:{},provide:(_n,s)=>service=s,effect:f=>cleanup=f()},{stateFile});
 const options=ns=>({adapter:{key:(scope,peer)=>ns+':'+JSON.stringify([scope,peer])}});
 const qq=service.openAdapter('qq',options('qq')),other=service.openAdapter('second',options('second'));
 assert.equal(qq.config.preferences,other.config.preferences);assert.throws(()=>service.openAdapter('qq',options('qq')),/unavailable/);
 assert.throws(()=>service.openAdapter('qq:nested',options('qq:nested')),/unavailable/);
 const wrong=service.openAdapter('wrong',options('qq'));assert.throws(()=>wrong.config.adapter.key('direct','same'),/escaped/);
 const a=qq.config.adapter.key('direct','same'),b=other.config.adapter.key('direct','same');assert.notEqual(a,b);
 qq.config.preferences.setSessionId(a,'qq-session');other.config.preferences.setSessionId(b,'other-session');
 const reopened=new PrefsStore(undefined,stateFile);assert.equal(reopened.getSessionId(a),'qq-session');assert.equal(reopened.getSessionId(b),'other-session');
 await qq.disposeAll();service.openAdapter('qq',options('qq'));
 const failed=service.openAdapter('failure',{...options('failure'),fail:true});await assert.rejects(failed.disposeAll(),/cleanup failed/);assert.throws(()=>service.openAdapter('failure',options('failure')),/unavailable/);
 await assert.rejects(cleanup(),/cleanup/);assert.throws(()=>service.openAdapter('third',options('third')),/unavailable/);
});

// ── Session namespace: one state file per Character, one shared Session store ──
// A key with no recorded Session derives its id from the key. The key does not
// name the Character, so two Characters sharing the Host Session store would
// derive the same id and resume each other's history. A namespace in the state
// file scopes the derived id to that file's owner.
test('a session namespace in the state file is kept by every kind of save', t => {
 const stateFile = temporary(t);
 fs.writeFileSync(stateFile, JSON.stringify({sessionNamespace: 'yuha', overrides: {}, presets: {}, sessionIds: {'qq:a': 'recorded'}, lifecycle: {}}));
 const prefs = new PrefsStore(undefined, stateFile);
 assert.equal(prefs.sessionNamespace, 'yuha');
 const saved = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
 prefs.setSessionId('qq:b', 'other');
 assert.equal(saved().sessionNamespace, 'yuha');
 prefs.commitSession('qq:c', 'third', {provider: 'p', model: 'm'});
 assert.equal(saved().sessionNamespace, 'yuha');
 prefs.commitLifecycle('qq:a', {bootId: 'b', lastUserAt: 1});
 assert.equal(saved().sessionNamespace, 'yuha');
 assert.equal(new PrefsStore(undefined, stateFile).sessionNamespace, 'yuha');
});
test('a state file without a namespace saves exactly as before', t => {
 const stateFile = temporary(t);
 const prefs = new PrefsStore(undefined, stateFile);
 assert.equal(prefs.sessionNamespace, undefined);
 prefs.setSessionId('qq:a', 'session');
 assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).sort(), ['lifecycle', 'overrides', 'presets', 'sessionIds']);
});
test('an invalid session namespace makes the state unreadable instead of being dropped', t => {
 for (const bad of [5, '', 'x'.repeat(129), ' padded']) {
  const stateFile = temporary(t);
  fs.writeFileSync(stateFile, JSON.stringify({sessionNamespace: bad, sessionIds: {}}));
  const prefs = new PrefsStore(undefined, stateFile);
  assert.ok(prefs.loadError, JSON.stringify(bad));
  assert.throws(() => prefs.write(), /cannot be replaced/);
 }
});
test('derived Session ids are scoped by the namespace; without one they are unchanged', async () => {
 const {deriveSessionId} = await import('../plugin-sources/dsh-conversation-manager/session-id.mjs');
 const derive = (sessionNamespace, key) => deriveSessionId(key, sessionNamespace);
 const key = 'qqbot:app:c2c:peer';
 // The historical formula, so existing derived Sessions keep their ids.
 const hash = (await import('node:crypto')).createHash('sha256').update(key).digest('hex');
 assert.equal(derive(undefined, key), `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`);
 assert.notEqual(derive('yuha', key), derive('tasha', key));
 assert.notEqual(derive('yuha', key), derive(undefined, key));
 assert.equal(derive('yuha', key), derive('yuha', key));
 assert.match(derive('yuha', key), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
