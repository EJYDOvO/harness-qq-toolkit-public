const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{randomUUID}=require('node:crypto');
const {connect}=require('./local-client.cjs'),{root}=require('./ops.cjs');
async function main(){
 const {rpc}=await connect();const {sessionId}=JSON.parse(fs.readFileSync(path.join(root,'data/maintenance/feature-live-session.json')));
 const server=http.createServer((_,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Harness Browser Integration</title><h1>BROWSER_HOST_OK</h1>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const url=`http://127.0.0.1:${server.address().port}/`;
  await rpc('session/prompt',{request:{sessionId,requestId:randomUUID(),mode:'queue',clientTimeZone:'Asia/Hong_Kong',content:[{type:'text',text:`执行工具验收：调用 mcp__browser__browser_navigate 打开 ${url}，确认标题 Harness Browser Integration，然后 browser_close。再用 memory_bind_task 绑定 harness-persistence-validation，memory_remember 保存键 restart-probe、值 MEMORY_PERSIST_OK。不要删除该键，稍后重启验收。禁止 shell 和其他外部请求，不需要派生 Agent。仅汇报实际工具结果。`} ]}});
  const deadline=Date.now()+120000;let page;
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,4000));const p=await rpc('session/projections',{request:{sessionId}});page=await rpc('session/page',{request:{address:{kind:'session',sessionId},throughSeq:p.asOfSeq,maxMessages:200}});if(JSON.stringify(page).includes('turn/end'))break;}
  fs.writeFileSync(path.join(root,'data/maintenance/feature-live-page.json'),JSON.stringify(page,null,2));
  const events=(page?.records||[]).filter(r=>r.event).map(r=>r.event),calls=new Map(events.filter(e=>e.type==='tool/call').map(e=>[e.data.callId,e.data.name]));
  const results=events.filter(e=>e.type==='tool/result').map(e=>({name:calls.get(e.data.message.toolCallId),...e.data.message}));
  const browserTitle=results.some(r=>r.name==='mcp__browser__browser_navigate'&&!r.isError&&JSON.stringify(r.content).includes('Harness Browser Integration'));
  const memoryWritten=results.some(r=>r.name==='memory_remember'&&!r.isError&&JSON.stringify(r.content).includes('Remembered'));
  const turnEnded=events.some(e=>e.type==='turn/end');console.log(JSON.stringify({sessionId,browserTitle,memoryWritten,turnEnded,evidence:'data/maintenance/feature-live-page.json'}));
  if(!turnEnded)await rpc('session/cancel',{request:{sessionId}});
  if(!browserTitle||!memoryWritten||!turnEnded)process.exitCode=1;
 }finally{server.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
