import { classifyContentType, } from "./attachment.js";
import { clearGroupHistory } from "../features/history-store.js";
import { QQ_SCOPES } from "./qq-text-adapter.js";
// ── 基础 Media：QQ 附件 → Unified Agent I/O 附件描述 ──
const short = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value) ? value : undefined;
/**
 * 一个 QQ 附件的描述：类型、名称、大小，语音的 ASR 文本（模型可见内容的来源），
 * 以及可信资源引用——附件中间件下载到 media 目录的本地文件，否则是 QQ 事件给出的
 * 平台 URL。资源引用只来自 QQ 事件与本 Adapter 的下载，不来自模型。
 */
function qqAttachment({ contentType, filename, size, url, asr }, downloaded) {
    const kind = classifyContentType(contentType);
    const local = kind === 'voice' ? undefined : ref(downloaded?.localPath);
    const remote = ref(url);
    return {
        kind,
        ...(short(filename) ? { name: filename } : {}),
        ...(short(contentType) ? { contentType } : {}),
        ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
        ...(typeof asr === 'string' && asr.trim() ? { transcript: asr.trim() } : {}),
        ...(local ? { resource: { type: 'local', path: local } } : remote ? { resource: { type: 'remote', url: remote } } : {}),
    };
}
// 下载结果按文件名关联（与原组装逻辑一致）；每个下载只用于一个同名附件。
function byName(downloads) {
    const map = new Map();
    for (const d of downloads ?? []) if (d?.filename !== undefined && !map.has(d.filename)) map.set(d.filename, d);
    return map;
}
function qqAttachments(attachments, downloads) {
    const found = byName(downloads);
    return (attachments ?? []).slice(0, 20).map(a => qqAttachment({ contentType: a.content_type, filename: a.filename, size: a.size, url: a.url, asr: a.asr_refer_text }, found.get(a.filename)));
}
/** 引用消息：被引用原文与其附件（与当前消息附件分开，带各自的下载结果）。 */
function qqQuote(quote, downloads) {
    if (!quote) return undefined;
    const text = quote.text || quote.entry?.content;
    const found = byName(downloads);
    const attachments = (quote.attachments ?? []).slice(0, 20).map(a => qqAttachment({ contentType: a.contentType, filename: a.filename, url: a.url, asr: a.asrText }, found.get(a.filename ?? '')));
    if (!text && !attachments.length) return undefined;
    return { ...(typeof text === 'string' && text ? { text } : {}), ...(attachments.length ? { attachments } : {}) };
}
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
    const attachments = qqAttachments(msg.attachments, ctx.state?.downloadedFiles);
    const quote = qqQuote(ctx.state?.quote, ctx.state?.downloadedQuoteFiles);
    return {
        conversation: { type: group ? 'group' : 'direct', id: group ? (msg.groupOpenid ?? msg.senderId) : msg.senderId },
        message: { ...(typeof msg.messageId === 'string' && msg.messageId ? { id: msg.messageId } : {}), text: msg.content ?? '', ...(attachments.length ? { attachments } : {}), ...(quote ? { quote } : {}) },
        sender: { id: msg.senderId, ...(typeof msg.senderName === 'string' && msg.senderName ? { displayName: msg.senderName } : {}) },
        ...(msg.timestamp === undefined ? {} : { timestamp: msg.timestamp }),
        platformData: { context: ctx },
    };
}
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）：标准化后交给 Unified Agent I/O 的
 * 入站通道，由它去重并交给 deliverInbound。不再直接创建 Agent 输入。
 */
export async function handleInbound(ctx, logger, channel) {
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
 * QQ 的可信会话入口（Unified Agent I/O 入站通道的 deliver）。平台无关的交接
 * （访问配置复核 → Conversation Manager getOrCreate（含 Character Identity 等
 * 包装）→ isCurrentSession → 原生 UserMessage → Interaction intervene 或
 * followup）由共享的 Conversation 接线完成；这里只保留 QQ 协议：C2C 发送者、
 * 回复目标、模型可见正文组装、兜底提示、群历史、typing 与等待本轮结束。
 * 返回交接结果：accepted＝已创建 Agent 输入；rejected＝准入拒绝；
 * not-delivered＝未创建输入。
 */
export async function deliverInbound(standard, conversation, config, logger) {
    const ctx = standard.platformData?.context, hold = standard.platformData?.hold ?? {};
    const msg = ctx.message;
    const mwState = ctx.state;
    const { bot } = ctx;
    const scope = QQ_SCOPES[standard.conversation.type];
    const peerId = standard.conversation.id;
    // A QQ C2C Conversation is its own sender. The shared entry re-checks the
    // access configuration and never opens a disabled group scope.
    if (scope === 'c2c' && standard.sender.id !== peerId)
        return { status: 'rejected', reason: 'unauthorized' };
    const replyTarget = {
        scope,
        targetId: peerId,
        msgId: standard.message.id,
    };
    // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供），准入之后才组装 ──
    const agentBody = () => {
        const body = assembleAgentBody(standard.message, msg, mwState, scope);
        if (body)
            logger.info(`Processing: scope=${scope} length=${body.length}`);
        return body;
    };
    const result = await conversation.handoff(standard, { replyTarget, content: agentBody });
    if (result.reason === 'session-unavailable') {
        const err = result.error;
        logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
        // 兜底回复：会话创建失败时告知用户，避免静默无响应
        try {
            await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
        }
        catch (sendErr) {
            logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
        }
    }
    if (result.status !== 'accepted')
        return { status: result.status, reason: result.reason };
    const { record } = result;
    // With Interaction, input that arrives mid-run reached the Agent now: the
    // policy chooses native steer/followup/cancel, and its single send queue
    // keeps QQ output serial, so the concurrency guard need not wait for idle.
    logger.info(result.mode === 'intervene' ? `→ interaction input: scope=${scope}` : `→ followup sent: scope=${scope}`);
    // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
    if (scope === 'group') {
        clearGroupHistory(config.appId, peerId);
    }
    if(result.interactive){
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
function assembleAgentBody(message, msg, state, scope) {
    const isGroup = scope === 'group';
    const wasMentioned = state.mention?.wasMentioned ?? false;
    const attachments = message.attachments ?? [];
    const userContent = buildUserContent(message.text, attachments);
    if (isEmptyMessage(userContent, attachments, isGroup, wasMentioned))
        return null;
    const quotePart = buildQuotePart(message.quote);
    const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned);
    const dynamicCtx = buildDynamicCtx(attachments, message.quote);
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
function buildUserContent(content, attachments) {
    const parts = [];
    const text = (content ?? '').trim();
    if (text) {
        parts.push(text);
    }
    for (const voice of attachments.filter(a => a.kind === 'voice' && a.transcript)) {
        parts.push(`[Voice message] ${voice.transcript}`);
    }
    // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
    const attachmentTags = buildAttachmentTags(attachments);
    if (attachmentTags) {
        parts.push(attachmentTags);
    }
    return parts.join('\n');
}
/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote) {
    if (!quote?.text)
        return '';
    const quoteText = quote.text;
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
const localOf = a => a.resource?.type === 'local' ? a.resource.path : undefined;
const urlOf = a => a.resource?.type === 'remote' ? a.resource.url : undefined;
function buildDynamicCtx(attachments, quote) {
    const lines = [];
    if (attachments.length > 0) {
        const voices = [];
        // 一次遍历归类 + 生成媒体行
        for (const att of attachments) {
            if (att.kind === 'voice') {
                voices.push(att);
                continue;
            }
            lines.push(`- ${renderMediaLine(att.kind, att.name, localOf(att), urlOf(att), att.size)}`);
        }
        // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
        if (voices.length > 0) {
            const asrTexts = voices.map(a => a.transcript).filter(Boolean);
            if (asrTexts.length > 0) {
                lines.push(`- ASR: ${asrTexts.join(' | ')}`);
            }
            else {
                const urls = voices.map(urlOf).filter(Boolean);
                if (urls.length > 0)
                    lines.push(`- Voice: ${urls.join(', ')}`);
            }
        }
    }
    // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
    const quoteAttachments = quote?.attachments;
    if (quoteAttachments && quoteAttachments.length > 0) {
        lines.push('[Reference attachments]');
        for (const qa of quoteAttachments) {
            if (qa.kind === 'voice') {
                if (qa.transcript)
                    lines.push(`  - Voice: ${qa.transcript}`);
                continue;
            }
            lines.push(`  - ${renderMediaLine(qa.kind, qa.name, localOf(qa), urlOf(qa), undefined)}`);
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
        const kind = att.kind;
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
