/**
 * QQ Official text adapter for the Unified Agent I/O (dsh-agent-io).
 *
 * Owns only QQ protocol: Conversation → reply target through the trusted
 * Conversation Manager record, passive-reply quota and diagnostics (reused
 * from the gateway sender), platform chunking, and QQ API error classification.
 * Ordering, cancellation and duplicate suppression belong to the I/O core.
 * No SDK import: the gateway injects the send and split functions.
 */
export const QQ_OFFICIAL = 'qq-official';
const scopes = { direct: 'c2c', group: 'group' };
/** Logical Conversation of a Conversation Manager record (never model input). */
export function qqConversation(record) {
    return { type: record.scope === 'group' ? 'group' : 'direct', id: record.peerId };
}
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
 * @param accountId QQ application id this gateway serves.
 * @param manager   the gateway's Conversation Manager handle (trusted routing).
 * @param send      (replyTarget, text, {index, sessionId}) → SDK result; resolves the
 *                  passive-reply target and applies the quota.
 * @param split     text → markdown-aware chunks.
 * @param limit     hard per-message character limit.
 */
export function createQQTextAdapter({ accountId, manager, send, split, limit = 4500 }) {
    return {
        platform: QQ_OFFICIAL,
        accountId,
        // Checked before every part: the origin Session must still be the current
        // Session of exactly this Conversation, so rotation, removal or a late
        // Turn from an older Session cannot reach the user.
        resolve(target, origin) {
            const scope = scopes[target.conversation.type];
            if (!scope) return { ok: false, reason: 'invalid-target' };
            if (typeof origin?.sessionId !== 'string' || !origin.sessionId) return { ok: false, reason: 'unauthorized' };
            const record = manager.getSessionRecord(scope, target.conversation.id);
            if (!record) return { ok: false, reason: 'stale' };
            if (record.sessionId !== origin.sessionId) return { ok: false, reason: 'stale' };
            const reply = record.replyTarget;
            if (!reply || reply.scope !== scope || reply.targetId !== target.conversation.id) return { ok: false, reason: 'invalid-target' };
            return { ok: true, route: { record } };
        },
        split: text => hardLimit(split(text), limit),
        async send(route, text, info) {
            const result = await send({ ...route.record.replyTarget }, text, { index: info.index, sessionId: route.record.sessionId });
            return { receipt: typeof result?.id === 'string' ? result.id : undefined };
        },
        classify: classifyQQError,
    };
}
