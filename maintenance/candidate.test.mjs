import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const {candidateBundles}=createRequire(import.meta.url)('./candidate.cjs');
const local={'dsh-remote-ops-local':{},'dsh-task-memory-local':{},'dsh-character-core':{},'dsh-character-identity':{},'dsh-agent-io':{}};
test('a Character Profile keeps its bundles; pinned plugin packages stay dependencies',()=>{
 const live=['@deepseek-ai/dsh-base','dsh-preset-manager','dsh-character-core','dsh-character-extras'];
 const bundles=candidateBundles(live,local);assert.deepEqual(bundles,live);
 for(const forbidden of ['dsh-remote-ops-local','@tencent-connect/dsh-qqbot','dsh-character-identity','dsh-agent-io'])assert(!bundles.includes(forbidden),forbidden);
 bundles.push('x');assert.equal(live.length,4,'the live list is not mutated');
});
test('a plain QQ Profile still bundles every pinned local package once',()=>{
 assert.deepEqual(candidateBundles(['@deepseek-ai/dsh-base','dsh-remote-ops-local'],{'dsh-remote-ops-local':{},'dsh-task-memory-local':{}}),['@deepseek-ai/dsh-base','dsh-remote-ops-local','dsh-task-memory-local']);
 assert.throws(()=>candidateBundles(undefined,{}));
});
test('stage.cjs uses the shared bundle rule',()=>{
 const stage=fs.readFileSync(new URL('./stage.cjs',import.meta.url),'utf8');
 assert(stage.includes("require('./candidate.cjs').candidateBundles(manifest.dsh.profile.bundles,policy.localPackages)"));
 assert(!stage.includes('...Object.keys(policy.localPackages||{})])]'),'no second copy of the old rule');
 assert(stage.includes("'candidate.cjs'"),'a changed bundle rule must invalidate a sealed candidate');
});
