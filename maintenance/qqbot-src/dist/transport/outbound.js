import { formatToolResult } from "./tool-presenter.js";
import { parseEvent, extractTurnError, } from "./events.js";
/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);
/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
    toolCalls = new Map();
    manager;
    bot;
    config;
    logger;
    toolsRegistry;
    constructor(manager, bot, config, logger, toolsRegistry) {
        this.manager = manager;
        this.bot = bot;
        this.config = config;
        this.logger = logger;
        this.toolsRegistry = toolsRegistry;
    }
    /** 事件分发入口 */
    route(session, raw) {
        const event = parseEvent(raw);
        if (event === undefined)
            return;
        const record = this.manager.findBySessionId(session.header.id);
        if (record === undefined)
            return;
        // Trusted identity of the native event behind each logical message: its
        // durable Session sequence and Turn. A repeated event keeps the same seq.
        const origin = { seq: raw.seq, turn: raw.data?.turn };
        switch (event.type) {
            case 'assistant/chunk':
                // Not a settlement: the reply is sent only from its settled
                // assistant/message (current Hosts publish deltas on
                // agent/assistant-stream instead, and an abandoned attempt
                // settles none). Accumulated deltas may be partial, repeated
                // across retries or joined differently from the final blocks.
                break;
            case 'assistant/message':
                // A partial settled because the Turn was cancelled (/stop, removal)
                // is not delivered: cancellation stops output that has not started.
                if (raw.data?.interrupted === true)
                    break;
                this.onMessage(record, event, origin);
                break;
            case 'tool/call':
                this.onToolCall(event);
                break;
            case 'tool/result':
                this.onToolResult(record, event, origin);
                break;
            case 'turn/end':
                this.onTurnEnd(session.header.id, record, event, origin);
                break;
        }
    }
    /** 完整 assistant 消息：以结算正文为准，整条交给 Unified Agent I/O */
    onMessage(record, event, origin) {
        const textParts = [];
        for (const block of event.content) {
            if (block.type === 'text' && block.text)
                textParts.push(block.text);
        }
        const fullText = textParts.join('\n');
        if (!fullText.trim())
            return;
        void this.send(record, fullText, 'sendMarkdown', { ...origin, kind: 'assistant' });
    }
    /** 工具调用：仅记录，不发送（避免刷屏，等待结果） */
    onToolCall(event) {
        this.toolCalls.set(event.callId, { name: event.name, args: event.arguments });
    }
    /** 工具结果：错误始终发送，成功结果按开关 */
    onToolResult(record, event, origin) {
        const call = this.toolCalls.get(event.callId);
        this.toolCalls.delete(event.callId);
        if (call === undefined)
            return;
        if (event.error === undefined && !this.config.showToolResults)
            return;
        const text = formatToolResult(call.name, call.args, event.raw, this.toolsRegistry, record.agent);
        if (!text)
            return;
        void this.send(record, text, 'sendToolResult', { ...origin, kind: 'tool' });
    }
    /** 轮次结束：异常结束时告知用户（未结算的增量不补发） */
    onTurnEnd(sessionId, record, event, origin) {
        const failure = extractTurnError(event.reason);
        if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {
            void this.send(record, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError', { ...origin, kind: 'turn-error' });
        }
        this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);
    }
    /** 统一发送：整条逻辑消息连同原生事件身份（seq/turn/kind）交给 gateway 注入的 deliverText（Unified Agent I/O）；分片、限额与错误分类在 QQ 文本 Adapter */
    send(record, text, tag, origin) {
        return this.bot.deliverText(record, text, tag, origin);
    }
}
/**
 * 创建出站事件处理器
 *
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)。
 * toolsRegistry 用于工具结果的结构化展示。
 */
export function createOutboundHandler(manager, bot, config, logger, toolsRegistry) {
    const router = new OutboundRouter(manager, bot, config, logger, toolsRegistry);
    return (session, event) => router.route(session, event);
}
//# sourceMappingURL=outbound.js.map