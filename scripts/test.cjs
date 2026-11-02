// Fresh code-only QQ/SDK fixture. Never consult an installed Profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqtk-code-'));
try {
 const env={...process.env,...require('./portable.cjs').fixture(dir+'/fixture')};
 fs.mkdirSync(root+'/tmp',{recursive:true});
 const audit=process.argv.includes('--audit');
 const names=audit?fs.readdirSync(root+'/maintenance/audit').filter(f=>f.endsWith('.test.mjs')).map(f=>'maintenance/audit/'+f):fs.readdirSync(root+'/maintenance').filter(f=>/\.test\.(mjs|cjs)$/.test(f)).map(f=>'maintenance/'+f);
 const result=cp.spawnSync(process.execPath,['--test',...names],{cwd:root,env,stdio:'inherit',windowsHide:true});
 process.exitCode=result.status??1;
} finally {fs.rmSync(dir,{recursive:true,force:true});}
