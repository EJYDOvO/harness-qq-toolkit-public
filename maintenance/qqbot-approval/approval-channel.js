import { randomUUID } from 'node:crypto';
import { decodeButtonData } from './button-utils.js';
import { buildApprovalKeyboard, buildApprovalText } from './approval-renderer.js';
function commandOf(req) {
    if (req.callId === undefined) return undefined;
    const session = req.agent.session;
    for(let seq = session.seq - 1; seq >= 0; seq--){
        const event = session.eventAt(seq);
        if (event?.type !== 'tool/call' || String(event.data?.callId) !== String(req.callId)) continue;
        const raw = event.data?.arguments;
        if (typeof raw !== 'string') return undefined;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.command === 'string') return parsed.command;
        } catch  {}
        return raw.length <= 500 ? raw : `${raw.slice(0, 500)}…`;
    }
    return undefined;
}
export class ApprovalChannel {
    manager;
    sender;
    logger;
    pending = new Map();
    installed = false;
    constructor(manager, sender, logger){
        this.manager = manager;
        this.sender = sender;
        this.logger = logger;
    }
    install(ctx) {
        if (this.installed) return;
        this.installed = true;
        ctx.on('approval/request', (req, next)=>{
            const request = req;
            const record = this.manager.findBySessionId(request.agent.id);
            return record ? this.park(record, request) : next();
        }, {
            prepend: true
        });
        ctx.effect?.(()=>()=>{
                for (const key of [
                    ...this.pending.keys()
                ])this.cancelPending(key);
            });
        this.logger.info('im-qqbot: QQ approval channel installed');
    }
    settle(key, entry, outcome) {
        if (this.pending.get(key) !== entry) return;
        this.pending.delete(key);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onAbort) entry.request.signal?.removeEventListener('abort', entry.onAbort);
        entry.resolve(outcome);
    }
    cancelPending(key) {
        const entry = this.pending.get(key);
        if (entry) this.settle(key, entry, 'cancelled');
    }
    handleInteraction(event) {
        const peerId = event.group_openid ?? event.user_openid;
        if (!peerId) return false;
        const scope = event.group_openid ? 'group' : 'c2c';
        const record = this.manager.getSessionRecord(scope, peerId);
        if (!record) return false;
        const entry = this.pending.get(record.sessionKey);
        const raw = event.data?.resolved?.button_data;
        const button = raw ? decodeButtonData(raw) : undefined;
        if (!entry || !button || button.t !== 'approval' || button.n !== entry.nonce) return false;
        if (button.d !== 'allow' && button.d !== 'deny') return false;
        if (!event.user_openid || event.user_openid !== entry.approverId) return false;
        if (entry.request.signal?.aborted) {
            this.settle(record.sessionKey, entry, 'cancelled');
            return false;
        }
        this.settle(record.sessionKey, entry, button.d === 'allow' ? 'allowed-once' : 'rejected');
        return true;
    }
    park(record, request) {
        const key = record.sessionKey;
        if (request.signal?.aborted) return Promise.resolve('cancelled');
        if (this.pending.has(key)) return Promise.resolve('unavailable');
        const approverId = record.senderId || (record.scope === 'c2c' ? record.replyTarget.targetId : undefined);
        if (!approverId) return Promise.resolve('unavailable');
        let command;
        try {
            command = commandOf(request);
        } catch (error) {
            this.logger.error(`im-qqbot: approval command lookup failed: ${String(error)}`);
            return Promise.resolve('unavailable');
        }
        return new Promise((resolve)=>{
            const entry = {
                request,
                nonce: randomUUID(),
                approverId,
                resolve
            };
            this.pending.set(key, entry);
            entry.onAbort = ()=>this.settle(key, entry, 'cancelled');
            request.signal?.addEventListener('abort', entry.onAbort, {
                once: true
            });
            entry.timer = setTimeout(()=>this.settle(key, entry, 'cancelled'), 300_000);
            if (request.signal?.aborted) {
                this.settle(key, entry, 'cancelled');
                return;
            }
            Promise.resolve().then(()=>{
                if (this.pending.get(key) !== entry) return;
                return this.sender.sendMarkdown(record.replyTarget, buildApprovalText(request, command), {
                    keyboard: buildApprovalKeyboard(entry.nonce)
                });
            }).then(()=>{
                if (this.pending.get(key) === entry) this.logger.info(`im-qqbot: approval sent to QQ, waiting for decision key=${key}`);
            }, (error)=>{
                this.logger.error(`im-qqbot: approval send failed key=${key}: ${String(error)}`);
                this.settle(key, entry, 'unavailable');
            });
        });
    }
}
