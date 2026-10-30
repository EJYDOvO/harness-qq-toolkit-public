// Rebuild from reviewed source snapshots; never edit an installed package.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const assert = require('node:assert/strict');
const sdk=process.argv.includes('--sdk');
const base = path.join(__dirname,sdk?'sdk-upstream-1.0.5':'qqbot-upstream-0.5.2');
const manifest = JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
let patch = '';
for (const [file,sha256] of Object.entries(manifest.files)) {
  const original = path.join(base,file);
  const modified = path.join(__dirname,sdk?'sdk-src':'qqbot-src',file);
  assert.equal(createHash('sha256').update(fs.readFileSync(original)).digest('hex'),sha256,`Upstream changed: ${file}`);
  const diff=spawnSync('git',['-c','core.autocrlf=false','diff','--no-index','--no-ext-diff','--text',original,modified],{encoding:'utf8',windowsHide:true});
  assert([0,1].includes(diff.status),diff.stderr || 'git diff failed');
  if(diff.status===0) continue;
  patch += diff.stdout.replace(/^diff --git .*$/m,`diff --git a/${file} b/${file}`)
    .replace(/^--- .*$/m,`--- a/${file}`).replace(/^\+\+\+ .*$/m,`+++ b/${file}`);
}
// Reviewed files with no upstream counterpart are added by the patch.
for (const file of manifest.added ?? []) {
  assert(!(file in manifest.files),`Added file is also an upstream file: ${file}`);
  const modified = path.join(__dirname,sdk?'sdk-src':'qqbot-src',file);
  const diff=spawnSync('git',['-c','core.autocrlf=false','diff','--no-index','--no-ext-diff','--text','/dev/null',modified],{encoding:'utf8',windowsHide:true});
  assert.equal(diff.status,1,diff.stderr || `Added file missing: ${file}`);
  patch += diff.stdout.replace(/^diff --git .*$/m,`diff --git a/${file} b/${file}`).replace(/^\+\+\+ .*$/m,`+++ b/${file}`);
}
const target=path.join(__dirname,sdk?'patches/qqbot-nodejs@1.0.5.patch':'patches/dsh-qqbot@0.5.2.patch');
if(process.argv.includes('--check')) assert.equal(fs.readFileSync(target,'utf8'),patch,'Rebuild the QQ patch');
else fs.writeFileSync(target,patch);
console.log(JSON.stringify({patch:target,files:Object.keys(manifest.files).length,added:(manifest.added??[]).length,checked:process.argv.includes('--check')}));
