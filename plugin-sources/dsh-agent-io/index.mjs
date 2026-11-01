import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {createAgentIO} from './io.mjs';
import {createConversations} from './conversation.mjs';
import {createCommandRouter} from './commands.mjs';
import {createHITLBridge,createHITLHost,parseAnswer} from './hitl.mjs';
export {createAgentIO,createConversations,createCommandRouter,createHITLBridge,createHITLHost,parseAnswer};
export {createDiagnostics} from './diagnostics.mjs';
export const name='agent-io';
export const inject=[];
// Trusted Host service: no model tool, RPC or route. Platform plugins open one
// Conversation wiring per account (inbound handoff and outbound route through
// their Conversation Manager handle); Host-side callers (never the model)
// submit logical messages.
export function apply(ctx,config={}){
 const limits=Object.fromEntries(['maxPending','maxPendingPerConversation','maxConcurrent','maxTextLength','inboundWindowMs','rememberInbound'].filter(k=>Number.isInteger(config[k])&&config[k]>0).map(k=>[k,config[k]]));
 const io=createAgentIO({...limits,diagnostics:{enabled:config.diagnostics===true,capacity:config.diagnosticCapacity,onEvent:e=>ctx.logger?.debug?.('agent-io '+JSON.stringify(e))}});
 // The optional Interaction policy of an Agent, from the native Preset services.
 const openConversation=createConversations(io,{createInput:createUserMessage,interactionPolicy:agent=>ctx.get('agentPresets')?.serviceFor?.(agent,'interactionPolicy')?.get(agent),hitl:createHITLHost(ctx)});
 ctx.provide('agentIO',Object.freeze({sendMessage:io.sendMessage,registerAdapter:io.registerAdapter,openInbound:io.openInbound,openConversation,diagnostics:io.diagnostics}));
 ctx.effect(()=>()=>io.close());
}
