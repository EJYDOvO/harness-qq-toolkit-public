import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { classifyContentType, isVoiceContentType, } from "./attachment.js";
import { clearGroupHistory } from "../features/history-store.js";
import { accessAllows } from "./qq-text-adapter.js";
// ── 主处理函数 ──
/**
 * QQ Official Adapter 侧标准化：已过 SDK 中间件链（访问控制、@ 门控、命令、
 * 问答截获、合并、引用、附件）的普通聊天消息 → Unified Agent I/O 标准入站消息。
 * 平台、Adapter 与账号由入站通道固定，不取自消息；platformData 只交回本
 * Adapter 的会话入口，不会自动成为模型可见内容。
 */
export function normalizeQQMessage(ctx) {
    const msg = ctx.message;
    const group = msg.kind === 'group';
    return {
        conversation: { type: group ? 'group' : 'direct', id: group ? (msg.groupOpenid ?? msg.senderId) : msg.senderId },
        message: { ...(typeof msg.messageId === 'string' && msg.messageId ? { id: msg.messageId } : {}), text: msg.content ?? '' },
        sender: { id: msg.senderId, ...(typeof msg.senderName === 'string' && msg.senderName ? { displayName: msg.senderName } : {}) },
        ...(msg.timestamp === undefined ? {} : { timestamp: msg.timestamp }),
        platformData: { context: ctx },
    };
}
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）：标准化后交给 Unified Agent I/O 的
 * 入站通道，由它去重并交给 deliverInbound。不再直接创建 Agent 输入。
 */
export async function handleInbound(ctx, manager, config, logger, channel) {
    if (!channel) {
        logger.error('im-qqbot: inbound withheld: Unified Agent I/O unavailable');
        return;
    }
    const standard = normalizeQQMessage(ctx), hold = {};
    standard.platformData.hold = hold;
    const result = await channel.receive(standard);
    if (result.status === 'duplicate') {
        logger.debug?.('im-qqbot: duplicate inbound message suppressed');
        return;
    }
    if (result.status !== 'accepted') {
        logger.warn?.(`im-qqbot: inbound ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
        return;
    }
    // 阻塞等待本轮 turn 收敛，避免后续消息在 turn 运行期间被 followup 打断
    if (hold.idle) {
        try {
            await hold.idle;
        }
        catch (err) {
            logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
/**
 * QQ 的可信会话入口（Unified Agent I/O 入站通道的 deliver）：Host 准入复核 →
 * Conversation Manager（含 Character Identity 等包装）→ 原生 UserMessage 与
 * followup，或运行中按可选 Interaction 策略 intervene。返回交接结果：
 * accepted＝已创建 Agent 输入；rejected＝准入拒绝；not-delivered＝未创建输入。
 */
export async function deliverInbound(standard, manager, config, logger) {
    const ctx = standard.platformData?.context, hold = standard.platformData?.hold ?? {};
    const msg = ctx.message;
    const mwState = ctx.state;
    const { bot } = ctx;
    const scope = standard.conversation.type === 'group' ? 'group' : 'c2c';
    const peerId = standard.conversation.id;
    // Defence in depth after the SDK accessPolicy: the same configuration admits
    // the Conversation; the generic group contract never opens a disabled scope.
    if (!accessAllows(config.access, scope, peerId) || (scope === 'c2c' && standard.sender.id !== peerId))
        return { status: 'rejected', reason: 'unauthorized' };
    const replyTarget = {
        scope,
        targetId: peerId,
        msgId: standard.message.id,
    };
    // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
    const agentBody = assembleAgentBody(msg, mwState, scope, logger);
    if (!agentBody)
        return { status: 'rejected', reason: 'empty-message' };
    logger.info(`Processing: scope=${scope} length=${agentBody.length}`);
    // ── 获取或创建会话 ──
    let record;
    try {
        record = await manager.getOrCreate(scope, peerId, standard.sender.id, replyTarget);
    }
    catch (err) {
        logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
        // 兜底回复：会话创建失败时告知用户，避免静默无响应
        try {
            await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
        }
        catch (sendErr) {
            logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
        }
        return { status: 'not-delivered', reason: 'session-unavailable' };
    }
    // getOrCreate re-checks after each of its awaits, but disposal or rotation can
    // still land before this continuation runs: never hand input to a Session
    // that is no longer current (no input created, a re-delivery may proceed).
    if (manager.isCurrentSession?.(record) !== true)
        return { status: 'not-delivered', reason: 'session-changed' };
    // ── 构建 UserMessage → followup ──
    const content = [{ type: 'text', text: agentBody }];
    const message = createUserMessage({
        content,
        source: { kind: 'user' },
    });
    manager.registerInteractionInput?.(record,message);
    // With Interaction, input that arrives mid-run reaches the Agent now: the
    // policy chooses native steer/followup/cancel, and its single send queue
    // keeps QQ output serial, so the concurrency guard need not wait for idle.
    const policy=manager.interactionPolicy?.(record),interactive=typeof policy?.intervene==='function';
    if(interactive&&record.agent.status==='running'){
        policy.intervene(message);
        logger.info(`→ interaction input: scope=${scope}`);
    }else{
        record.agent.followup(message);
        logger.info(`→ followup sent: scope=${scope}`);
    }
    // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
    if (scope === 'group') {
        clearGroupHistory(config.appId, peerId);
    }
    if(interactive){
        record.typingTarget={...replyTarget};
        // The typing middleware stops refreshing when this chain returns; keep one
        // refresh per Session alive until the Agent is idle again.
        if(scope==='c2c'&&!record.typingKeepAlive&&typeof bot?.sendTyping==='function'){
            const timer=setInterval(()=>{bot.sendTyping(record.typingTarget??replyTarget,60).catch(()=>{});},50_000);
            timer.unref?.();
            record.typingKeepAlive=timer;
            record.agent.whenIdle().catch(()=>{}).finally(()=>{clearInterval(timer);if(record.typingKeepAlive===timer)record.typingKeepAlive=undefined;});
        }
        return { status: 'accepted' };
    }
    // handleInbound waits for this after the handoff (SDK concurrency guard held).
    hold.idle = record.agent.whenIdle();
    return { status: 'accepted' };
}
// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装）
// ══════════════════════════════════════════════════════════════
/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(msg, state, scope, logger) {
    const isGroup = scope === 'group';
    const wasMentioned = state.mention?.wasMentioned ?? false;
    const userContent = buildUserContent(msg, state, logger);
    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned))
        return null;
    const quotePart = buildQuotePart(state.quote);
    const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned);
    const dynamicCtx = buildDynamicCtx(msg, state);
    const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
    const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned);
    return agentBody;
}
/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function isEmptyMessage(userContent, attachments, isGroup, wasMentioned) {
    if (userContent)
        return false;
    if (attachments && attachments.length > 0)
        return false;
    if (isGroup && wasMentioned)
        return false;
    return true;
}
/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg, state, logger) {
    const parts = [];
    const text = (msg.content ?? '').trim();
    if (text) {
        parts.push(text);
    }
    const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
    if (voiceTexts.length > 0) {
        for (const vt of voiceTexts) {
            const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
            parts.push(`[Voice message${durationTag}] ${vt.text}`);
        }
    }
    // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
    const attachmentTags = buildAttachmentTags(msg.attachments);
    if (attachmentTags) {
        parts.push(attachmentTags);
    }
    return parts.join('\n');
}
/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote) {
    if (!quote?.text && !quote?.entry?.content)
        return '';
    const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';
    return `[Quoted message begins]\n${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}
/**
 * Layer 3: 带发送者标签的用户消息
 */
function buildUserMessage(userContent, quotePart, senderId, senderName, isGroup, wasMentioned) {
    if (!isGroup) {
        return `${quotePart}${userContent}`;
    }
    const mentionTag = wasMentioned ? ' (@you)' : '';
    const displayName = senderName ?? shortSenderId(senderId);
    const senderTag = `[${displayName} (${senderId})]`;
    return `${quotePart}${senderTag} ${userContent}${mentionTag}`;
}
/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg, state) {
    const lines = [];
    if (msg.attachments && msg.attachments.length > 0) {
        const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
        const voices = [];
        // 一次遍历归类 + 生成媒体行
        for (const att of msg.attachments) {
            const kind = classifyContentType(att.content_type);
            if (kind === 'voice') {
                voices.push(att);
                continue;
            }
            const d = downloadedByFilename.get(att.filename);
            lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
        }
        // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
        if (voices.length > 0) {
            const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
            if (asrTexts.length > 0) {
                lines.push(`- ASR: ${asrTexts.join(' | ')}`);
            }
            else {
                const urls = voices.map(a => a.url).filter(Boolean);
                if (urls.length > 0)
                    lines.push(`- Voice: ${urls.join(', ')}`);
            }
        }
    }
    // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
    const quoteAttachments = state.quote?.attachments;
    if (quoteAttachments && quoteAttachments.length > 0) {
        const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
        lines.push('[Reference attachments]');
        for (const qa of quoteAttachments) {
            const kind = classifyContentType(qa.contentType);
            const d = downloadedQuote.get(qa.filename ?? '');
            if (kind === 'voice') {
                if (qa.asrText)
                    lines.push(`  - Voice: ${qa.asrText}`);
                continue;
            }
            lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
        }
    }
    return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}
/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(kind, filename, localPath, url, size) {
    switch (kind) {
        case 'image':
            return localPath
                ? `Image: ${localPath}`
                : `Image: ${url ?? filename ?? 'image'}`;
        case 'video':
            return localPath
                ? `Video: ${localPath}`
                : `Video: ${filename ?? 'video'} (download failed)`;
        case 'file':
            return localPath
                ? `File: ${localPath}`
                : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
    }
}
/**
 * Layer 5: 最终 agentBody 拼合
 */
function buildAgentBody(base, history, isGroup, wasMentioned) {
    if (!isGroup || !wasMentioned || !history || history.length === 0) {
        return base;
    }
    const historyLines = history.map(h => {
        const name = h.senderName ?? shortSenderId(h.senderId);
        return `[${name} (${h.senderId})] ${h.content}`;
    });
    return [
        '[Chat history begins]',
        ...historyLines,
        '',
        '[Chat history ends]',
        '[Current message]',
        base,
    ].join('\n');
}
function extractVoiceTexts(attachments, processed, _logger) {
    const results = [];
    if (processed) {
        for (const pa of processed) {
            if (pa.type === 'voice' && pa.voiceText) {
                results.push({
                    text: pa.voiceText,
                    duration: pa.duration,
                    source: pa.voiceSource ?? 'stt',
                });
            }
        }
    }
    if (results.length === 0 && attachments) {
        for (const att of attachments) {
            if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
                results.push({
                    text: att.asr_refer_text.trim(),
                    source: 'asr',
                });
            }
        }
    }
    return results;
}
/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments) {
    if (!attachments || attachments.length === 0)
        return '';
    const labels = {
        image: '[图片]',
        video: '[视频]',
        file: '[文件]',
    };
    const seen = new Set();
    const tags = [];
    for (const att of attachments) {
        const kind = classifyContentType(att.content_type);
        if (kind === 'voice' || seen.has(kind))
            continue;
        seen.add(kind);
        const label = labels[kind];
        if (label)
            tags.push(label);
    }
    return tags.join(' ');
}
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
/** 发送者短标识长度（openid 前 N 位，无昵称时兜底） */
const SENDER_SHORT_ID_LEN = 8;
/** 无昵称时用 openid 前 N 位作为匿名标识 */
function shortSenderId(senderId) {
    return senderId.slice(0, SENDER_SHORT_ID_LEN);
}
//# sourceMappingURL=inbound.js.map
