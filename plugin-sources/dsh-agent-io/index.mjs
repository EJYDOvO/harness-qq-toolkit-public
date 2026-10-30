import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {createAgentIO} from './io.mjs';
import {createConversations} from './conversation.mjs';
export {createAgentIO,createConversations};
export const name='agent-io';
export const inject=[];
// Trusted Host service: no model tool, RPC or route. Platform plugins open one
// Conversation wiring per account (inbound handoff and outbound route through
// their Conversation Manager handle); Host-side callers (never the model)
// submit logical messages.
export function apply(ctx,config={}){
 const limits=Object.fromEntries(['maxPending','maxPendingPerConversation','maxConcurrent','maxTextLength','inboundWindowMs','rememberInbound'].filter(k=>Number.isInteger(config[k])&&config[k]>0).map(k=>[k,config[k]]));
 const io=createAgentIO({...limits,onEvent:e=>ctx.logger?.debug?.(`agent-io ${e.event} ${e.platform} ${e.status}${e.reason?' '+e.reason:''}${e.parts===undefined?'':' parts='+e.parts} ${e.elapsedMs}ms`)});
 // The optional Interaction policy of an Agent, from the native Preset services.
 const openConversation=createConversations(io,{createInput:createUserMessage,interactionPolicy:agent=>ctx.get('agentPresets')?.serviceFor?.(agent,'interactionPolicy')?.get(agent)});
 ctx.provide('agentIO',Object.freeze({sendMessage:io.sendMessage,registerAdapter:io.registerAdapter,openInbound:io.openInbound,openConversation}));
 ctx.effect(()=>()=>io.close());
}
