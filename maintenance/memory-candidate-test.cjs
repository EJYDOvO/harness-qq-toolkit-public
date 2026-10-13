const fs=require('node:fs'),{randomUUID}=require('node:crypto'),{connect}=require('./local-client.cjs');
async function main(){
 const {rpc}=await connect(/^feature-validation\.stdout\.log$/);
 const {sessionId}=await rpc('session/create',{request:{cwd:'D:/DeepSeek-Harness/default-workspace',agentPreset:'cordis'}});
 fs.writeFileSync('data/maintenance/memory-candidate-session.json',JSON.stringify({sessionId}));
 const fact='项目核验口令='+randomUUID();
 await rpc('session/prompt',{request:{sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:`请顺序执行工具验收：memory_bind_task 绑定 harness-render-validation，memory_remember 保存 probe，内容为 ${fact}；然后 memory_recall 读取 probe、memory_search 搜索“项目核验口令”，最后 memory_forget 删除 probe。每步等待上一步结果，禁用 shell，不做其他任务。`}],clientTimeZone:'Asia/Hong_Kong'}});
 let records=[];const end=Date.now()+120000;
 while(Date.now()<end){await new Promise(r=>setTimeout(r,4000));const p=await rpc('session/projections',{request:{sessionId}});const page=await rpc('session/page',{request:{address:{kind:'session',sessionId},throughSeq:p.asOfSeq,maxMessages:200}});records=page.records.filter(r=>r.event).map(r=>r.event);if(records.some(e=>e.type==='turn/end'))break;}
 const calls=new Map(records.filter(e=>e.type==='tool/call').map(e=>[e.data.callId,e.data.name]));
 const results=records.filter(e=>e.type==='tool/result').map(e=>({tool:calls.get(e.data.message.toolCallId),error:e.data.message.isError,text:JSON.stringify(e.data.message.content)}));
 const ok=['memory_recall','memory_search'].every(name=>results.some(r=>r.tool===name&&!r.error&&r.text.includes(fact)))&&results.some(r=>r.tool==='memory_forget'&&!r.error);
 fs.writeFileSync('data/maintenance/memory-render-evidence.json',JSON.stringify({sessionId,ok,results},null,2));console.log(JSON.stringify({sessionId,ok,results}));
 if(!records.some(e=>e.type==='turn/end'))await rpc('session/cancel',{request:{sessionId}});
 await rpc('workspace/archiveSession',{request:{sessionId}});
 if(!ok)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
