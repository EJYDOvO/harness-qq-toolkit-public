import { QQBot, MediaFileType } from '@tencent-connect/qqbot-nodejs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import * as diagnosticFs from 'node:fs/promises';
import { resolve as diagnosticPath } from 'node:path';
import { homedir as diagnosticHome } from 'node:os';
import { SessionManager } from "../session/index.js";
import { handleInbound, createOutboundHandler, chunkMarkdownText } from "../transport/index.js";
import { QQ_OFFICIAL, QQ_SCOPES, accessAllows, createQQTextAdapter, hitlResponse } from "../transport/qq-text-adapter.js";
import { deliverInbound } from "../transport/inbound.js";
import { ReplyLimiter } from "../transport/reply-limiter.js";
import { createReplyIdCache } from "../transport/msgid-cache.js";
import { resolveReplyTarget, sendResolvedMarkdown } from "../transport/reply-target.js";
import { buildApprovalText } from "../features/approval-renderer.js";
import { formatQuestion } from "../features/question-renderer.js";
import { buildUserAgent } from "../shared/index.js";
import { setupMiddlewares } from "./middleware-setup.js";
import { startMediaCleanup } from "../media/media-cleaner.js";
import { ensureVisionInputModal, registerDescribeImageTool } from "../media/vision-tool.js";
import { registerSendFileTool, verifyLocalFile } from "../media/send-file-tool.js";
// Shared across duplicate module copies in the same Host process.
const gatewayLeases = globalThis[Symbol.for('dsh.qqGateway.leases.v1')] ??= new Map();
// The SDK logs dynamic peer keys and exception messages. Keep its protocol
// observations, but never forward arbitrary strings to Host logs.
export function privateSDKLogger(logger) {
    const write=(level,text)=>{try{logger?.[level]?.(text);}catch{}};
    return Object.freeze({debug(){},info(text){if(text==='[qqbot] gateway RESUMED')write('info','QQ transport resumed');},warn(){write('warn','QQ SDK warning');},error(){write('error','QQ SDK error; private details omitted');}});
}
// Opt-in bounded local diagnostics. HMAC keys live only in this Gateway instance;
// neither source text, raw identifiers, errors nor credentials enter this file.
export function createDeliveryRecorder(enabled, logger, directory, hub, context) {
    if(!enabled)return null;
    const home=process.env.DSH_HOME?.trim();
    const dir=directory??(home?diagnosticPath(home,'qqbot','diagnostics'):diagnosticPath(diagnosticHome(),'.dsh-qqbot','diagnostics'));
    const file=diagnosticPath(dir,'delivery.jsonl'),key=randomBytes(32),boot=randomUUID();
    let pending=[],timer,chain=Promise.resolve(),closed=false,warned=false,writing=false;
    const hash=value=>value===undefined?undefined:createHmac('sha256',key).update(String(value)).digest('hex').slice(0,24);
    function flush(){
        clearTimeout(timer);timer=undefined;if(writing)return chain.then(flush);if(!pending.length)return chain;
        const batch=pending;pending=[];
        writing=true;
        chain=chain.then(async()=>{
            await diagnosticFs.mkdir(dir,{recursive:true,mode:0o700});
            const size=await diagnosticFs.stat(file).then(s=>s.size,e=>{if(e.code==='ENOENT')return 0;throw e;});
            if(size>=1024*1024){await diagnosticFs.rm(file+'.1',{force:true});await diagnosticFs.rename(file,file+'.1');}
            await diagnosticFs.appendFile(file,batch.join(''),{mode:0o600});
        }).catch(()=>{if(!warned){warned=true;logger?.warn?.('QQ delivery diagnostics unavailable; messaging continues without file diagnostics');}}).finally(()=>{writing=false;});
        return chain;
    }
    const trace=(event,fields={})=>{
        if(closed||pending.length>=512||!/^[-a-z]+$/.test(event))return;
        const row={time:Date.now(),boot,event};
        for(const k of ['turn','reply','bubble','seq','length','index','msgSeq','state','retry','httpStatus','bizCode','elapsedMs'])if(Number.isFinite(fields[k]))row[k]=fields[k];
        for(const k of ['session','input','stream','receipt','association','textHash','attempt'])if(typeof fields[k]==='string'&&/^[a-f0-9]{24}$/.test(fields[k]))row[k]=fields[k];
        for(const k of ['passive','associated','missingReceipt','dynamic'])if(typeof fields[k]==='boolean')row[k]=fields[k];
        // Separates status receipts from natural-reply receipts; never text.
        if(['assistant','status','tool-or-error'].includes(fields.kind))row.kind=fields.kind;
        for(const [k,values] of [['decision',['revise','priority','supplement','append','dropped']],['phase',['text','tool','waiting-user']],['why',['judge','timeout','error','invalid','explicit','none','superseded']],['draft',['ready','late','failed','rejected','none']]])if(values.includes(fields[k]))row[k]=fields[k];
        if(typeof fields.source==='string')row.source=['subagent-settled','schedule','web'].includes(fields.source)?fields.source:'other';
        pending.push(JSON.stringify(row)+'\n');
        if(!timer){timer=setTimeout(flush,100);timer.unref?.();}
    };
    const account=hub?.scope(context).hash(context?.accountId);
    const unsubscribe=hub?.subscribe(row=>{
        if(!closed&&pending.length<512&&row.account===account&&row.platform===context?.platform&&row.adapter===context?.adapter){
            pending.push(JSON.stringify(row)+'\n');if(!timer){timer=setTimeout(flush,100);timer.unref?.();}
        }
    });
    return {hash,trace,flush,async close(){closed=true;unsubscribe?.();await flush();}};
}
/**
 * QQ side of the Agent I/O HITL Bridge: the QQ Markdown of approvals, questions
 * and the timeout notice. The Bridge (dsh-agent-io) correlates native Approval
 * and userQuestions requests with this account's current Sessions, issues their
 * buttons, sends every prompt through sendMessage() and accepts only the
 * expected person's answer; the QQ adapter renders the keyboard and turns button
 * events and text messages into its standard responses. Off with `hitl.enabled:
 * false`: requests then stay with the native Web/Desktop answerers.
 */
export function openQQHITL(conversation, config, logger) {
    if (config.hitl?.enabled === false) return undefined;
    return conversation.openHITL({
        // The person whose message the Session answers: the C2C peer, in a group the sender.
        responder: record => record.senderId || (record.scope === 'c2c' ? record.peerId : undefined),
        render: {
            approval: view => buildApprovalText(view, view.command),
            question: (question, { actions, conversation: c }) => formatQuestion(question, c?.type === 'group' && config.requireMention === true, actions),
            timeout: () => '⚠️ 提问已超时，未收到回答。',
        },
        questionTimeoutMs: config.askTimeoutMs,
        logger,
    });
}
/**
 * Cancellation controllers of native Turns, per Session. A controller leased by
 * a submission still in the Unified Agent I/O is never evicted, so /stop always
 * reaches queued output; idle ones are bounded per Session and overall (leased
 * ones are bounded by the I/O queue limits). A completed Turn's idle controller
 * is dropped at turn/end; an aborted one stays as a tombstone (within the
 * bounds) so late output of that Turn remains cancelled. Output without a Turn
 * shares one Session controller that /stop replaces after aborting it.
 */
export function createTurnControls({ maxTurns = 8, maxSessions = 256 } = {}) {
    const sessions = new Map();
    const ANY = '*';
    let closed = false;
    const held = session => [...session.values()].some(c => c.refs > 0);
    // `keep`: the controller just created, not yet leased by its caller; pruning
    // it would detach it from /stop, release and close.
    function prune(session, keep) {
        for (const [turn, c] of session) {
            if (session.size <= maxTurns) break;
            if (c.refs === 0 && c !== keep) session.delete(turn);
        }
        for (const [id, s] of sessions) {
            if (sessions.size <= maxSessions) break;
            if (s !== session && !held(s)) sessions.delete(id);
        }
    }
    function control(sessionId, turn) {
        if (typeof sessionId !== 'string' || !sessionId) return undefined;
        const key = Number.isSafeInteger(turn) ? turn : ANY;
        let session = sessions.get(sessionId);
        if (!session) { session = new Map(); sessions.set(sessionId, session); }
        let c = session.get(key);
        if (!c) { c = { controller: new AbortController(), refs: 0 }; session.set(key, c); prune(session, c); }
        return c;
    }
    function abortAll(session) { for (const c of session.values()) c.controller.abort(); }
    return {
        start(sessionId, turn) { if (!closed && Number.isSafeInteger(turn)) control(sessionId, turn); },
        end(sessionId, turn, aborted) {
            if (closed || !Number.isSafeInteger(turn)) return;
            if (aborted) { control(sessionId, turn)?.controller.abort(); return; }
            const session = sessions.get(sessionId), c = session?.get(turn);
            if (!c) return;
            c.ended = true;
            if (c.refs === 0 && !c.controller.signal.aborted) session.delete(turn);
            if (!session.size) sessions.delete(sessionId);
        },
        /** → {signal, release()}; the signal is aborted once the Gateway closed. */
        acquire(sessionId, turn) {
            if (closed) return { signal: AbortSignal.abort(), release() { } };
            const c = control(sessionId, turn);
            if (!c) return { signal: undefined, release() { } };
            c.refs++;
            let released = false;
            return {
                signal: c.controller.signal,
                release() {
                    if (released) return;
                    released = true; c.refs--;
                    const session = sessions.get(sessionId), key = Number.isSafeInteger(turn) ? turn : ANY;
                    if (session?.get(key) !== c) return;
                    // A completed Turn's last lease: nothing can cancel it any more.
                    if (c.refs === 0 && c.ended && !c.controller.signal.aborted) session.delete(key);
                    prune(session);
                    if (!session.size) sessions.delete(sessionId);
                },
            };
        },
        /** /stop: every leased and remembered controller of the Session. */
        cancel(sessionId) {
            const session = sessions.get(sessionId);
            if (!session) return;
            abortAll(session);
            session.delete(ANY);
        },
        /** Session release (rotation, removal, disposal): abort and forget. */
        release(sessionId) {
            const session = sessions.get(sessionId);
            if (!session) return;
            abortAll(session); sessions.delete(sessionId);
        },
        latest(sessionId) {
            let last;
            for (const key of sessions.get(sessionId)?.keys() ?? []) if (Number.isSafeInteger(key) && (last === undefined || key > last)) last = key;
            return last;
        },
        close() { closed = true; for (const session of sessions.values()) abortAll(session); sessions.clear(); },
        size() { let n = 0; for (const s of sessions.values()) n += s.size; return { sessions: sessions.size, controllers: n }; },
    };
}
// Reusable transport wiring, separately testable without creating a QQ gateway.
// Every QQ chat message (Interaction bubbles and hang-on lines, plain replies,
// tool results, turn errors) is one logical message for the Unified Agent I/O,
// which owns ordering, cancellation between parts, the route check before every
// part, duplicate suppression and an honest result. There is no direct
// sendMarkdown or SDK stream path for chat output here.
export function createInteractionOutbound(ctx, manager, sender, config, logger, toolsRegistry, diagnostics, io, conversation) {
    // The Agent's Interaction policy from the shared Conversation wiring (the
    // same lookup the inbound handoff uses); null means the lookup failed.
    const policyFor = record => { if (!record) return record; const policy = conversation.policy(record); if (policy === null) logger.warn?.('Interaction scope temporarily unavailable; withholding output'); return policy; };
    // Reply targets stay on the QQ side: Interaction only names the native input id.
    const rememberTarget=(record,message)=>{
        if(typeof message?.id!=='string'||!record.replyTarget)return;
        const targets=record.interactionTargets??=new Map();targets.delete(message.id);targets.set(message.id,{...record.replyTarget});
        while(targets.size>100)targets.delete(targets.keys().next().value);
    };
    // QQ side of an admitted Interaction input (the shared handoff calls the
    // policy itself): resume output and remember the input's reply target.
    manager.trackInteractionInput=(record,message)=>{record.interactionSuppressed=false;rememberTarget(record,message);};
    // Native Turn lifecycle per Session. Output not yet handed to the platform is
    // cancelled by /stop, by a Turn that ends aborted/interrupted (and stays
    // cancelled for late output of that Turn), by Session release and by Gateway
    // close, without Session rotation.
    const turns=createTurnControls();
    function observeTurn(sessionId,event){
        if(event?.type==='turn/start')turns.start(sessionId,event.data?.turn);
        else if(event?.type==='turn/end')turns.end(sessionId,event.data?.turn,['aborted','interrupted'].includes(event.data?.reason?.kind));
    }
    manager.cancelOutput=record=>turns.cancel(record?.sessionId);
    manager.releaseOutput=record=>turns.release(record?.sessionId);
    manager.latestTurn=record=>turns.latest(record?.sessionId);
    ctx.effect?.(()=>()=>turns.close());
    // Logical messages being handed over, by id: the QQ text adapter reads the
    // reply target of the input a bubble answers and its diagnostic fields.
    const deliveries=new Map();
    async function submit(record,text,{id,input,turn,signal,delivery}){
        if(!io){logger.error?.('im-qqbot: output withheld: Unified Agent I/O unavailable');return {id,status:'not-sent',reason:'adapter-unavailable',parts:[]};}
        // The lease keeps this Turn's controller (and so /stop) reachable until the
        // I/O has settled the message; capacity never evicts a held controller.
        const lease=turns.acquire(record.sessionId,turn);
        const signals=[lease.signal,signal].filter(s=>s instanceof AbortSignal);
        const own=typeof input==='string'?record.interactionTargets?.get(input):undefined;
        const mine=id!==undefined&&!deliveries.has(id);if(mine)deliveries.set(id,{target:own&&{...own},input:typeof input==='string'?input:undefined,delivery});
        conversation.diagnostics?.emit('interaction','queued',{sessionId:record.sessionId,conversation:conversation.target(record)?.conversation,inputId:input,logicalId:id,turn,reply:delivery?.reply,bubble:delivery?.bubble,kind:delivery?.kind,status:'pending'});
        try{return await io.sendMessage({...(id?{id}:{}),target:conversation.target(record),origin:{sessionId:record.sessionId,...(Number.isSafeInteger(turn)?{turn}:{})},message:typeof text==='string'?{text}:text,...(signals.length?{signal:signals.length>1?AbortSignal.any(signals):signals[0]}:{})});}
        finally{lease.release();if(mine)deliveries.delete(id);}
    }
    manager.submitOutput=submit;
    // Logical id of an Interaction message: the native Session and Turn, the
    // policy instance, its reply and bubble numbers and the kind. A repeated
    // submission of one bubble maps to the same id; two bubbles never do.
    const epochs=new WeakMap();
    function bubbleId(record,policy,meta){
        if(!['assistant','status'].includes(meta?.kind)||!Number.isSafeInteger(meta.reply)||!Number.isSafeInteger(meta.bubble))return undefined;
        let epoch=epochs.get(policy);if(!epoch){epoch=randomUUID().slice(0,8);epochs.set(policy,epoch);}
        return `qq:${record.sessionId}:${Number.isSafeInteger(meta.turn)?meta.turn:'-'}:${epoch}:${meta.reply}.${meta.bubble}:${meta.kind}`;
    }
    // Static text of the original outbound router (replies without an Interaction
    // policy, tool results, turn errors). With a policy it stays on the policy's
    // ordered external channel; otherwise it goes to the Unified Agent I/O directly.
    async function deliverText(record, text, tag, origin) {
        try {
            const policy = policyFor(record);
            if(policy===null)return;
            // Logical id from the trusted native event (Session id + durable seq +
            // kind): a repeated event or settlement maps to the same id, two
            // legitimate messages with equal text never do. No id is invented.
            const id=Number.isSafeInteger(origin?.seq)&&['assistant','tool','turn-error'].includes(origin.kind)?`qq:${record.sessionId}:${origin.seq}:${origin.kind}`:undefined;
            if(policy?.transport){await policy.external(text, { kind: 'tool-or-error', ...(id?{logicalId:id}:{}), ...(Number.isSafeInteger(origin?.turn)?{turn:origin.turn}:{}) });return;}
            const result=await submit(record,text,{id,turn:origin?.turn,delivery:{kind:origin?.kind==='assistant'?'assistant':'tool-or-error'}});
            if(result.duplicate)logger.debug?.(`im-qqbot: ${tag} duplicate suppressed`);
            else if(result.status!=='sent')logger.warn?.(`im-qqbot: ${tag} ${result.status}${result.reason?` (${result.reason})`:''}`);
        }
        catch { logger.error?.(`im-qqbot: ${tag} delivery failed`); }
    }
    const legacyOutbound = createOutboundHandler(manager, { deliverText }, config, logger, toolsRegistry);
    const outboundHandler = (session, event) => {
        observeTurn(session.header.id, event);
        const record = manager.findBySessionId(session.header.id);
        if(record&&['turn/start','turn/end'].includes(event.type))conversation.diagnostics?.emit('conversation','state',{sessionId:session.header.id,conversation:conversation.target(record)?.conversation,turn:event.data?.turn,status:event.type==='turn/start'?'running':'idle'});
        const policy = policyFor(record);
        if(policy===null)return;
        if (policy) {
            const scope={session:diagnostics?.hash(session.header.id)};
            const trace=(event,fields)=>{
                diagnostics?.trace(event,{...scope,...fields,...(fields.attempt===undefined?{}:{attempt:diagnostics?.hash(fields.attempt)})});
                conversation.diagnostics?.emit('interaction','state',{sessionId:session.header.id,conversation:conversation.target(record)?.conversation,...fields});
            };
            if(event.type==='user/message'){
                const message=event.data?.message??event.data,source=message?.source;
                // Native projections are context within the admitted turn, not
                // another input channel. They never clear existing suppression.
                // Other sources are background unless the policy recognizes them
                // (a Worker settling for an admitted reply).
                if(source?.kind&&!['user','runtime-context','skill-catalog','time-context','agent-instructions'].includes(source.kind)){
                    if(policy.admitsSource?.(message))record.interactionSuppressed=false;
                    else{record.interactionSuppressed=true;policy.stopOutput();trace('suppressed',{source:source.kind});}
                }
            }
            if(record.interactionSuppressed)return;
            if(['turn/start','turn/end','assistant/message'].includes(event.type))trace('host-event',{seq:event.seq,turn:event.data?.turn});
            // The policy commits complete bubbles; each is one logical message.
            // Only 'sent' resolves: anything else is reported with its delivery
            // state, and the policy never resends an unconfirmed bubble.
            policy.bind({ key: manager, requireIngress: true, trace, sendText: async (text,meta={}) => {
                    const kind=['assistant','status','tool-or-error'].includes(meta.kind)?meta.kind:'assistant';
                    if(meta.cancelled?.()===true)throw Object.assign(new Error('QQ output cancelled'),{delivery:'not-sent',reason:'cancelled'});
                    const result=await submit(record,text,{id:typeof meta.logicalId==='string'?meta.logicalId:bubbleId(record,policy,meta),input:meta.input,turn:meta.turn,signal:meta.signal,
                        delivery:{...scope,kind,...Object.fromEntries(['turn','reply','bubble'].filter(k=>Number.isSafeInteger(meta[k])).map(k=>[k,meta[k]]))}});
                    if(result.status==='sent')return result;
                    if(result.reason!=='cancelled')logger.warn?.(`im-qqbot: interaction ${kind} ${result.status}${result.reason?` (${result.reason})`:''}`);
                    throw Object.assign(new Error('QQ output '+result.status),{delivery:result.status,reason:result.reason});
                },
                waitingForUser: () => manager.hitl?.waiting(record) === true });
            policy.event(event);
            if (['assistant/chunk', 'assistant/message'].includes(event.type)) return;
        }
        return legacyOutbound(session, event);
    };
    outboundHandler.delivery=id=>typeof id==='string'?deliveries.get(id):undefined;
    return outboundHandler;
}
const MEDIA_TYPES = { image: 'IMAGE', video: 'VIDEO', voice: 'VOICE', file: 'FILE' };
/**
 * One trusted local attachment → QQ media message, in two stages so a failure
 * is classified honestly: the resource is re-checked first (still its own real
 * path, inside the allowed roots, a regular file), then uploaded without sending
 * (the SDK retries uploads; an upload alone is invisible to the user), then the
 * media message is sent. Passive-reply quota as for files before (no event_id).
 */
export async function sendMedia(bot, replyLimiter, config, target, attachment, replyIds) {
    let file;
    try { file = await verifyLocalFile(attachment?.resource?.path, config.sendFile, config.cwd || process.cwd(), { expectReal: true }); }
    catch (error) { throw Object.assign(new Error('QQ media resource refused'), { qqStage: 'resource', reason: error?.reason }); }
    const resolved = resolveReplyTarget(target, replyLimiter, false, replyIds);
    const fileType = MediaFileType[MEDIA_TYPES[attachment.kind]];
    if (typeof bot.uploadMedia !== 'function' || typeof bot.mediaApi?.sendMediaMessage !== 'function') {
        // An SDK without the two public stages: one combined call, classified as a message request.
        try { const r = await bot.sendMedia({ target: resolved, fileType, localPath: file.path, ...(attachment.kind === 'file' ? { fileName: attachment.name } : {}) }); return { id: r?.message?.id, uploaded: r?.upload?.file_uuid }; }
        catch (error) { throw Object.assign(new Error('QQ media message failed'), { qqStage: 'message', cause: error }); }
    }
    let upload;
    try { upload = await bot.uploadMedia({ target: resolved, fileType, localPath: file.path, srvSendMsg: false, ...(attachment.kind === 'file' ? { fileName: attachment.name } : {}) }); }
    catch (error) { throw Object.assign(new Error('QQ media upload failed'), { qqStage: 'upload', cause: error }); }
    try {
        const message = await bot.mediaApi.sendMediaMessage(resolved.scope, resolved.targetId, upload.file_info, bot.creds, { msgId: resolved.msgId });
        return { id: message?.id, uploaded: upload.file_uuid };
    }
    catch (error) { throw Object.assign(new Error('QQ media message failed'), { qqStage: 'message', cause: error }); }
}
export async function bootstrapGateway(ctx, agents, config, logger, options) {
    if (gatewayLeases.has(config.appId)) throw new Error('Duplicate QQ Gateway for this application');
    const lease = {};
    gatewayLeases.set(config.appId, lease);
    let shutdown;
    ctx.effect(() => async () => { await shutdown?.(); if (gatewayLeases.get(config.appId) === lease) gatewayLeases.delete(config.appId); });
    const io = ctx.get('agentIO');
    if (!io) throw new Error('Install and configure dsh-agent-io before QQ');
    if (typeof io.openConversation !== 'function') throw new Error('dsh-agent-io 0.1.0-test.4 or later (openConversation) is required before QQ');
    const manager = new SessionManager(ctx, agents, config, logger);
    ctx.effect(()=>()=>manager.disposeAll()); // also release the adapter if SDK setup fails
    // One Conversation wiring for this application: the same Conversation
    // reference, Manager route and current-Session check for the inbound handoff
    // and the outbound text adapter. The access configuration admits both ways.
    const conversation = io.openConversation({ platform: QQ_OFFICIAL, adapter: 'qq-official-gateway', accountId: config.appId, manager, scopes: QQ_SCOPES,
        admits: (scope, peer) => accessAllows(config.access, scope, peer),
        onInput: (record, message, policy, input) => { manager.admitInput?.(record, input); if (policy) manager.trackInteractionInput?.(record, message); } });
    ctx.effect(() => conversation.close);
    if (typeof conversation.openCommands !== 'function') throw new Error('dsh-agent-io 0.1.0-test.5 or later (commands and attachments) is required before QQ');
    if (typeof conversation.openHITL !== 'function') throw new Error('dsh-agent-io 0.1.0-test.6 or later (HITL Bridge) is required before QQ');
    if (typeof conversation.reply !== 'function') throw new Error('dsh-agent-io 0.1.0-test.8 or later (scoped input replies) is required before QQ');
    if (config.notifications?.enabled !== false && typeof conversation.openNotifications !== 'function') throw new Error('dsh-agent-io 0.1.0-test.7 or later (notifications) is required before QQ');
    const deliveryRecorder=createDeliveryRecorder(config.deliveryDiagnostics,logger,undefined,io.diagnostics,{platform:QQ_OFFICIAL,adapter:'qq-official-gateway',accountId:config.appId});
    ctx.effect(()=>()=>deliveryRecorder?.close());
    // ── 初始化 QQ Bot SDK ──
    const userAgent = buildUserAgent();
    const bot = new QQBot({
        appId: config.appId,
        appSecret: config.appSecret,
        transport: 'websocket',
        baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        userAgent,
        logger: privateSDKLogger(logger),
    });
    logger.info(`QQBot SDK initialized (UA: ${userAgent})`);
    // ── 中间件链 ──
    const replyIds = createReplyIdCache();
    ctx.effect(() => () => replyIds.clear());
    setupMiddlewares(bot, config, manager, logger, conversation, replyIds);
    // ── 入站：经过中间件链后的普通聊天消息 → Unified Agent I/O 入站通道（去重）→ 可信会话入口 → 共享交接 → dsh agent ──
    const inbound = conversation.openInbound(standard => deliverInbound(standard, conversation, config, logger));
    ctx.effect(() => inbound.close);
    bot.on('message', async (mCtx) => {
        const msg = mCtx.message;
        // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
        replyIds.cacheMsgId(mCtx.replyTarget.scope, mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
        if (config.debug) {
            logger.debug('Inbound QQ message accepted by middleware');
        }
        await handleInbound(mCtx, logger, inbound);
    });
    // ── 出站：dsh session/event → QQ 消息 ──
    // 获取 tools 服务（工具结果结构化展示），可选
    let toolsRegistry;
    try {
        toolsRegistry = ctx.get('tools');
    }
    catch {
        toolsRegistry = undefined;
    }
    // 发送适配器：将 QQBot 实例适配为 QQBotSender（只保留静态 Markdown；聊天输出不再使用 SDK 流式消息）。
    // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送。
    const replyLimiter = new ReplyLimiter({ limit: 4 });
    const diagnostics=typeof deliveryRecorder==='undefined'?null:deliveryRecorder;
    const sender = {
        sendMarkdown: async (target, content, opts) => {
            const resolved=resolveReplyTarget(target, replyLimiter, true, replyIds),meta=opts?.delivery??{},fields={...meta,input:diagnostics?.hash(resolved.msgId??resolved.eventId),length:content.length,textHash:diagnostics?.hash(content),passive:!!(resolved.msgId||resolved.eventId)};
            diagnostics?.trace('static-request',fields);
            try{const result=await sendResolvedMarkdown(bot,resolved,content,opts);diagnostics?.trace('static-receipt',{...fields,receipt:diagnostics?.hash(result?.id),missingReceipt:!result?.id});return result;}
            catch(error){diagnostics?.trace('static-failure',{...fields,httpStatus:error?.httpStatus,bizCode:error?.bizCode});throw error;}
        },
    };
    // Optional Agent policy. No Character, Remote Ops or policy package dependency.
    const outboundHandler = createInteractionOutbound(ctx, manager, sender, config, logger, toolsRegistry,deliveryRecorder, io, conversation);
    // Unified Agent I/O text adapter for this application, behind the shared
    // route check: the only QQ chat output path. It reuses the sender above for
    // reply targets, passive-reply quota and diagnostics; an Interaction bubble
    // answers the reply target of its own input.
    const releaseTextAdapter = conversation.registerAdapter(createQQTextAdapter({
        limit: config.textChunkLimit ?? 4500,
        split: text => chunkMarkdownText(text, config.textChunkLimit ?? 4500),
        replyTarget: (_record, messageId) => outboundHandler.delivery(messageId)?.target,
        send: (target, text, info) => sender.sendMarkdown(target, text, { delivery: { ...outboundHandler.delivery(info.messageId)?.delivery, session: diagnostics?.hash(info.sessionId), index: info.index }, ...(info.keyboard ? { keyboard: info.keyboard } : {}) }),
        sendMedia: (target, attachment) => sendMedia(bot, replyLimiter, config, target, attachment, replyIds),
    }));
    ctx.effect(() => releaseTextAdapter);
    ctx
        .on('session/event', outboundHandler);
    // ── HITL：原生审批与 ask_user_question 经 Agent I/O HITL Bridge（QQ 文本 + 按钮） ──
    // Closed with the Conversation wiring (Gateway unload); Session release cancels its requests.
    manager.hitl = openQQHITL(conversation, config, logger);
    ctx.provide('qqGateway', Object.freeze({ bot, manager, sender }));
    // ── 主动通知：稳定目标经 Agent I/O 发送（不要求当前 Session，由通知方逐片授权） ──
    // Handed only to the notification authorities attached below (Remote Ops, and
    // Character Identity through its Remote Ops wrapper); off with notifications.enabled: false.
    const notifications = config.notifications?.enabled === false ? undefined : conversation.openNotifications();
    if (notifications) ctx.effect(() => () => notifications.close());
    // Remote Ops is an optional extension. Core messaging and approval own no ops dependency.
    const runtime = { platform: QQ_OFFICIAL, adapter: 'qq-official-gateway', accountId: config.appId, diagnostics: conversation.diagnostics, bot, manager, sender, config, ...(notifications ? { notifications } : {}) };
    // Optional Host lifecycle hook; ordinary QQ has no Character/Remote Ops prerequisite.
    const integration = options?.qqGatewayLifecycle;
    if (integration && (integration.contractVersion !== 1 || typeof integration.attach !== 'function')) throw Error('Unsupported QQ Gateway lifecycle contract');
    const attached = integration?.attach(runtime);
    if (attached?.close) ctx.effect(() => attached.close);
    const releaseRemoteOps = ctx.get('qqRemoteOps')?.attach({ ...runtime, ...(attached?.notifyEvent ? { notifyEvent: attached.notifyEvent } : {}) });
    if (typeof releaseRemoteOps === 'function') ctx.effect(() => releaseRemoteOps);
    // ── 按钮点击回调（interaction）：HITL 按钮交给 Bridge 校验与结算 ──
    bot.on('interaction', async (_iCtx, event) => {
        // scope/targetId 推导对齐消息事件（inbound.ts）：按 scene 判定类型，群用 group_openid，私聊用 user_openid
        const scope = event.scene === 'group' ? 'group' : 'c2c';
        const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
        // 记录互动事件 id，作为后续被动回复候选（event_id）
        replyIds.cacheEventId(scope, targetId, event.id);
        const response = hitlResponse(event);
        const matched = !!response && manager.hitl?.respond(response).status === 'accepted';
        await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => { });
    });
    bot.on('error', (err) => {
        logger.error('QQ SDK error; private exception details omitted');
    });
    // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
    // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
    // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
    try {
        bot.on('disconnected', (event) => {
            const detail = `code=${Number.isFinite(event.code) ? event.code : 'unknown'}`;
            if (event.willReconnect) {
                logger.warn(`Bot disconnected (${detail}), reconnecting...`);
            }
            else {
                logger.error(`Bot disconnected permanently (${detail}), giving up`);
            }
        });
    }
    catch (err) {
        logger.warn('qqbot-nodejs SDK disconnected events unavailable; version 1.0.5+ is required');
    }
    bot.on('ready', () => {
        logger.info('Bot ready');
    });
    // ── 富媒体过期清理 ──
    if (config.media.enabled) {
        startMediaCleanup(ctx, config.media.ttlHours, logger);
    }
    // ── 视觉工具注册（qqbot_describe_image，复用 dsh llm + attachments） ──
    ensureVisionInputModal(config.vision, logger);
    registerDescribeImageTool(ctx, config.vision, logger);
    // ── 附件发送工具注册（qqbot_send_file） ──
    // 文件作为附件消息交给 Unified Agent I/O，经上面的 QQ Adapter（sendMedia）上传发送；
    // 不再有直接调用 bot.sendImage/sendFile 的路径。
    registerSendFileTool(ctx, null, manager, config, logger);
    // ── 生命周期 ──
    ctx
        .effect(() => {
        logger.info('Starting QQ bot');
        bot.start().catch((err) => {
            logger.error('QQ Bot start failed; private exception details omitted');
        });
        let stopping;
        shutdown = () => stopping ??= (async () => {
            logger.info('Shutting down');
            try { await manager.disposeAll(); } finally { bot.stop(); }
        })();
        return shutdown;
    }, 'im-qqbot.lifecycle');
}
//# sourceMappingURL=bootstrap.js.map
