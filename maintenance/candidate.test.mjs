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
const {candidateArtifacts}=createRequire(import.meta.url)('./candidate.cjs');
test('candidate artifact pins follow the reviewed policy and keep every other live pin',()=>{
 const live={'dsh-character-core':{source:'file:core-31.tgz',sha256:'a',version:'31'},'dsh-agent-io':{name:'dsh-agent-io',source:'file:io-9.tgz',sha256:'b',version:'9'},'unpinned':{source:'file:u.tgz',sha256:'c',version:'1'}};
 const policy={'dsh-character-core':{source:'file:core-33.tgz',sha256:'d',version:'33'},'dsh-agent-io':{source:'file:io-9.tgz',sha256:'b',version:'9'},'dsh-task-memory-local':{source:'file:t.tgz',sha256:'e',version:'2'}};
 const out=candidateArtifacts(live,policy);
 assert.deepEqual(Object.keys(out),Object.keys(live),'no package is added or dropped');
 assert.deepEqual(out['dsh-character-core'],{source:'file:core-33.tgz',sha256:'d',version:'33'});
 assert.equal(out['dsh-agent-io'].name,'dsh-agent-io');assert.deepEqual(out.unpinned,live.unpinned);
 assert.throws(()=>candidateArtifacts(live,{'dsh-character-core':{source:'file:x.tgz',version:'33'}}),/Incomplete policy pin/);
 assert.throws(()=>candidateArtifacts([],{}));
});
test('Character pins are written, sealed and deployed with the candidate',()=>{
 const stage=fs.readFileSync(new URL('./stage.cjs',import.meta.url),'utf8'),manage=fs.readFileSync(new URL('./manage.ps1',import.meta.url),'utf8');
 assert(stage.includes('const hashes = dir => Object.fromEntries(profileFiles().map('),'seal and check cover the pins file');
 assert(stage.includes('candidateArtifacts(JSON.parse(fs.readFileSync(path.join(profile,pinsFile)'),'the candidate gets updated pins');
 assert(manage.includes("Copy-Item -LiteralPath (Join-Path $taskStage 'character-artifacts.json') -Destination (Join-Path $taskProfile 'character-artifacts.json') -Force"),'DeployValidated moves the pins');
});
