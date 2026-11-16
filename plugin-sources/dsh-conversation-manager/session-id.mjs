import { createHash } from 'node:crypto';

// Longest accepted session namespace; it is an identifier, not free text.
export const MAX_SESSION_NAMESPACE_LENGTH = 128;

/**
 * Whether a value may be stored as a state file's session namespace.
 * @param {unknown} value
 * @returns {boolean}
 */
export function validSessionNamespace(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_NAMESPACE_LENGTH && value.trim() === value;
}

/**
 * The Session ID of a conversation key with no recorded Session.
 *
 * Without a namespace the id depends on the key alone (the historical formula,
 * kept so existing derived Sessions keep their ids). The key does not name who
 * owns the state file, so two state files sharing one Host Session store would
 * derive the same id; a namespace scopes the derived id to its state file.
 * @param {string} sessionKey
 * @param {string} [namespace]
 * @returns {string} UUID-shaped id
 */
export function deriveSessionId(sessionKey, namespace) {
    const input = namespace === undefined ? sessionKey : `${namespace}\n${sessionKey}`;
    const hash = createHash('sha256').update(input).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
