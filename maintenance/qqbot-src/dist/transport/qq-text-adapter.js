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
 * @param accountId QQ application id this gateway serves.
 * @param manager   the gateway's Conversation Manager handle (trusted routing).
 * @param access    the gateway's access configuration (c2cMode/c2cAllow/groupMode/groupAllow).
 * @param send      (replyTarget, text, {index, sessionId}) → SDK result; resolves the
 *                  passive-reply target and applies the quota.
 * @param split     text → markdown-aware chunks.
 * @param limit     hard per-message character limit.
 */
export function createQQTextAdapter({ accountId, manager, access, send, split, limit = 4500 }) {
    // The Manager's own ownership check is required: without it a late reply
    // could not be proven to belong to the current Session, so refuse to start.
    if (typeof manager?.getSessionRecord !== 'function' || typeof manager.isCurrentSession !== 'function') throw new Error('Conversation Manager ownership check required');
    return {
        platform: QQ_OFFICIAL,
        accountId,
        // Checked before every part: the peer must still be admitted, and the
        // origin Session must still be the Manager's current Session of exactly
        // this Conversation with its live Agent, so rotation, removal, Agent
        // disposal, revoked access or a late Turn from an older Session cannot
        // reach the user. Only Host-filled evidence is compared; nothing here
        // trusts model-supplied ids or platformData.
        resolve(target, origin) {
            const scope = scopes[target.conversation.type];
            if (!scope) return { ok: false, reason: 'invalid-target' };
            if (typeof origin?.sessionId !== 'string' || !origin.sessionId) return { ok: false, reason: 'unauthorized' };
            if (!accessAllows(access, scope, target.conversation.id)) return { ok: false, reason: 'unauthorized' };
            const record = manager.getSessionRecord(scope, target.conversation.id);
            if (!record || record.sessionId !== origin.sessionId) return { ok: false, reason: 'stale' };
            if (manager.isCurrentSession(record) !== true) return { ok: false, reason: 'stale' };
            if (record.scope !== scope || record.peerId !== target.conversation.id) return { ok: false, reason: 'invalid-target' };
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
