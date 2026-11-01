export class OutboundBuffer {
    buffer = '';
    flushing = false;
    record;
    bot;
    limit;
    logger;
    // QQ chat output has no SDK stream path: the accumulated reply is one logical
    // message for the Unified Agent I/O, which has no stream or edit operation.
    constructor(record, bot, limit, logger) {
        this.record = record;
        this.bot = bot;
        this.limit = limit;
        this.logger = logger;
    }
    /** 追加文本增量 */
    append(text) {
        this.buffer += text;
    }
    /** 获取当前累积文本 */
    get text() {
        return this.buffer;
    }
    /** 发送所有累积文本：整条交给 Unified Agent I/O */
    async flush(origin) {
        if (this.flushing || !this.buffer.trim())
            return;
        this.flushing = true;
        try {
            // origin：触发本次输出的原生事件，与静态回复共用同一逻辑消息 ID
            await this.bot.deliverText(this.record, this.buffer, 'flush', { ...origin, kind: 'assistant' });
        }
        catch (err) {
            this.logger.error('im-qqbot: flush failed');
        }
        finally {
            this.buffer = '';
            this.flushing = false;
        }
    }
    /** 取消（异常/丢弃），清空缓冲 */
    cancel() {
        this.buffer = '';
    }
}
//# sourceMappingURL=outbound-buffer.js.map
