/**
 * 内置 qqbot_send_file 工具 — 将本地文件发送给当前 QQ 会话（用户或群）。
 *
 *   - 发送目标只能是调用工具的 Agent 所在的当前会话（exec.agent → SessionManager.findByAgent）；
 *     显式 target 仅为兼容保留，且必须与当前会话一致，模型不能借它改发给其他 openid。
 *   - 文件作为一条附件消息交给 Unified Agent I/O：同会话顺序、逻辑 ID 去重、取消、
 *     每个分片前的会话/访问复核与诚实结果；QQ Adapter 负责上传和媒体消息。
 *   - 路径白名单：默认只允许访问 media 目录 + agent cwd，可开关 + 扩展白名单；发送前再复核。
 */
import { stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { MEDIA_ROOT } from "./media-cleaner.js";
/** 工具名（qqbot 前缀避免与其他通道的同名工具冲突） */
export const SEND_FILE_TOOL_NAME = 'qqbot_send_file';
const DESCRIPTION = 'Send a local file (image, video, voice, or generic file) to the QQ user or group '
    + 'of the current conversation. Pass the absolute path of a file that already exists on disk. '
    + 'Use this when the user asks you to deliver a generated file (chart, report, exported data, '
    + 'screenshot, etc.) or to send an existing media/file back to them.';
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const VOICE_EXTS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.silk', '.amr']);
/** 按扩展名归类为 Unified Agent I/O 附件类型 */
export function attachmentKind(filePath) {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    return IMAGE_EXTS.has(ext) ? 'image' : VIDEO_EXTS.has(ext) ? 'video' : VOICE_EXTS.has(ext) ? 'voice' : 'file';
}
/** 解析显式 target（"c2c:openid" / "group:openid"），非法返回 undefined */
function parseTarget(input) {
    const idx = input.indexOf(':');
    if (idx <= 0)
        return undefined;
    const scope = input.slice(0, idx);
    const targetId = input.slice(idx + 1);
    if (!targetId || (scope !== 'c2c' && scope !== 'group'))
        return undefined;
    return { scope, targetId };
}
/** 判断 filePath 是否位于 root 目录内（含 root 本身） */
function isWithinRoot(filePath, root) {
    const rel = relative(resolve(root), filePath);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** 路径白名单校验：restrictPaths 关闭时放行任意路径，否则限定 media + cwd + extraRoots */
async function isPathAllowed(filePath, config, cwd) {
    if (!config.restrictPaths)
        return true;
    const roots = [MEDIA_ROOT, cwd, ...config.extraRoots];
    for (const root of roots) {
        try { if (isWithinRoot(filePath, await realpath(root))) return true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return false;
}
/**
 * 可信本地文件：解析符号链接后的真实路径在白名单内，且是普通文件。
 * expectReal 为发送前复核：资源路径必须仍是自身的真实路径（中途被换成指向别处的
 * 符号链接、删除或替换为目录都会被拒绝）。返回 {path, size}，否则抛出带原因的错误。
 */
export async function verifyLocalFile(filePath, sendFile, cwd, { expectReal = false } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw Object.assign(new Error('empty path'), { reason: 'invalid-path' });
    let real;
    try { real = await realpath(resolve(filePath)); }
    catch { throw Object.assign(new Error('file does not exist'), { reason: 'missing' }); }
    if (expectReal && real !== filePath) throw Object.assign(new Error('resource changed since it was checked'), { reason: 'changed' });
    if (!await isPathAllowed(real, sendFile, cwd)) throw Object.assign(new Error('path outside the allowed directories'), { reason: 'outside-roots', path: real });
    const info = await stat(real);
    if (!info.isFile()) throw Object.assign(new Error('not a regular file'), { reason: 'not-file', path: real });
    return { path: real, size: info.size };
}
/** 注册 qqbot_send_file 工具（tools 服务缺失时优雅降级，不阻断插件启动） */
export function registerSendFileTool(ctx, _bot, manager, config, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qqbot_send_file 工具未注册');
        return;
    }
    const cwd = config.cwd || process.cwd();
    // A provably unsent file (refused, upload failed) may be tried again under a
    // new logical id; an unknown or sent one keeps its id, so it is never resent.
    const retries = new Map();
    const definition = {
        name: SEND_FILE_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Absolute path to the local file to send (image/video/voice/generic file).',
                },
                target: {
                    type: 'string',
                    description: 'Optional; only the current conversation ("c2c:openid" or "group:openid") is accepted. Omit it.',
                },
            },
            required: ['file_path'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    fileName: { type: 'string' },
                    fileSize: { type: 'integer' },
                    target: { type: 'string' },
                    fileUuid: { type: 'string' },
                    messageId: { type: 'string' },
                },
                required: ['fileName', 'fileSize', 'target', 'fileUuid'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: `已发送 ${v.fileName} → ${v.target}` }];
            },
        },
        async execute(args, exec) {
            const { file_path, target } = args;
            if (typeof file_path !== 'string' || file_path.length === 0) {
                throw new Error('qqbot_send_file: `file_path` must be a non-empty string');
            }
            // 1. 发送目标：只取调用者 Agent 的当前会话；模型给出的 target 不能扩大范围
            const record = exec.agent !== undefined ? manager.findByAgent(exec.agent) : undefined;
            if (record === undefined || typeof manager.submitOutput !== 'function') {
                throw new Error('qqbot_send_file: 当前 Agent 没有 QQ 会话，无法发送');
            }
            if (target !== undefined && target !== '') {
                const named = parseTarget(target);
                if (named === undefined) {
                    throw new Error(`qqbot_send_file: target 格式错误，需要 c2c:openid 或 group:openid`);
                }
                if (named.scope !== record.scope || named.targetId !== record.peerId) {
                    throw new Error('qqbot_send_file: target must be the current conversation; files are only sent there');
                }
            }
            // 2. 校验文件 + 路径白名单（真实路径；发送前 Adapter 再复核一次）
            let file;
            try { file = await verifyLocalFile(file_path, config.sendFile, cwd); }
            catch (error) {
                if (error.reason === 'outside-roots') throw new Error(`qqbot_send_file: file_path 不在允许的目录内: ${error.path}`);
                if (error.reason === 'not-file') throw new Error(`qqbot_send_file: 路径不是普通文件: ${error.path}`);
                throw new Error(`qqbot_send_file: 文件不存在: ${resolve(file_path)}`);
            }
            const fileName = basename(file.path);
            // 3. 一条附件消息交给 Unified Agent I/O。逻辑 ID 由会话、轮次与真实路径决定：
            //    同一轮内对同一文件的重复调用（含结果未知后的重试）得到第一次的结果，不会再发。
            const turn = manager.latestTurn?.(record);
            const base = `qq:${record.sessionId}:${Number.isSafeInteger(turn) ? turn : '-'}:file:${createHash('sha256').update(file.path).digest('hex').slice(0, 16)}`;
            const attempt = retries.get(base) ?? 0, id = attempt ? `${base}:${attempt}` : base;
            const result = await manager.submitOutput(record, { attachments: [{ kind: attachmentKind(file.path), name: fileName, size: file.size, resource: { type: 'local', path: file.path } }] },
                { id, turn, signal: exec.signal instanceof AbortSignal ? exec.signal : undefined, delivery: { kind: 'tool-or-error' } });
            const part = result.parts?.find(p => p.attachment === 0);
            if (result.status === 'not-sent') {
                retries.delete(base); retries.set(base, attempt + 1);
                while (retries.size > 256) retries.delete(retries.keys().next().value);
            }
            if (result.status === 'sent') {
                logger.info(`im-qqbot: qqbot_send_file 发送 ${attachmentKind(file.path)} (${file.size} bytes)${result.duplicate ? ' (duplicate, not resent)' : ''}`);
                return {
                    fileName,
                    fileSize: file.size,
                    target: `${record.scope}:${record.peerId}`,
                    fileUuid: part?.uploaded ?? '',
                    ...(part?.receipt !== undefined ? { messageId: part.receipt } : {}),
                };
            }
            if (result.status === 'unknown') {
                throw new Error(`qqbot_send_file: 发送结果未知（${result.reason ?? 'unknown'}），文件可能已到达 QQ，不会自动重发`);
            }
            throw new Error(`qqbot_send_file: 未发送（${result.reason ?? result.status}）`);
        },
    };
    tools.register(definition);
    logger.info('im-qqbot: qqbot_send_file 工具已注册');
}
//# sourceMappingURL=send-file-tool.js.map
