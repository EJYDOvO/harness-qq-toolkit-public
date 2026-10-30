import {createAgentIO} from './io.mjs';
export {createAgentIO};
export const name='agent-io';
export const inject=[];
// Trusted Host service: no model tool, RPC or route. Platform plugins register
// adapters; Host-side callers (never the model) submit logical messages.
export function apply(ctx,config={}){
 const limits=Object.fromEntries(['maxPending','maxPendingPerConversation','maxConcurrent','maxTextLength'].filter(k=>Number.isInteger(config[k])&&config[k]>0).map(k=>[k,config[k]]));
 const io=createAgentIO({...limits,onEvent:e=>ctx.logger?.debug?.(`agent-io ${e.platform} ${e.status}${e.reason?' '+e.reason:''} parts=${e.parts} ${e.elapsedMs}ms`)});
 ctx.provide('agentIO',Object.freeze({sendMessage:io.sendMessage,registerAdapter:io.registerAdapter}));
 ctx.effect(()=>()=>io.close());
}
