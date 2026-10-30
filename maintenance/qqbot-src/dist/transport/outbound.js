import { OutboundBuffer } from "./outbound-buffer.js";
import { formatToolResult } from "./tool-presenter.js";
import { parseEvent, extractTurnError, } from "./events.js";
/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);
/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
    buffers = new Map();
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
                this.onChunk(session.header.id, record, event);
                break;
            case 'assistant/message':
                // A partial settled because the Turn was cancelled (/stop, removal)
                // is not delivered: cancellation stops output that has not started.
                if (raw.data?.interrupted === true) {
                    this.buffers.get(session.header.id)?.cancel();
                    this.buffers.delete(session.header.id);
                    break;
                }
                this.onMessage(session.header.id, record, event, origin);
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
    /** 流式文本增量：累积到会话 buffer */
    onChunk(sessionId, record, event) {
        let buffer = this.buffers.get(sessionId);
        if (buffer === undefined) {
            buffer = new OutboundBuffer(record, this.bot, this.config.textChunkLimit, this.logger, this.shouldStream(record));
            this.buffers.set(sessionId, buffer);
        }
        buffer.append(event.text);
    }
    /** 是否启用流式：配置开启 + c2c + 有 msgId（群聊不支持流式） */
    shouldStream(record) {
        return this.config.streaming
            && record.replyTarget.scope === 'c2c'
            && !!record.replyTarget.msgId;
    }
    /** 完整 assistant 消息：有流式 buffer 则 flush，否则直接发送文本块 */
    onMessage(sessionId, record, event, origin) {
        const buffer = this.buffers.get(sessionId);
        if (buffer !== undefined && buffer.text.trim()) {
            void buffer.flush(origin);
            this.buffers.delete(sessionId);
            return;
        }
        const textParts = [];
        for (const block of event.content) {
            if (block.type === 'text' && block.text)
                textParts.push(block.text);
        }
        const fullText = textParts.join('\n');
        if (!fullText.trim())
            return;
        void this.send(record, fullText, 'sendMarkdown', { ...origin, kind: 'assistant' });
        this.buffers.delete(sessionId);
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
    /** 轮次结束：清理 buffer，异常结束时告知用户 */
    onTurnEnd(sessionId, record, event, origin) {
        const buffer = this.buffers.get(sessionId);
        // A cancelled Turn's unsent buffer is dropped, not flushed.
        const cancelled = ['aborted', 'interrupted'].includes(event.reason?.kind);
        if (buffer !== undefined) {
            if (buffer.text.trim() && !cancelled) {
                void buffer.flush(origin);
            }
            else {
                buffer.cancel();
            }
            this.buffers.delete(sessionId);
        }
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