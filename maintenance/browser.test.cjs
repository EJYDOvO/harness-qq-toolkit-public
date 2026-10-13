const test=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),http=require('node:http'),path=require('node:path'),fs=require('node:fs');
test('pinned browser MCP starts, reads a local page and closes',async(t)=>{
 const server=http.createServer((_,r)=>{r.writeHead(200,{'Content-Type':'text/html'});r.end('<title>Harness Browser Test</title><h1>BROWSER_MCP_OK</h1><input aria-label="Test input" />');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const child=spawn(process.execPath,[path.join(__dirname,'browser/0.0.83/node_modules/@playwright/mcp/cli.js'),'--config',path.join(__dirname,'browser/0.0.83/config.json')],{cwd:path.resolve(__dirname,'../default-workspace'),windowsHide:true,stdio:['pipe','pipe','pipe']});t.after(()=>{child.stdin.end();child.kill();});
 let id=0,buffer='',errors='';const pending=new Map();child.stderr.on('data',d=>errors+=d);
 child.stdout.on('data',d=>{buffer+=d;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line)continue;let v;try{v=JSON.parse(line)}catch{continue}if(v.id&&pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result);}}});
 const call=(method,params)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error(method+' timed out: '+errors.slice(-500)))},30000);pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
 const init=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'harness-validation',version:'1.0.0'}});assert(init.serverInfo);
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const list=await call('tools/list',{});assert(list.tools.some(x=>x.name==='browser_navigate'));
 const page=await call('tools/call',{name:'browser_navigate',arguments:{url:`http://127.0.0.1:${server.address().port}/`}});assert(!page.isError,JSON.stringify(page));assert.match(JSON.stringify(page),/Harness Browser Test/);
 const snapshot=await call('tools/call',{name:'browser_snapshot',arguments:{}});assert(!snapshot.isError,JSON.stringify(snapshot));
 const output=path.resolve(__dirname,'../default-workspace/browser-output');const snapshots=fs.readdirSync(output).filter(n=>n.endsWith('.yml')).sort();assert(snapshots.length);assert.match(fs.readFileSync(path.join(output,snapshots.at(-1)),'utf8'),/BROWSER_MCP_OK/);
 const closed=await call('tools/call',{name:'browser_close',arguments:{}});assert(!closed.isError);
 console.log(JSON.stringify({browserMcp:init.serverInfo,toolCount:list.tools.length,localPage:'passed'}));
});
