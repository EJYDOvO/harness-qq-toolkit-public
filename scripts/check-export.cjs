// Compare against local secrets without printing any secret value.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {execFileSync}=require('node:child_process');
const root=path.resolve(process.argv[2]||'D:/DeepSeek-Harness'),repo=path.resolve(__dirname,'..');
const yaml=require(require.resolve('js-yaml',{paths:[path.join(root,'data/profiles/desktop')]}));
const needles=new Set();
function secrets(v,context=''){
 if(v&&typeof v==='object'){for(const [k,x]of Object.entries(v))secrets(x,context+'.'+k);}
 else if(typeof v==='string'&&v.length>=8&&/(secret|password|token|api.?key|authorization|c2cAllow|groupAllow|openid|appId)/i.test(context)&&!v.startsWith('${'))needles.add(v);
}
secrets(yaml.load(fs.readFileSync(path.join(root,'data/profiles/desktop/cordis.patch.yml'),'utf8')));
secrets(JSON.parse(fs.readFileSync(path.join(root,'data/maintenance/owner.json'))));
let files=0,bytes=0,archiveEntries=0;const findings=[];
function inspect(data,name){
 const text=data.toString('utf8');
 for(const needle of needles)if(text.includes(needle)||text.includes(encodeURIComponent(needle)))findings.push(name+': matches a local credential or private account identifier');
 if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)||/gh[pousr]_[A-Za-z0-9]{30,}/.test(text))findings.push(name+': credential pattern');
}
function checkFiles(){
 const names=[...new Set(execFileSync('git',['-C',repo,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean))];
 for(const name of names){
  const full=path.join(repo,name);assert(fs.existsSync(full),'Tracked file missing; review deletion: '+name);
  assert(!fs.lstatSync(full).isSymbolicLink(),'Symlink in export: '+name);
  assert(!name.split('/').some(p=>['node_modules','data','resources','cache','tmp','browser-profile','backups'].includes(p)),'Runtime directory in export: '+name);
  assert(!/\.(exe|dll|asar|log|bak)$/.test(name),'Runtime artifact in export: '+name);
  const data=fs.readFileSync(full);files++;bytes+=data.length;
  if(name.endsWith('.tgz')){
   const tar=zlib.gunzipSync(data);for(let at=0;at+512<=tar.length;){const header=tar.subarray(at,at+512);if(header.every(x=>x===0))break;const inner=header.subarray(0,100).toString().replace(/\0.*$/s,'');const length=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim()||'0',8);assert(Number.isFinite(length));assert(!/(^|\/)\.env($|\.)|(^|\/)owner\.json$/.test(inner),'Private file in archive');inspect(tar.subarray(at+512,at+512+length),name+'!'+inner);archiveEntries++;at+=512+Math.ceil(length/512)*512;}
  }else inspect(data,name);
 }
}
checkFiles();assert.equal(findings.length,0,findings.join('\n'));
console.log(JSON.stringify({ok:true,files,bytes,archiveEntries,matchedLocalSecrets:0}));
