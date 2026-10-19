import { errorHandler, messageFilter, accessPolicy, mentionGate, contentSanitizer, rateLimiter, slashCommand, concurrencyGuard, typingIndicator, quoteRef, historyBuffer, envelopeFormatter, } from '@tencent-connect/qqbot-nodejs';
import { buildCommandList } from "../commands/index.js";
import { attachmentProcessor } from "../middleware/attachment.js";
import { questionAnswer } from "../middleware/question-answer.js";
import { getHistoryStore, historyGroupKey } from "../features/history-store.js";
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export function setupMiddlewares(bot, config, manager, logger) {
    // 1. 错误兜底（最外层洋葱皮）
    bot.use(errorHandler());
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
                logger.debug(`Access blocked: ${reason}`);
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
    // 6. 内容清洗（去 @marker、表情标签、多余空白）
    bot.use(contentSanitizer({
        parseFaceTags: true,
    }));
    // 7. 三层限流（sender / group / global）
    bot.use(rateLimiter());
    // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
    const commands = [...buildCommandList({ manager, config }), ...(manager.ctx?.get('qqRemoteOps')?.commands(manager) ?? [])];
    const stop = commands.find(c => c.name === 'stop');
    if (stop) {
        const nativeStop = stop.handler;
        stop.handler = cmdCtx => {
            const msg = cmdCtx.message;
            const scope = msg.kind === 'group' ? 'group' : 'c2c';
            const record = manager.getSessionRecord(scope, scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId);
            try {
                const service = record && manager.ctx.get('agentPresets')?.serviceFor?.(record.agent, 'interactionPolicy');
                service?.get(record.agent).stopOutput();
            } catch { logger.warn?.('Interaction unavailable during stop; continuing native cancellation'); }
            return nativeStop(cmdCtx);
        };
    }
    const slash = slashCommand({
        // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，
        // 避免 SDK 再自动注册一个无前缀的 /help 造成重复
        autoHelp: false,
        commands,
    });
    bot.use(slash.middleware);
    // 8.5. 待答问题截获（在 concurrencyGuard 之前，答案消息不排队直接作答）
    bot.use(questionAnswer(manager));
    // Explicit correction only, after access/question admission but before merge.
    // Ordinary messages and /stop retain their existing native paths.
    bot.use(async (mCtx, next) => {
        const msg = mCtx.message;
        const correction = /^更正[：:]\s*(\S[\s\S]*)$/u.exec(msg.content ?? '');
        if (msg.kind !== 'c2c' || !correction || msg.attachments?.length) return next();
        const record = manager.getSessionRecord('c2c', msg.senderId);
        const policy = record && manager.ctx.get('agentPresets')?.serviceFor?.(record.agent, 'interactionPolicy')?.get(record.agent);
        if (!policy || record.agent.status !== 'running') return next();
        if (manager.admitInteractionInput) {
            const admitted = await manager.admitInteractionInput(mCtx);
            if (admitted !== record) throw new Error('Interaction Session changed during admission');
        }
        record.replyTarget = { scope: 'c2c', targetId: msg.senderId, msgId: msg.messageId };
        const message=createUserMessage({ content: [{ type: 'text', text: msg.content }], source: { kind: 'user' } });
        manager.registerInteractionInput?.(record,message);
        policy.revise(message);
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
    bot.use(attachmentProcessor(config, logger));
    // 12. 上下文组装（将 history + quote + sender 组成 envelope）
    bot.use(envelopeFormatter({
        historyLimit: config.historyLimit,
        includeQuote: true,
        includeSender: true,
    }));
}
//# sourceMappingURL=middleware-setup.js.map
