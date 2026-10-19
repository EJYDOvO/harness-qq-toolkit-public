import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { SessionManager } from "../session/index.js";
import { handleInbound, createOutboundHandler } from "../transport/index.js";
import { ReplyLimiter } from "../transport/reply-limiter.js";
import { cacheMsgId, cacheEventId } from "../transport/msgid-cache.js";
import { resolveReplyTarget, sendResolvedMarkdown } from "../transport/reply-target.js";
import { QuestionChannel } from "../features/question-channel.js";
import { ApprovalChannel } from "../features/approval-channel.js";
import { decodeButtonData } from "../features/button-utils.js";
import { buildUserAgent } from "../shared/index.js";
import { setupMiddlewares } from "./middleware-setup.js";
import { startMediaCleanup } from "../media/media-cleaner.js";
import { ensureVisionInputModal, registerDescribeImageTool } from "../media/vision-tool.js";
import { registerSendFileTool } from "../media/send-file-tool.js";
// Shared across duplicate module copies in the same Host process.
const gatewayLeases = globalThis[Symbol.for('dsh.qqGateway.leases.v1')] ??= new Map();
/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval）。QQ 只有一个 interaction 入口，集中路由
 * 避免多通道各自 try 导致误判。
 */
function dispatchInteraction(event, manager) {
    const raw = event.data?.resolved?.button_data;
    if (!raw)
        return false;
    const button = decodeButtonData(raw);
    if (!button)
        return false;
    if (button.t === 'question')
        return manager.questionChannel?.handleInteraction(event) ?? false;
    if (button.t === 'approval')
        return manager.approvalChannel?.handleInteraction(event) ?? false;
    return false;
}
// Reusable transport wiring, separately testable without creating a QQ gateway.
export function createInteractionOutbound(ctx, manager, sender, config, logger, toolsRegistry) {
    const policyFor = record => { try { return record && ctx.get('agentPresets')?.serviceFor?.(record.agent, 'interactionPolicy')?.get(record.agent); } catch { logger.warn?.('Interaction scope temporarily unavailable; withholding output');return null; } };
    manager.registerInteractionInput=(record,message)=>{
        const policy=policyFor(record);
        if(policy){record.interactionSuppressed=false;policy.admitInput?.(message);}
    };
    const limit = Math.max(100, Math.min(4500, config.textChunkLimit ?? 4500));
    function pieces(text) {
        const parts=[];
        while(text.length){let end=Math.min(limit,text.length);if(end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1]))end--;parts.push(text.slice(0,end));text=text.slice(end);}
        return parts;
    }
    function boundedStream(target) {
        let stream, latest='', cancelled=false;
        return {
            async update(text) {
                if(cancelled)return;
                latest=text;
                const first=pieces(text)[0];if(first===undefined)return;
                stream??=sender.openStream(target);
                await stream.update(first);
            },
            async complete(){
                // Overflow remains buffered until durable assistant settlement.
                const parts=pieces(latest);
                for(let i=0;i<parts.length;i++){
                    if(cancelled)return;
                    if(i>0){stream=sender.openStream(target);await stream.update(parts[i]);}
                    if(cancelled)return;
                    await stream?.complete();
                }
            },
            cancel(){cancelled=true;stream?.cancel?.();}
        };
    }
    const presentationSender = { ...sender, sendMarkdown(target, text, opts) {
        const record = manager.getSessionRecord(target.scope, target.targetId);
        const policy = policyFor(record);
        if(policy===null)return Promise.resolve();
        return policy?.transport ? policy.external(text, { kind: 'tool-or-error' }) : sender.sendMarkdown(target, text, opts);
    } };
    const legacyOutbound = createOutboundHandler(manager, presentationSender, config, logger, toolsRegistry);
    const outboundHandler = (session, event) => {
        const record = manager.findBySessionId(session.header.id);
        const policy = policyFor(record);
        if(policy===null)return;
        if (policy) {
            if(event.type==='user/message'){
                const source=event.data?.message?.source??event.data?.source;
                if(source?.kind&&!['user','runtime-context','skill-catalog'].includes(source.kind)){record.interactionSuppressed=true;policy.stopOutput();}
            }
            if(record.interactionSuppressed)return;
            const target = { ...record.replyTarget };
            policy.bind({ key: manager, requireIngress: true, sendText: async (text,meta) => {for(const part of pieces(text)){if(meta?.cancelled?.())return;await sender.sendMarkdown(target, part);}},
                waitingForUser: () => manager.approvalChannel?.pending.has(record.sessionKey) || manager.questionChannel?.pending.has(record.sessionKey),
                ...(config.streaming && target.scope === 'c2c' && target.msgId ? { openStream: () => boundedStream(target) } : {}) });
            policy.event(event);
            if (['assistant/chunk', 'assistant/message'].includes(event.type)) return;
        }
        return legacyOutbound(session, event);
    };
    return outboundHandler;
}
export async function bootstrapGateway(ctx, agents, config, logger) {
    if (gatewayLeases.has(config.appId)) throw new Error('Duplicate QQ Gateway for this application');
    const lease = {};
    gatewayLeases.set(config.appId, lease);
    let shutdown;
    ctx.effect(() => async () => { await shutdown?.(); if (gatewayLeases.get(config.appId) === lease) gatewayLeases.delete(config.appId); });
    const manager = new SessionManager(ctx, agents, config, logger);
    // ── 初始化 QQ Bot SDK ──
    const userAgent = buildUserAgent();
    const bot = new QQBot({
        appId: config.appId,
        appSecret: config.appSecret,
        transport: 'websocket',
        baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        userAgent,
        logger,
    });
    logger.info(`QQBot SDK initialized (UA: ${userAgent})`);
    // ── 中间件链 ──
    setupMiddlewares(bot, config, manager, logger);
    // ── 入站：经过中间件链后的消息交给 dsh agent ──
    bot.on('message', async (mCtx) => {
        const msg = mCtx.message;
        // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
        cacheMsgId(mCtx.replyTarget.scope, mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
        if (config.debug) {
            logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
        }
        await handleInbound(mCtx, manager, config, logger);
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
    // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）。
    // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送。
    const replyLimiter = new ReplyLimiter({ limit: 4 });
    const sender = {
        sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),
        openStream: (target) => {
            const resolved=resolveReplyTarget(target, replyLimiter, false);
            if(!resolved.msgId){
                let text='',cancelled=false;
                return {async update(value){text=value;},async complete(){if(!cancelled)await sendResolvedMarkdown(bot,resolved,text);},cancel(){cancelled=true;}};
            }
            return bot.openStream({
            target: {
                scope: target.scope,
                targetId: target.targetId,
                msgId: resolved.msgId,
            },
        });},
    };
    // Optional Agent policy. No Character, Remote Ops or policy package dependency.
    const outboundHandler = createInteractionOutbound(ctx, manager, sender, config, logger, toolsRegistry);
    ctx
        .on('session/event', outboundHandler);
    // ── 问答通道（ask_user_question → QQ 文本 + 按钮） ──
    const questionChannel = new QuestionChannel(manager, sender, config, logger);
    manager.questionChannel = questionChannel;
    questionChannel.install(ctx);
    // ── 审批通道（approval/request → QQ 两按钮审批） ──
    const approvalChannel = new ApprovalChannel(manager, sender, logger);
    manager.approvalChannel = approvalChannel;
    approvalChannel.install(ctx);
    ctx.provide('qqGateway', Object.freeze({ bot, manager, sender }));
    // Remote Ops is an optional extension. Core messaging and approval own no ops dependency.
    const releaseRemoteOps = ctx.get('qqRemoteOps')?.attach({ bot, manager, sender, config });
    if (typeof releaseRemoteOps === 'function') ctx.effect(() => releaseRemoteOps);
    // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
    bot.on('interaction', async (_iCtx, event) => {
        // scope/targetId 推导对齐消息事件（inbound.ts）：按 scene 判定类型，群用 group_openid，私聊用 user_openid
        const scope = event.scene === 'group' ? 'group' : 'c2c';
        const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
        // 记录互动事件 id，作为后续被动回复候选（event_id）
        cacheEventId(scope, targetId, event.id);
        const matched = dispatchInteraction(event, manager);
        await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => { });
    });
    bot.on('error', (err) => {
        logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
    });
    // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
    // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
    // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
    try {
        bot.on('disconnected', (event) => {
            const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
            if (event.willReconnect) {
                logger.warn(`Bot disconnected (${detail}), reconnecting...`);
            }
            else {
                logger.error(`Bot disconnected permanently (${detail}), giving up`);
            }
        });
    }
    catch (err) {
        logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
    }
    bot.on('ready', () => {
        console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
    });
    // ── 富媒体过期清理 ──
    if (config.media.enabled) {
        startMediaCleanup(ctx, config.media.ttlHours, logger);
    }
    // ── 视觉工具注册（qqbot_describe_image，复用 dsh llm + attachments） ──
    ensureVisionInputModal(config.vision, logger);
    registerDescribeImageTool(ctx, config.vision, logger);
    // ── 附件发送工具注册（qqbot_send_file） ──
    // 包装 bot：让文件发送也走 msgId 兜底 + 被动回复限额管控。
    // 注意：SDK 文件发送暂不支持 event_id，故 allowEvent=false，跳过 event 候选。
    const mediaSender = {
        sendImage: (target, source) => bot.sendImage(resolveReplyTarget(target, replyLimiter, false), source),
        sendVideo: (target, source) => bot.sendVideo(resolveReplyTarget(target, replyLimiter, false), source),
        sendVoice: (target, source) => bot.sendVoice(resolveReplyTarget(target, replyLimiter, false), source),
        sendFile: (target, source, opts) => bot.sendFile(resolveReplyTarget(target, replyLimiter, false), source, opts),
    };
    registerSendFileTool(ctx, mediaSender, manager, config, logger);
    // ── 生命周期 ──
    ctx
        .effect(() => {
        logger.info(`Starting bot (appId=${config.appId})`);
        bot.start().catch((err) => {
            logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
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
