// Produce a reviewable model-only patch. No I/O or inferred capacity defaults.
const {createHash}=require('node:crypto');
function endpointFingerprint(baseURL){const u=new URL(baseURL);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Invalid endpoint');return createHash('sha256').update(u.href.replace(/\/+$/,'')).digest('hex');}
function propose(rows,{provider,models,profile,testedRuntime,observedAt,maxAgeDays=30,source='endpoint-discovery'}){
 if(!Array.isArray(rows)||!Array.isArray(models)||!models.length)throw Error('Concrete composition and capabilities required');
 if(!['endpoint-discovery','reviewed-manual'].includes(source))throw Error('Invalid evidence source');
 if(!Number.isFinite(Date.parse(observedAt)))throw Error('Evidence timestamp required');
 const next=structuredClone(rows),routes=next.filter(r=>r.id==='llm-pi-ai'&&r.disabled!==true);
 if(routes.length!==1)throw Error('One enabled pi-ai declaration required');
 const route=routes[0].config?.providers?.[provider];if(!route||!Array.isArray(route.models))throw Error('Declared provider/model list required');
 const byId=new Map();for(const m of models){if(!m||typeof m.id!=='string'||byId.has(m.id))throw Error('Invalid/duplicate discovered model');byId.set(m.id,m);}
 if(typeof profile!=='string'||!profile||typeof testedRuntime!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(testedRuntime)||!Number.isSafeInteger(maxAgeDays)||maxAgeDays<1||maxAgeDays>90)throw Error('Invalid capability policy metadata');
 const records=[],diff=[],declared=new Set();
 for(const model of route.models){if(!model||typeof model.id!=='string'||!model.id||declared.has(model.id))throw Error('Invalid/duplicate configured model');declared.add(model.id);const m=byId.get(model.id);if(!m||!Number.isSafeInteger(m.contextWindow)||m.contextWindow<=4096||!Number.isSafeInteger(m.maxTokens)||m.maxTokens<=0||m.maxTokens>m.contextWindow)throw Error('Missing valid capability for '+model.id);
  for(const field of ['contextWindow','maxTokens']){if(model[field]!==m[field])diff.push({provider,id:model.id,field,before:model[field]===undefined?null:typeof model[field]==='number'?model[field]:'[nonliteral]',after:m[field]});model[field]=m[field];}
  records.push({provider,id:model.id,contextWindow:m.contextWindow,maxTokens:m.maxTokens,endpointSha256:endpointFingerprint(route.baseURL),source,observedAt});
 }
 return {rows:next,policy:{schemaVersion:1,profile,testedRuntime,maxAgeDays,models:records},diff};
}
module.exports={propose,endpointFingerprint};
