// The reviewed QQ Conversation wiring: bootstrapGateway's own openConversation
// lines on the real Unified Agent I/O Conversation module, with a stand-in for
// the Host's native message constructor and Interaction lookup. Fake QQ, fake
// Agents: proves wiring, not QQ delivery.
import fs from 'node:fs';
import vm from 'node:vm';
import {createConversations} from '../plugin-sources/dsh-agent-io/conversation.mjs';
export {createReplyIdCache} from './qqbot-src/dist/transport/msgid-cache.js';

const dist=new URL('./qqbot-src/dist/',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,dist),'utf8').replaceAll('\r\n','\n');
const strip=source=>source.replace(/^import [^;]*;\n/gm,'').replace(/^export (?=(?:async )?function|class|const)/gm,'');
export const qqAdapter=vm.runInNewContext(strip(read('transport/qq-text-adapter.js'))+'\n;({QQ_OFFICIAL,QQ_SCOPES,accessAllows,classifyQQError,createQQTextAdapter,actionKeyboard,hitlResponse})');
const bootstrap=read('gateway/bootstrap.js');
const start=bootstrap.indexOf('    const conversation = io.openConversation('),end=bootstrap.indexOf('    ctx.effect(() => conversation.close);',start);
if(start<0||end<start)throw Error('bootstrap Conversation wiring not found');
export const opening=bootstrap.slice(start,end);
// The gateway's own Turn cancellation registry (createTurnControls), as reviewed.
const turnStart=bootstrap.indexOf('export function createTurnControls'),turnEnd=bootstrap.indexOf('// Reusable transport wiring',turnStart);
if(turnStart<0||turnEnd<turnStart)throw Error('bootstrap createTurnControls not found');
export const createTurnControls=vm.runInNewContext(bootstrap.slice(turnStart,turnEnd).replace('export function','function')+';createTurnControls',{AbortController,AbortSignal});

let inputs=0;
export const nativeInput=m=>({id:'native-'+(++inputs),role:'user',...m});
// The gateway's own QQ side of the HITL Bridge (openQQHITL) with the reviewed renderers.
const hitlStart=bootstrap.indexOf('export function openQQHITL'),hitlEnd=bootstrap.indexOf('/**',hitlStart);
if(hitlStart<0||hitlEnd<hitlStart)throw Error('bootstrap openQQHITL not found');
export const openQQHITL=vm.runInNewContext(strip(read('features/approval-renderer.js'))+'\n'+strip(read('features/question-renderer.js'))+'\n'+bootstrap.slice(hitlStart,hitlEnd).replace('export function','function')+';openQQHITL');
// io: a real createAgentIO() core. policy(agent): the Interaction lookup.
// hitl: the Host's one HITL install (createHITLHost), when the test opens a Bridge.
export function qqConversation({io,manager,config,policy=()=>undefined,createInput=nativeInput,hitl}){
 const {QQ_OFFICIAL,QQ_SCOPES,accessAllows}=qqAdapter;
 return vm.runInNewContext('(function(){'+opening+';return conversation;})()',{io:{openConversation:createConversations(io,{createInput,interactionPolicy:policy,...(hitl?{hitl}:{})})},manager,config,QQ_OFFICIAL,QQ_SCOPES,accessAllows});
}
