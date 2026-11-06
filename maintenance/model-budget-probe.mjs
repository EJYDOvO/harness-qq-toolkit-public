// Explicit read-only discovery. Outputs only a policy/diff proposal, never configuration or secrets.
import fs from 'node:fs';import path from 'node:path';import {createRequire}from'node:module';import{pathToFileURL}from'node:url';
const require=createRequire(import.meta.url),{codec}=require('../scripts/portable.cjs'),{propose,endpointFingerprint}=require('../scripts/model-capabilities.cjs');
const capacity=(...xs)=>xs.find(x=>Number.isSafeInteger(x)&&x>0);
export function parseListing(body){
 const rows=Array.isArray(body?.data)?body.data:body?.models&&typeof body.models==='object'&&!Array.isArray(body.models)?Object.entries(body.models).filter(([,v])=>v&&typeof v==='object').map(([id,v])=>({...v,id:id||v.id})):null;
 if(!rows)throw Error('Unsupported model listing');
 return rows.filter(x=>typeof x?.id==='string'&&x.id).map(x=>({id:x.id,contextWindow:capacity(x.contextWindow,x.context_window,x.context_length,x.max_input_tokens,x.limit?.context),maxTokens:capacity(x.maxOutputTokens,x.max_output_tokens,x.maxTokens,x.max_tokens,x.limit?.output,x.top_provider?.max_completion_tokens)}));
}
export async function discover(config,{apiKey,fetchImpl=fetch}={}){
 endpointFingerprint(config.baseURL);
 if(!['openai-completions','openai-responses'].includes(config.api))throw Error('Use native discovery for this protocol');
 if(typeof apiKey!=='string'||!apiKey.trim())throw Error('Configured environment credential unavailable');
 let response;try{response=await fetchImpl(config.baseURL.replace(/\/+$/,'')+'/models',{headers:{Authorization:'Bearer '+apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw Error('Model discovery transport failed');}
 if(!response.ok)throw Error('Model discovery HTTP '+response.status);
 if(Number(response.headers.get('content-length'))>4194304){await response.body?.cancel();throw Error('Model listing too large');}
 const reader=response.body?.getReader();if(!reader)throw Error('Empty model listing');let size=0;const chunks=[];
 try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>4194304)throw Error('Model listing too large');chunks.push(x.value);}}finally{await reader.cancel().catch(()=>{});}
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('Invalid model listing JSON');}return parseListing(body);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2),o={};for(let i=0;i<args.length;i+=2){if(!['--profile','--home','--provider','--runtime-version'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||o[args[i]])throw Error('Invalid arguments');o[args[i]]=args[i+1];}
  if(Object.keys(o).length!==4)throw Error('Required --profile --home --provider --runtime-version');
  const profile=path.resolve(o['--profile']),rows=codec().load(fs.readFileSync(profile+'/cordis.patch.yml','utf8')),route=rows.find(r=>r.id==='llm-pi-ai')?.config?.providers?.[o['--provider']];
  if(!route||typeof route.apiKeyEnv!=='string')throw Error('Concrete environment-backed provider required');
  const envFile=path.join(path.resolve(o['--home']),'.env');if(fs.existsSync(envFile))process.loadEnvFile(envFile);
  const models=await discover(route,{apiKey:process.env[route.apiKeyEnv]});
  const answer=propose(rows,{provider:o['--provider'],models,profile:path.basename(profile),testedRuntime:o['--runtime-version'],observedAt:new Date().toISOString()});
  console.log(JSON.stringify({readOnly:true,policy:answer.policy,diff:answer.diff},null,2));
 }catch(error){console.log(JSON.stringify({readOnly:true,ok:false,error:error.message.startsWith('Model discovery HTTP ')?error.message:'Discovery/proposal refused; inspect provider and capacity metadata'}));process.exitCode=1;}
}
