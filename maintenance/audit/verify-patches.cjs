// Applies both patches to fresh source-only fixtures, never installed packages.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),tmp=path.resolve(root,'../tmp');fs.mkdirSync(tmp,{recursive:true});
for(const [upstream,source,patch]of [['qqbot-upstream-0.5.2','qqbot-src','dsh-qqbot@0.5.2.patch'],['sdk-upstream-1.0.5','sdk-src','qqbot-nodejs@1.0.5.patch']]){
 const dir=fs.mkdtempSync(path.join(tmp,'patch-check-')),manifest=JSON.parse(fs.readFileSync(path.join(root,upstream,'manifest.json')));
 for(const file of Object.keys(manifest.files)){fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.copyFileSync(path.join(root,upstream,file),path.join(dir,file));}
 const git=(...args)=>{const r=spawnSync('git',['-c','core.autocrlf=false',...args],{cwd:dir,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);};
 git('init','--quiet');git('apply','--check',path.join(root,'patches',patch));git('apply',path.join(root,'patches',patch));
 const files=[...Object.keys(manifest.files),...(manifest.added??[])];
 for(const file of files)assert(fs.readFileSync(path.join(dir,file)).equals(fs.readFileSync(path.join(root,source,file))),file);
 console.log(JSON.stringify({patch,applied:true,matchedFiles:files.length}));
}
