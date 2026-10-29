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
