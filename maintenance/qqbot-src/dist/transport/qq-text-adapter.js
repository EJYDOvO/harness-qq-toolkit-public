/**
 * QQ Official text and basic media adapter for the Unified Agent I/O (dsh-agent-io).
 *
 * Owns only QQ protocol: the reply target of the trusted Conversation Manager
 * record, passive-reply quota and diagnostics (reused from the gateway sender),
 * platform chunking, media upload/send of trusted local resources, and QQ API
 * error classification. The route itself (access,
 * current Session of exactly this Conversation) is the shared Conversation
 * wiring's; ordering, cancellation and duplicate suppression belong to the I/O
 * core. No SDK import: the gateway injects the send and split functions.
 */
export const QQ_OFFICIAL = 'qq-official';
/** Conversation type → existing Manager scope (keeps `qqbot:<appId>:<scope>:<peer>` keys). */
export const QQ_SCOPES = Object.freeze({ direct: 'c2c', group: 'group' });
// The markdown chunker keeps code fences and tables whole and may exceed the
// limit on one long line; cut those at the limit without splitting a surrogate pair.
function hardLimit(parts, limit) {
    const out = [];
    for (let part of parts) {
        while (part.length > limit) {
            let end = limit;
            if (/[\uD800-\uDBFF]/u.test(part[end - 1])) end--;
            out.push(part.slice(0, end));
            part = part.slice(end);
        }
        if (part) out.push(part);
    }
    return out;
}
/**
 * QQ ApiError (SDK 1.0.5): httpStatus 0 is a timeout or network failure after
 * the request may have been written; 5xx and malformed 2xx bodies may follow a
 * processed message. Only a 4xx other than 408 proves the platform refused it.
 */
export function classifyQQError(error) {
    const status = error?.name === 'ApiError' && Number.isInteger(error.httpStatus) ? error.httpStatus : undefined;
    if (status === undefined) return { outcome: 'unknown', reason: 'adapter-error' };
    if (status === 0) return { outcome: 'unknown', reason: 'timeout-or-network' };
    if (status === 408) return { outcome: 'unknown', reason: 'timeout' };
    if (status === 429) return { outcome: 'not-sent', reason: 'rate-limited' };
    if (status >= 400 && status < 500) return { outcome: 'not-sent', reason: 'platform-rejected' };
    if (status >= 500) return { outcome: 'unknown', reason: 'platform-unavailable' };
    return { outcome: 'unknown', reason: 'invalid-response' };
}
/**
 * Media parts fail at a known stage. `resource`: the trusted file no longer
 * passes the send-time check (nothing was read or uploaded). `upload`: the QQ
 * upload step (its own retries included) failed, and an upload alone never
 * shows anything to the user, so the part is provably not sent. Only a failure
 * of the media message request itself is classified like a text part.
 */
export function classifyQQPartError(error) {
    if (error?.qqStage === 'resource') return { outcome: 'not-sent', reason: 'invalid-resource', stage: 'before-platform' };
    if (error?.qqStage === 'upload') return { outcome: 'not-sent', reason: 'upload-failed', stage: 'platform' };
    return classifyQQError(error?.qqStage === 'message' ? error.cause : error);
}
/** Attachment kinds QQ can send as media messages, all from a trusted local file. */
export const QQ_MEDIA_KINDS = Object.freeze(['image', 'video', 'voice', 'file']);
/**
 * The gateway's access configuration at send time (same rules as the SDK
 * accessPolicy for C2C sender / group openid). A peer the configuration no
 * longer admits is never written to, whatever an older record says.
 */
export function accessAllows(access, scope, peerId) {
    const policy = scope === 'group' ? { mode: access?.groupMode, allow: access?.groupAllow } : { mode: access?.c2cMode, allow: access?.c2cAllow };
    const mode = policy.mode ?? 'open';
    if (mode === 'open') return true;
    if (mode !== 'allowlist' || !Array.isArray(policy.allow)) return false;
    return policy.allow.some(value => value === '*' || value === peerId);
}
/**
 * Protocol parts for `conversation.registerAdapter()`.
 * @param send         (replyTarget, text, {index, sessionId, messageId}) → SDK result; resolves the
 *                     passive/active target through the gateway sender (quota, diagnostics).
 * @param split        text → markdown-aware chunks.
 * @param limit        hard per-message character limit.
 * @param replyTarget  optional (record, messageId) → the reply target of the input a
 *                     logical message answers (Interaction bubbles); used only while
 *                     it names this record's Conversation, otherwise the record's latest.
 * @param sendMedia    optional (replyTarget, attachment, info) → {id?, uploaded?}: uploads
 *                     and sends one trusted local attachment; without it, attachments are
 *                     refused before any part is sent.
 */
export function createQQTextAdapter({ send, split, limit = 4500, replyTarget, sendMedia }) {
    const targetFor = (record, messageId) => {
        let own;
        try { own = typeof replyTarget === 'function' ? replyTarget(record, messageId) : undefined; } catch { own = undefined; }
        return own && own.scope === record.scope && own.targetId === record.peerId ? own : record.replyTarget;
    };
    return {
        // After the shared route check, before every part: the record's reply
        // target must still point at exactly this Conversation.
        check(record) {
            const reply = record.replyTarget;
            if (!reply || reply.scope !== record.scope || reply.targetId !== record.peerId) return { ok: false, reason: 'invalid-target' };
            return { ok: true };
        },
        split: text => hardLimit(split(text), limit),
        async send(route, text, info) {
            const record = route.record;
            const result = await send({ ...targetFor(record, info.messageId) }, text, { index: info.index, sessionId: record.sessionId, messageId: info.messageId });
            return { receipt: typeof result?.id === 'string' ? result.id : undefined };
        },
        // Only trusted local resources: a remote URL would let a caller make QQ
        // fetch an arbitrary address on its behalf.
        ...(typeof sendMedia === 'function' ? {
            accepts: attachment => QQ_MEDIA_KINDS.includes(attachment?.kind) && attachment.resource?.type === 'local',
            async sendAttachment(route, attachment, info) {
                const record = route.record;
                const result = await sendMedia({ ...targetFor(record, info.messageId) }, attachment, { index: info.index, sessionId: record.sessionId, messageId: info.messageId });
                return { receipt: typeof result?.id === 'string' ? result.id : undefined, uploaded: typeof result?.uploaded === 'string' && result.uploaded ? result.uploaded : undefined };
            },
        } : {}),
        classify: classifyQQPartError,
    };
}
