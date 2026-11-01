import { messageFilter, accessPolicy, mentionGate, contentSanitizer, rateLimiter, concurrencyGuard, typingIndicator, quoteRef, historyBuffer, envelopeFormatter, } from '@tencent-connect/qqbot-nodejs';
import { buildCommandList } from "../commands/index.js";
import { downloadMediaAttachments } from "../transport/attachment.js";
import { getHistoryStore, historyGroupKey } from "../features/history-store.js";
/**
 * A QQ command spec (SDK SlashCommand shape: name, scope, authorized, handler)
 * as an Agent I/O command. The handler and its authorization run unchanged on
 * the QQ middleware context, with the router's parsed command attached.
 */
export function qqCommand(cmd) {
    const scopes = cmd.scope === 'c2c' ? ['direct'] : cmd.scope === 'group' ? ['group'] : undefined;
    const qq = call => {
        const ctx = call.context, command = { name: call.name, args: [...call.args], raw: call.raw };
        ctx.state.command = command;
        ctx.command = command;
        return ctx;
    };
    return {
        name: cmd.name, description: cmd.description, usage: cmd.usage, hidden: cmd.hidden, category: cmd.category, ...(scopes ? { scopes } : {}),
        ...(cmd.authorized ? { authorize: call => cmd.authorized(qq(call)) } : {}),
        execute: call => cmd.handler(qq(call)),
    };
}
/**
 * QQ protocol side of commands, at the former slashCommand position (before the
 * merge guard, so /stop is never queued behind the running Turn): strip the
 * server @ markers, require an @ in groups, then hand the standard candidate to
 * the router. Anything but `pass` stops the chain: a command never becomes Agent
 * input, and a re-delivered command is not executed again.
 */
export function commandGate(router) {
    return async (ctx, next) => {
        const msg = ctx.message;
        const content = (msg.content ?? '').trim();
        if (!content) return next();
        const cleaned = content.replace(/<@!?[^>]+>\s*/g, '').trim();
        if (msg.kind === 'group' && !(msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || msg.mentions?.some(m => m.is_you))) return next();
        const group = msg.kind === 'group';
        const input = {
            conversation: { type: group ? 'group' : 'direct', id: group ? (msg.groupOpenid ?? msg.senderId) : msg.senderId },
            sender: { id: msg.senderId },
            message: { ...(typeof msg.messageId === 'string' && msg.messageId ? { id: msg.messageId } : {}), text: cleaned },
        };
        const result = await router.dispatch(input, { context: ctx });
        if (result.status === 'pass') return next();
        if (result.status === 'failed') ctx.log?.error?.(`[command] /${result.command} failed`);
        ctx.stop(`command:${result.status}${result.command ? ':' + result.command : ''}`);
    };
}
/**
 * Attachment downloads (current message and quoted message) tagged with the
 * index of the attachment they belong to, so each attachment gets its own file.
 * The upstream attachmentProcessor returns downloads by file name only, which
 * gave two attachments of one name (or quoted ones without a name, or a failed
 * one and a later one of the same name) the same file. One download per
 * attachment, in order; a skipped or failed one has no entry and only that one
 * is lost.
 */
export function attachmentDownloads(config, logger) {
    // Upstream download logs contain filenames, local paths and raw errors.
    const downloadLog = {
        debug: () => logger.debug?.('QQ attachment download state changed'),
        warn: () => logger.warn?.('QQ attachment download unavailable'),
        error: () => logger.error?.('QQ attachment download failed'),
    };
    const each = async list => {
        const out = [];
        for (const [attachment, raw] of (list ?? []).entries()) {
            try {
                const [file] = await downloadMediaAttachments([raw], config.media, downloadLog);
                if (file) out.push({ ...file, attachment });
            }
            catch (err) { logger.warn('im-qqbot: attachment download failed'); }
        }
        return out;
    };
    return async (ctx, next) => {
        ctx.state.downloadedFiles = await each(ctx.message.attachments?.map(a => ({ ...a, filename: a.filename ?? '' })));
        // Quoted attachments in the raw attachment shape (voice and URL-less ones are skipped by the download).
        const quoted = ctx.state.quote?.attachments;
        if (quoted?.length) ctx.state.downloadedQuoteFiles = await each(quoted.map(a => ({ content_type: a.contentType ?? '', filename: a.filename ?? '', size: 0, url: a.url })));
        await next();
    };
}
/**
 * QQ protocol side of HITL text answers, at the former questionAnswer position
 * (before the merge guard, so an answer is never queued behind the waiting
 * Turn): the standard message goes to the Bridge, which answers the open
 * question of this Conversation only for the expected person and claims the
 * platform message once. Anything else continues as ordinary chat input.
 */
export function hitlAnswers(manager, replyIds) {
    return async (ctx, next) => {
        const hitl = manager.hitl, msg = ctx.message;
        if (!hitl) return next();
        const group = msg.kind === 'group';
        const result = hitl.answer({
            conversation: { type: group ? 'group' : 'direct', id: group ? (msg.groupOpenid ?? msg.senderId) : msg.senderId },
            sender: { id: msg.senderId },
            message: { ...(typeof msg.messageId === 'string' && msg.messageId ? { id: msg.messageId } : {}), text: (msg.content ?? '').replace(/<@!?[^>]+>\s*/g, '').trim() },
        });
        if (result.status === 'pass') return next();
        // The answer never reaches bot.on('message'): keep its msgId as a passive-reply candidate.
        if (result.status === 'answered') replyIds.cacheMsgId(ctx.replyTarget.scope, ctx.replyTarget.targetId, ctx.replyTarget.msgId);
        ctx.stop(`hitl:${result.status}`);
    };
}
export function setupMiddlewares(bot, config, manager, logger, conversation, replyIds) {
    // 1. 错误兜底（最外层洋葱皮）
    // The SDK errorHandler directly sends raw exception text. Before an input
    // has entered I/O there is no scoped reply grant: fail closed, never revive
    // that sender. Admitted Session acquisition errors use conversation.reply.
    bot.use(async (_ctx, next) => { try { await next(); } catch (error) { try { logger.error?.('QQ inbound pipeline failed; no direct fallback'); } catch {} throw error; } });
    // 2. 消息过滤：bot 回声 + 消息去重
    bot.use(messageFilter({ skipSelfEcho: false }));
    // 3. 访问控制（白名单/开放/禁用）
    bot.use(accessPolicy({
        c2c: {
            mode: config.access.c2cMode,
            allow: config.access.c2cAllow,
        },
        group: {
            mode: config.access.groupMode,
            allow: config.access.groupAllow,
        },
        onBlock: (_mCtx, reason) => {
            if (config.debug) {
                logger.debug('Access blocked by configured policy');
            }
        },
    }));
    // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
    //    store 走共享单例（getHistoryStore），groupKey 带 appId 前缀，供回复后清空
    bot.use(historyBuffer({
        limit: config.historyLimit,
        store: getHistoryStore(),
        recordOnSkip: true,
        groupKey: (ctx) => {
            const gid = ctx.message.groupOpenid;
            if (ctx.message.kind !== 'group' || !gid)
                return undefined;
            return historyGroupKey(config.appId, gid);
        },
    }));
    // 5. 群聊 @bot 门控
    bot.use(mentionGate({
        requireMentionInGroup: config.requireMention,
    }));
    bot.use(async(mCtx,next)=>{
        const msg=mCtx.message,scope=msg.kind==='group'?'group':'c2c';
        manager.noteUserMessage?.(scope,scope==='group'?(msg.groupOpenid??msg.senderId):msg.senderId,msg.senderId,msg.messageId);
        return next();
    });
    // 6. 内容清洗（去 @marker、表情标签、多余空白）
    bot.use(contentSanitizer({
        parseFaceTags: true,
    }));
    // 7. 三层限流（sender / group / global）
    bot.use(rateLimiter());
    // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应；识别/解析/路由由 Unified Agent I/O 完成）
    const commands = [...buildCommandList({ manager, config }), ...(manager.ctx?.get('qqRemoteOps')?.commands(manager) ?? [])];
    const stop = commands.find(c => c.name === 'stop');
    if (stop) {
        const nativeStop = stop.handler;
        stop.handler = cmdCtx => {
            const msg = cmdCtx.message;
            const scope = msg.kind === 'group' ? 'group' : 'c2c';
            const record = manager.getSessionRecord(scope, scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId);
            // Unified Agent I/O output of this Session that has not reached QQ yet.
            if (record) manager.cancelOutput?.(record);
            try {
                const policy = record && conversation.policy(record);
                if (policy === null) throw new Error('Interaction lookup failed');
                policy?.stopOutput();
            } catch { logger.warn?.('Interaction unavailable during stop; continuing native cancellation'); }
            return nativeStop(cmdCtx);
        };
    }
    // Recognition, parsing, once-only claim and routing belong to the Unified
    // Agent I/O command router; the QQ and Remote Ops commands keep executing and
    // authorizing themselves. No SDK slashCommand and no automatic /help.
    const router = conversation.openCommands({ prefixes: ['/'] });
    for (const cmd of commands) router.register(qqCommand(cmd));
    bot.use(commandGate(router));
    // 8.5. 待答问题文本作答（HITL Bridge；在 concurrencyGuard 之前，答案消息不排队直接作答）
    bot.use(hitlAnswers(manager, replyIds));
    // Explicit correction only, after access/question admission but before merge.
    // Ordinary messages and /stop retain their existing native paths.
    bot.use(async (mCtx, next) => {
        const msg = mCtx.message;
        const correction = /^更正[：:]\s*(\S[\s\S]*)$/u.exec(msg.content ?? '');
        if (msg.kind !== 'c2c' || !correction || msg.attachments?.length) return next();
        const record = manager.getSessionRecord('c2c', msg.senderId);
        const policy = record && conversation.policy(record);
        if (!policy || record.agent.status !== 'running') return next();
        if (manager.admitInteractionInput) {
            const admitted = await manager.admitInteractionInput(mCtx);
            if (admitted !== record) throw new Error('Interaction Session changed during admission');
        }
        record.replyTarget = { scope: 'c2c', targetId: msg.senderId, msgId: msg.messageId };
        // The shared handoff re-checks the current Session and creates the native input.
        const handed = conversation.submit(record, msg.content, { revise: true, input: {
            platform: conversation.platform, adapter: conversation.adapter, accountId: conversation.accountId,
            conversation: { type: 'direct', id: msg.senderId }, sender: { id: msg.senderId }, message: { id: msg.messageId, text: msg.content },
        } });
        if (handed.status !== 'accepted') throw new Error('Interaction Session changed during admission');
    });
    // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
    bot.use(concurrencyGuard({
        strategy: 'merge',
        maxQueue: config.maxQueue,
        maxProcessingMs: config.processingTimeoutMs,
    }));
    // 10. C2C 输入状态指示
    bot.use(typingIndicator());
    // 11. 引用消息解析（记录 + 解析被引用原文）
    bot.use(quoteRef({
        maxSize: 500,
        preferMsgElements: true,
    }));
    // 11.5. 附件下载（file 附件下载到本地，供 @提及 / 工具访问）
    bot.use(attachmentDownloads(config, logger));
    // 12. 上下文组装（将 history + quote + sender 组成 envelope）
    bot.use(envelopeFormatter({
        historyLimit: config.historyLimit,
        includeQuote: true,
        includeSender: true,
    }));
}
//# sourceMappingURL=middleware-setup.js.map
