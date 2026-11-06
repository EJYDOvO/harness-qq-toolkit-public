// Read-only deployment gate. Never evaluates !!js, probes a network, or writes a Profile.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),yaml=require('js-yaml');
const expression=new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:()=>({expression:true})});
const schema=yaml.JSON_SCHEMA.extend(expression);
const integer=x=>Number.isSafeInteger(x)&&x>0;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(k=>keys.includes(k));
const routeKey=(provider,id)=>JSON.stringify([provider,id]);
export function endpointFingerprint(baseURL){
 const url=new URL(baseURL);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Endpoint must be a concrete HTTP URL without credentials or query');
 return createHash('sha256').update(url.href.replace(/\/+$/,'')).digest('hex');
}
export function checkBudgets({profile,rows,policy,runtime,now=Date.now()}){
 const problems=[],models=[];
 try{
  if(typeof runtime!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(runtime))throw Error('Valid target runtime version required');
  if(!Array.isArray(rows))throw Error('Profile composition must be an array');
  if(!Number.isFinite(now))throw Error('Valid check time required');
  const nested=[];function scan(list,depth=0){for(const row of list){if(depth&&row?.id==='llm-pi-ai')nested.push(row);if(Array.isArray(row?.insert))scan(row.insert,depth+1);if(row?.group&&Array.isArray(row.config))scan(row.config,depth+1);if(Array.isArray(row?.config?.plugins))scan(row.config.plugins,depth+1);}}scan(rows);if(nested.length)throw Error('Nested pi-ai declarations require effective-config review');
  const declarations=rows.filter(x=>x.id==='llm-pi-ai'&&x.disabled!==true);
  if(declarations.length>1)throw Error('Multiple pi-ai overrides require effective-config review');
  if(declarations[0]?.config?.expression)throw Error('Concrete model configuration required');
  const providers=declarations[0]?.config?.providers??{};
  if(!object(providers)||providers.expression)throw Error('Concrete provider declarations required');
  const expected=new Map();
  for(const [provider,config]of Object.entries(providers)){
   if(!object(config)||config.expression||config.modelOverrides&&Object.keys(config.modelOverrides).length)throw Error('Concrete per-model declarations required');
   if(config.models===undefined)continue; // Built-in catalogs are not custom declarations.
   if(!Array.isArray(config.models))throw Error('Concrete model array required');
   for(const model of config.models){
    if(!object(model)||typeof model.id!=='string'||!model.id||model.expression)throw Error('Concrete model id required');
    const key=routeKey(provider,model.id);
    if(expected.has(key))throw Error('Duplicate model route');
    if(!integer(model.contextWindow)||model.contextWindow<=4096||!integer(model.maxTokens)||model.maxTokens>model.contextWindow)throw Error('Explicit valid contextWindow/maxTokens required for '+provider+'/'+model.id);
    expected.set(key,{provider,id:model.id,contextWindow:model.contextWindow,maxTokens:model.maxTokens,endpointSha256:endpointFingerprint(config.baseURL)});
   }
  }
  if(!expected.size){if(policy!==undefined)throw Error('Model policy without matching model declarations');return {readOnly:true,ok:true,models,problems};}
  if(!exact(policy,['schemaVersion','profile','testedRuntime','maxAgeDays','models'])||policy.schemaVersion!==1||policy.profile!==path.basename(profile)||policy.testedRuntime!==runtime||!integer(policy.maxAgeDays)||policy.maxAgeDays>90||!Array.isArray(policy.models))throw Error('Missing or invalid model-policy.json');
  const seen=new Set();
  for(const record of policy.models){
   if(!exact(record,['provider','id','contextWindow','maxTokens','endpointSha256','source','observedAt'])||typeof record.provider!=='string'||typeof record.id!=='string'||!['endpoint-discovery','reviewed-manual'].includes(record.source)||!/^[a-f0-9]{64}$/.test(record.endpointSha256))throw Error('Invalid capability record');
   const key=routeKey(record.provider,record.id),declared=expected.get(key),when=Date.parse(record.observedAt);
   if(seen.has(key)||!declared)throw Error('Model policy route set differs from Profile');seen.add(key);
   if(!Number.isFinite(when)||when>now+300000||now-when>policy.maxAgeDays*86400000)throw Error('Expired or invalid capability evidence');
   for(const field of ['contextWindow','maxTokens','endpointSha256'])if(record[field]!==declared[field])throw Error('Model capability mismatch: '+record.provider+'/'+record.id+' '+field);
   models.push(declared);
  }
  if(seen.size!==expected.size)throw Error('Model policy omits configured routes');
 }catch(error){problems.push(error.message);}
 return {readOnly:true,ok:problems.length===0,models,problems};
}
export function checkProfileBudgets({profile,runtime,now}){
 try{
  // Review these concrete settings together with the effective runtime catalog.
  if(path.basename(path.dirname(profile))==='profiles'){const overlay=path.join(path.dirname(path.dirname(profile)),'cordis.patch.yml');if(fs.existsSync(overlay)){const homeRows=yaml.load(fs.readFileSync(overlay,'utf8'),{schema});if(!Array.isArray(homeRows)||JSON.stringify(homeRows).includes('llm-pi-ai'))throw Error('Home model overlay requires effective-config review');}}
  const rows=yaml.load(fs.readFileSync(path.join(profile,'cordis.patch.yml'),'utf8'),{schema});
  const file=path.join(profile,'model-policy.json');
  const policy=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):undefined;
  return checkBudgets({profile,rows,policy,runtime,now});
 }catch{return {readOnly:true,ok:false,models:[],problems:['Unable to read/parse model configuration or policy']};}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){if(!['--profile','--runtime-version'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||options[args[i]])throw Error('Invalid arguments');options[args[i]]=args[i+1];}
  if(!options['--profile']||!options['--runtime-version'])throw Error('Required --profile and --runtime-version');
  const result=checkProfileBudgets({profile:path.resolve(options['--profile']),runtime:options['--runtime-version']});console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
 }catch{console.log(JSON.stringify({readOnly:true,ok:false,problems:['Invalid model budget check arguments']}));process.exitCode=1;}
}
