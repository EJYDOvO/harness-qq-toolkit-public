// Current tracked source only. No local credential/Profile lookup.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const repo=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const names=cp.execFileSync('git',['ls-files','-z'],{cwd:repo,encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean);
const findings=[];let bytes=0,files=0;
for(const name of names){
 const full=path.join(repo,name);if(!fs.existsSync(full)){findings.push({file:name,kind:'missing-tracked-file'});continue;}
 const stat=fs.lstatSync(full);assert(!stat.isSymbolicLink(),'Review tracked symlink: '+name);
 if(/\.(?:tgz|zip|sqlite\d*|db|log|exe|dll|asar|bak)$/i.test(name)||/(?:^|\/)(?:node_modules|private|test-data|artifacts|data|backups)\//.test(name)||/^(?:agents?|publication)\.md$/i.test(path.basename(name)))findings.push({file:name,kind:'private-or-generated-artifact'});
 const data=fs.readFileSync(full),s=data.toString('utf8');files++;bytes+=data.length;
 if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{32,}/.test(s))findings.push({file:name,kind:'credential-pattern'});
 if(/(?:[A-Z]:[\\/](?:Users|DeepSeek-Harness)[\\/]|(?<![A-Za-z0-9])\/Users\/[^/]+\/)/i.test(s))findings.push({file:name,kind:'device-path'});
}
console.log(JSON.stringify({ok:!findings.length,files,bytes,findings}));if(findings.length)process.exitCode=1;
