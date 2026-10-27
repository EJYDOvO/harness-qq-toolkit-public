// Runtime binaries may move after an official update; data and Profile stay put.
const fs=require('node:fs'),path=require('node:path');
function resolveRuntime(root,env=process.env){
 const file=path.join(root,'data/maintenance/host-runtime.json');let saved;
 if(!env.DSH_CHARACTER_HOST_ROOT&&!env.DSH_RUNTIME_ROOT&&fs.existsSync(file)){
  const value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));if(value.schemaVersion!==1||typeof value.runtimeRoot!=='string')throw Error('Invalid host runtime selection');saved=value.runtimeRoot;
 }
 const value=env.DSH_CHARACTER_HOST_ROOT||env.DSH_RUNTIME_ROOT||saved||root;
 if(!path.isAbsolute(value))throw Error('Host runtime directory must be absolute');
 const runtimeRoot=path.resolve(value);return {runtimeRoot,exe:path.join(runtimeRoot,'DeepSeek Harness.exe'),archive:path.join(runtimeRoot,'resources/app.asar')};
}
module.exports={resolveRuntime};
if(require.main===module)console.log(resolveRuntime(path.resolve(__dirname,'..')).runtimeRoot);
