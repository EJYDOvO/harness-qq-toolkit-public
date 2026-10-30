// The reviewed QQ Conversation wiring: bootstrapGateway's own openConversation
// lines on the real Unified Agent I/O Conversation module, with a stand-in for
// the Host's native message constructor and Interaction lookup. Fake QQ, fake
// Agents: proves wiring, not QQ delivery.
import fs from 'node:fs';
import vm from 'node:vm';
import {createConversations} from '../plugin-sources/dsh-agent-io/conversation.mjs';

const dist=new URL('./qqbot-src/dist/',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,dist),'utf8').replaceAll('\r\n','\n');
const strip=source=>source.replace(/^import [^;]*;\n/gm,'').replace(/^export (?=(?:async )?function|class|const)/gm,'');
export const qqAdapter=vm.runInNewContext(strip(read('transport/qq-text-adapter.js'))+'\n;({QQ_OFFICIAL,QQ_SCOPES,accessAllows,classifyQQError,createQQTextAdapter})');
const bootstrap=read('gateway/bootstrap.js');
const start=bootstrap.indexOf('    const conversation = io.openConversation('),end=bootstrap.indexOf('    ctx.effect(() => conversation.close);',start);
if(start<0||end<start)throw Error('bootstrap Conversation wiring not found');
export const opening=bootstrap.slice(start,end);

let inputs=0;
export const nativeInput=m=>({id:'native-'+(++inputs),role:'user',...m});
// io: a real createAgentIO() core. policy(agent): the Interaction lookup.
export function qqConversation({io,manager,config,policy=()=>undefined,createInput=nativeInput}){
 const {QQ_OFFICIAL,QQ_SCOPES,accessAllows}=qqAdapter;
 return vm.runInNewContext('(function(){'+opening+';return conversation;})()',{io:{openConversation:createConversations(io,{createInput,interactionPolicy:policy})},manager,config,QQ_OFFICIAL,QQ_SCOPES,accessAllows});
}
