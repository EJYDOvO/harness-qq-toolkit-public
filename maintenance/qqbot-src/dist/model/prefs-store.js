/**
 * PrefsStore — per-peer 会话偏好持久化（模型 + preset）
 *
 * 隔离文件 I/O 操作，便于单元测试时 mock。
 * 存储路径：~/.dsh-qqbot/model-prefs.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
export class PrefsStore {
    /** per-peer 模型偏好（内存态） */
    overrides = new Map();
    /** per-peer 最新 sessionId（fork 后更新，内存态） */
    sessionIds = new Map();
    /** per-peer preset 偏好（内存态） */
    presets = new Map();
    lifecycle = new Map();
    loadError;
    fileContent;
    /** 隔离偏好文件路径 */
    prefsPath;
    debugLog;
    constructor(debugLog) {
        // Explicit DSH_HOME isolates projects and preserves this deployment's existing data/qqbot file.
        // Unconfigured legacy hosts retain their original path; no automatic data migration.
        const home = process.env.DSH_HOME?.trim();
        this.prefsPath = home ? resolve(home, 'qqbot', 'model-prefs.json') : resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');
        this.debugLog = debugLog;
        this.load();
    }
    // ── Override 操作 ──
    getOverride(sessionKey) {
        return this.overrides.get(sessionKey);
    }
    setOverride(sessionKey, route) {
        this.overrides.set(sessionKey, route);
        this.write();
    }
    clearOverride(sessionKey) {
        const deleted = this.overrides.delete(sessionKey);
        if (deleted)
            this.write();
        return deleted;
    }
    hasOverride(sessionKey) {
        return this.overrides.has(sessionKey);
    }
    // ── SessionId 操作 ──
    getSessionId(sessionKey) {
        return this.sessionIds.get(sessionKey);
    }
    setSessionId(sessionKey, sessionId) {
        this.sessionIds.set(sessionKey, sessionId);
        this.write();
    }
    clearSessionId(sessionKey) {
        const deleted = this.sessionIds.delete(sessionKey);
        if (deleted)
            this.write();
        return deleted;
    }
    // ── Preset 操作 ──
    getPreset(sessionKey) {
        return this.presets.get(sessionKey);
    }
    setPreset(sessionKey, presetId) {
        this.presets.set(sessionKey, presetId);
        this.write();
    }
    clearPreset(sessionKey) {
        const deleted = this.presets.delete(sessionKey);
        if (deleted)
            this.write();
        return deleted;
    }
    getLifecycle(key) {
        if(this.loadError)throw new Error('QQ preferences could not be loaded; refusing lifecycle reset', {cause:this.loadError});
        return this.lifecycle.get(key);
    }
    /** Commit routing and lifecycle together; failure must not publish a new Session. */
    commitLifecycle(key, value, sessionId=this.sessionIds.get(key)) {
        if(this.loadError)throw new Error('QQ preferences are unavailable', {cause:this.loadError});
        const lifecycle=new Map(this.lifecycle),sessionIds=new Map(this.sessionIds);
        lifecycle.set(key,structuredClone(value));if(sessionId)sessionIds.set(key,sessionId);
        this.persist({overrides:Object.fromEntries(this.overrides),presets:Object.fromEntries(this.presets),sessionIds:Object.fromEntries(sessionIds),lifecycle:Object.fromEntries(lifecycle)});
        this.lifecycle=lifecycle;this.sessionIds=sessionIds;
    }
    persist(data) {
        mkdirSync(dirname(this.prefsPath),{recursive:true});
        const current=existsSync(this.prefsPath)?readFileSync(this.prefsPath,'utf8'):undefined;
        if(current!==this.fileContent)throw Error('QQ preferences changed externally; reload before committing');
        const content=JSON.stringify(data,null,2);
        const temp=this.prefsPath+'.'+process.pid+'.tmp';let fd;
        try{fd=openSync(temp,'w',0o600);writeFileSync(fd,content,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,this.prefsPath);this.fileContent=content;}
        finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp);}
    }
    // ── 私有方法 ──
    load() {
        try {
            if (!existsSync(this.prefsPath))
                return;
            const content = readFileSync(this.prefsPath, 'utf8');
            this.fileContent=content;
            const data = JSON.parse(content);
            for(const [key,value]of Object.entries(data.lifecycle??{})){
                if(!value||typeof value!=='object'||!Number.isFinite(value.lastUserAt)||typeof value.bootId!=='string')throw Error('Invalid persisted QQ lifecycle');
                this.lifecycle.set(key,value);
            }
            if (data.overrides && typeof data.overrides === 'object') {
                for (const [key, route] of Object.entries(data.overrides)) {
                    if (route.provider && route.model) {
                        this.overrides.set(key, { provider: route.provider, model: route.model });
                    }
                }
            }
            if (data.sessionIds && typeof data.sessionIds === 'object') {
                for (const [key, sessionId] of Object.entries(data.sessionIds)) {
                    if (typeof sessionId === 'string' && sessionId) {
                        this.sessionIds.set(key, sessionId);
                    }
                }
            }
            if (data.presets && typeof data.presets === 'object') {
                for (const [key, presetId] of Object.entries(data.presets)) {
                    if (typeof presetId === 'string' && presetId) {
                        this.presets.set(key, presetId);
                    }
                }
            }
        }
        catch (err) {
            this.loadError=err;
            this.debugLog?.(`loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    write() {
        try {
            if(this.loadError)throw Error('Unreadable QQ preferences cannot be replaced');
            mkdirSync(dirname(this.prefsPath), { recursive: true });
            const data = {
                overrides: Object.fromEntries(this.overrides.entries()),
                sessionIds: Object.fromEntries(this.sessionIds.entries()),
                presets: Object.fromEntries(this.presets.entries()),
                lifecycle: Object.fromEntries(this.lifecycle.entries()),
            };
            this.persist(data);
        }
        catch (err) {
            this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
//# sourceMappingURL=prefs-store.js.map
