// Copy package code only. Explicit directories avoid reading a Profile or secrets.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [sdk,qq,out]=process.argv.slice(2);
for(const p of [sdk,qq,out])assert(p&&path.isAbsolute(p),'Supply absolute SDK package, QQ package and NEW output directory');
assert(!fs.existsSync(out),'Output directory must be new');
assert.equal(JSON.parse(fs.readFileSync(path.join(sdk,'package.json'))).name,'@tencent-connect/qqbot-nodejs');
assert.equal(JSON.parse(fs.readFileSync(path.join(qq,'package.json'))).name,'@tencent-connect/dsh-qqbot');
for(const [name,src]of [['sdk',sdk],['qq',qq]]){const dest=path.join(out,name);fs.mkdirSync(dest,{recursive:true});fs.cpSync(path.join(src,'dist'),path.join(dest,'dist'),{recursive:true});fs.copyFileSync(path.join(src,'package.json'),path.join(dest,'package.json'));}
const patch=path.resolve(__dirname,'../qqbot-src/dist');fs.cpSync(patch,path.join(out,'qq/dist'),{recursive:true});
fs.cpSync(path.resolve(__dirname,'../sdk-src/dist'),path.join(out,'sdk/dist'),{recursive:true});
console.log(JSON.stringify({QQBOT_AUDIT_SDK_DIR:path.join(out,'sdk/dist'),QQBOT_AUDIT_DIST:path.join(out,'qq/dist'),credentialsCopied:false}));
