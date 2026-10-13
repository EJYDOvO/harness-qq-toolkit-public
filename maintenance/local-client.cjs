const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { root } = require('./ops.cjs');
async function connect(logPattern=/^desktop-.*\.stdout\.log$/) {
  const logs=fs.readdirSync(path.join(root,'tmp')).filter(n=>logPattern.test(n))
    .map(n=>path.join(root,'tmp',n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).slice(0,10);
  for(const log of logs) {
    const matches=[...fs.readFileSync(log,'utf8').matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/g)];
    for(const match of matches.reverse()) {
      const url=new URL(match[1]);
      try {
        const entry=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(2500)});
        const cookie=entry.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
        const rpc=async(method,args={})=>{
          const response=await fetch(new URL('/api/'+method,url),{method:'POST',
            headers:{'Content-Type':'application/json',Cookie:cookie,Origin:url.origin},
            body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}}),signal:AbortSignal.timeout(20000)});
          const envelope=await response.json();
          if(!envelope.result?.ok) throw Error(JSON.stringify(envelope.result?.error || {http:response.status}));
          return envelope.result.value;
        };
        await rpc('agentPresets/list');
        return {rpc};
      }catch{}
    }
  }
  throw Error('Cannot connect to authenticated local Harness API');
}
module.exports={connect};
