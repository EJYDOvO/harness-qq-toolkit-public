import { createHash, randomUUID } from 'node:crypto';
import { SessionId, buildForkSeed } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { ModelResolver } from "./model-resolver.mjs";
import { IdleEvictor } from "./idle-evictor.mjs";
// Stable through plugin reloads, different after an actual Host process restart.
const hostBootId=globalThis[Symbol.for('dsh.conversation.sessionBoot.v1')]??=randomUUID();
/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS = {
    busy: '压缩服务忙，请稍后重试',
    cancelled: '压缩已取消',
    changed: '历史在压缩过程中发生变化，请重试',
    commit: '压缩提交失败',
    persistence: '压缩完成但保存失败',
};
export class ConversationManager {
    sessions = new Map();
    evictor;
    modelResolver;
    ctx;
    agents;
    config;
    logger;
    disposers = [];
    lifecycleLocks = new Map();
    closed = false;
    closing;
    releasedRecords = new WeakSet();
    closingHandles = new Map();
    cleanupErrors = [];
    releaseRecord(record){
        if(this.releasedRecords.has(record))return;
        this.releasedRecords.add(record);
        try{this.adapter.release?.(record);}catch(error){this.cleanupErrors.push(error);}
    }
    disposeHandle(handle){
        if(this.closingHandles.has(handle))return this.closingHandles.get(handle);
        const closing=Promise.resolve().then(()=>handle.dispose()).then(()=>{this.closingHandles.delete(handle);},error=>{this.cleanupErrors.push(error);throw error;});
        this.closingHandles.set(handle,closing);return closing;
    }
    async drainSessionClosures(id){
        await Promise.all([...this.closingHandles].filter(([h])=>h.agent.id===id).map(([,p])=>p));
        if(this.closed)throw Error('Conversation manager disposed');
    }
    constructor(ctx, agents, config, logger) {
        this.ctx = ctx;
        this.adapter = config.adapter;
        if(!this.adapter || typeof this.adapter.key!=="function")throw Error("Trusted Conversation Adapter required");
        this.agents = agents;
        this.config = config;
        this.logger = logger;
        this.modelResolver = new ModelResolver(ctx, config, logger);
        this.evictor = new IdleEvictor(this.sessions, config.sessionIdleTimeout, (key, record) => {
            if(this.protectedSession(record))return;
            this.logger.info(`evicting idle session: key=${key}`);
            this.releaseRecord(record);
            this.sessions.delete(key);
            void this.disposeHandle(record.handle).catch(() => { });
            // 回收会话时统一清理其待答问题/待批审批，避免 pending 悬挂泄漏
            this.adapter.cancelPending?.(record);
        });
        this.registerScopePromptInjection();
        this.disposers.push(ctx.on('agent/disposed',({agent})=>{const record=this.findByAgent(agent);if(record){this.releaseRecord(record);this.sessions.delete(record.sessionKey);}}));
    }
    /**
     * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
     *
     * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
     * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
     * 额外 prompt 时原样返回，不做改动。
     */
    registerScopePromptInjection() {
        const assemble = async (_assembly, context, next) => {
            const assembled = await next();
            if (!context.agent)
                return assembled;
            const record = this.findByAgent(context.agent);
            if (!record)
                return assembled;
            const prompt = this.adapter.prompt?.(record);
            if (!prompt)
                return assembled;
            return {
                ...assembled,
                sections: [...(assembled.sections ?? []), { name: 'conversation:scope-prompt', order: 90, text: prompt }],
            };
        };
        this.disposers.push(this.ctx.on('system-prompt/assemble', assemble));
    }
    /**
     * 动态获取 sessions 服务（fork 能力，可选）
     */
    getSessionsService() {
        try {
            return this.ctx.get('sessions');
        }
        catch {
            return undefined;
        }
    }
    /**
     * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
     */
    getPresetsService() {
        try {
            return this.ctx.get('agentPresets');
        }
        catch {
            return undefined;
        }
    }
    /**
     * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
     * 只有原生持久化层确认该 Session 不存在才允许新建；其他异常必须上抛。
     */
    async resolvePersistedPreset(sessionId) {
        return (await this.readPersistedSession(sessionId))?.meta?.agentPreset;
    }
    // ── 模型相关（委托给 ModelResolver） ──
    getEffectiveModel(scope, peerId) {
        return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
    }
    /**
     * 获取指定 peer 的生效 preset（per-peer 覆盖 > config.preset）
     */
    getEffectivePreset(scope, peerId) {
        return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
    }
    /** 按 sessionKey 解析生效 preset */
    getEffectivePresetByKey(key) {
        return this.modelResolver.getPreset(key) ?? this.config.preset;
    }
    /**
     * 列出所有可用 preset（/preset 命令用）
     */
    async listPresets() {
        const presets = this.getPresetsService();
        if (!presets)
            return [];
        try {
            const list = await presets.list();
            return list.map((p) => ({ id: p.id, name: p.name, description: p.description }));
        }
        catch (err) {
            this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
    /**
     * 切换模型（fork + 重建会话，保留历史）
     */
    async setModelOverride(scope, peerId, route) {
        return this.inConversation(this.sessionKey(scope,peerId),()=>this.changeModelOverride(scope,peerId,route));
    }
    async changeModelOverride(scope, peerId, route) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        if (!record) {
            this.modelResolver.prefs.commitSession(key,this.currentSessionId(key),route);
            this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
            return;
        }
        if(this.protectedSession(record))throw Error('Conversation has unfinished interaction; model switch refused');
        await this.rebuildSession(record, { route });
        this.logger.info(`model switched via fork: key=${key} → ${route.provider}/${route.model}`);
    }
    /**
     * 切换指定 peer 的 agent preset（per-peer 覆盖）
     *
     * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
     * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
     */
    async setPresetOverride(scope, peerId, presetId) {
        return this.inConversation(this.sessionKey(scope,peerId),()=>this.changePresetOverride(scope,peerId,presetId));
    }
    async changePresetOverride(scope, peerId, presetId) {
        const key = this.sessionKey(scope, peerId);
        // 1. 校验 preset 存在 + 可加载（broken 拒绝）
        const presets = this.getPresetsService();
        if (!presets)
            return { ok: false, reason: 'unavailable' };
        let resolved;
        try {
            resolved = await presets.resolve(presetId);
        }
        catch (err) {
            return { ok: false, reason: 'unknown-preset', message: err instanceof Error ? err.message : String(err) };
        }
        if (resolved.broken !== undefined) {
            return { ok: false, reason: 'broken', message: resolved.broken };
        }
        // 2. 持久化 per-peer 覆盖（新会话生效）
        this.modelResolver.setPreset(key, presetId);
        const hasActive = this.sessions.has(key);
        this.logger.info(`preset pref saved: key=${key} → ${presetId}${hasActive ? ' (active session locked, next session applies)' : ''}`);
        return { ok: true, presetId };
    }
    /**
     * 清除 per-peer preset 覆盖，回到 config.preset / 默认（新会话生效）
     */
    async clearPresetOverride(scope, peerId) {
        return this.inConversation(this.sessionKey(scope,peerId),()=>this.clearPresetPreference(scope,peerId));
    }
    async clearPresetPreference(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        this.modelResolver.clearPreset(key);
        this.logger.info(`preset pref cleared: key=${key} (next session applies)`);
        return { ok: true };
    }
    /**
     * fork + 重建会话（保留历史，换 model）
     *
     * options.route 缺省时沿用当前生效值。preset 沿用当前生效 preset（getEffectivePresetByKey）。
     * fork 不可用或失败时拒绝，保留原路由。
     */
    async rebuildSession(record, options) {
        const key = record.sessionKey;
        const sessionsService = this.getSessionsService();
        if (!sessionsService) throw Error('Native Session service unavailable; model switch refused');
        let seed, inheritedEventCount;
        try {
            // rc.2 fork() returns a live Session, not an .events bag. Use the
            // exported native prefix builder, avoiding an orphan live fork.
            const events = record.agent.session.snapshotEvents();
            inheritedEventCount = events.length;
            seed = events.length ? buildForkSeed(events, events.at(-1).seq) : [];
        }
        catch (err) { throw new Error('Cannot snapshot Session; model switch refused',{cause:err}); }
        const childId = SessionId(randomUUID());
        const effectiveRoute = options.route ?? this.modelResolver.getEffectiveRoute(key);
        const composed = await this.composePreset(record.agentPreset??this.getEffectivePresetByKey(key));
        const created = await this.agents.create({
            sessionId: childId,
            seed,
            inheritedEventCount,
            meta: {
                cwd: this.config.cwd || process.cwd(),
                parentSession: record.sessionId,
                isSeeded: true,
                ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
            },
            ...(effectiveRoute ? { agentOptions: effectiveRoute } : {}),
            ...(composed.setup ? { setup: composed.setup } : {}),
        });
        try {
            if(!await sessionsService.flush(created.agent.session))throw new Error('Model fork persistence did not acknowledge the Session');
            if(this.closed||this.sessions.get(key)!==record)throw new Error('Conversation route changed during model fork');
            this.modelResolver.prefs.commitSession(key,childId,effectiveRoute);
        } catch(error) { await this.disposeHandle(created).catch(()=>{}); throw error; }
        const oldHandle = record.handle;
        this.releaseRecord(record);
        record.sessionId = childId;
        record.agent = created.agent;
        record.handle = created;
        record.agentPreset = composed.agentPreset;
        record.lastActivity = Date.now();
        this.releasedRecords.delete(record); // the reused record now owns a new Agent lifetime
        void this.disposeHandle(oldHandle).catch(() => { });
        this.logger.info(`session rebuilt via fork: key=${key} preset=${composed.agentPreset ?? 'none'} sessionId=${childId}`);
    }
    async clearModelOverride(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        return this.inConversation(key,()=>this.modelResolver.clearOverride(key));
    }
    async listAvailableModels() {
        return this.modelResolver.listModels();
    }
    listProviders() {
        return this.modelResolver.listProviders();
    }
    // ── 会话状态 / 统计 ──
    getSessionRecord(scope, peerId) {
        return this.sessions.get(this.sessionKey(scope, peerId));
    }
    getStatus(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const route = this.getEffectiveModel(scope, peerId);
        const policy=this.lifecycleEnabled(scope)?this.modelResolver.prefs.getLifecycle(this.sessionKey(scope,peerId)):null;
        return {
            active: !!record,
            sessionId: record?.sessionId,
            provider: route?.provider,
            model: route?.model,
            preset: record?.agentPreset,
            lastActivity: record?.lastActivity,
            messageCount: this.countMessages(record),
            lifecycle:policy?{enabled:true,lastUserAt:policy.lastUserAt,pendingReason:policy.due,blockedBy:policy.blocker??null,generation:policy.generation??0}:{enabled:false},
        };
    }
    getTokenUsage(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const events = record?.agent.session.snapshotEvents?.()??record?.agent.session.events;
        if (!events)
            return stats;
        for (const event of events) {
            if (event.type !== 'assistant/message' || !event.usage)
                continue;
            stats.input += event.usage.input ?? 0;
            stats.output += event.usage.output ?? 0;
            stats.cacheRead += event.usage.cacheRead ?? 0;
            stats.cacheWrite += event.usage.cacheWrite ?? 0;
        }
        return stats;
    }
    exportMarkdown(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        if (!record)
            return '';
        const events = record.agent.session.snapshotEvents?.()??record.agent.session.events;
        if (!events || events.length === 0)
            return '';
        const lines = [`# Conversation export\n`, `> session: ${record.sessionId}\n`];
        for (const event of events) {
            if (event.type === 'user/message') {
                const text = extractMessageText(event.message);
                if (text)
                    lines.push(`## 用户\n\n${text}\n`);
            }
            else if (event.type === 'assistant/message') {
                const text = extractMessageText(event.message);
                if (text)
                    lines.push(`## 助手\n\n${text}\n`);
            }
        }
        return lines.join('\n');
    }
    countMessages(record) {
        const events = record?.agent.session.snapshotEvents?.()??record?.agent.session.events;
        if (!events)
            return 0;
        let count = 0;
        for (const event of events) {
            if (event.type === 'user/message' || event.type === 'assistant/message') {
                count += 1;
            }
        }
        return count;
    }
    // ── Session 生命周期管理 ──
    async readPersistedSession(id){
        const persistence=this.ctx.get('sessionPersistence');
        if(!persistence)throw Error('Session persistence unavailable');
        if(typeof persistence.open!=='function'){
            if(typeof persistence.load==='function'){
                try{const stored=await persistence.load(id);if(!stored?.meta||!Array.isArray(stored.events))throw Error('Invalid persisted Session document');return stored;}catch(error){if(error instanceof SessionPersistenceNotFoundError&&error.sessionId===id)return undefined;throw error;}
            }
            throw Error('Unsupported Session persistence API');
        }
        let handle;
        try{handle=await persistence.open(id,'read');}catch(error){if(error instanceof SessionPersistenceNotFoundError&&error.sessionId===id)return undefined;throw error;}
        try{return {meta:handle.header,events:(await handle.read()).events};}finally{await handle.close();}
    }
    protectedSession(record) {
        return !!record&&(record.agent.status==='running'||record.agent.inbox?.hasPending===true||this.adapter.waitingForUser?.(record)===true);
    }
    lifecycleEnabled(scope){return this.adapter.lifecycleScope?.(scope)===true&&this.config.sessionLifecycle?.enabled===true;}
    /** Called only after SDK access/mention admission, before command or answer interception. */
    noteUserMessage(scope,peerId,senderId,messageId) {
        if(this.closed)throw Error('Conversation manager disposed');
        if(!this.lifecycleEnabled(scope)||!this.adapter.acceptActivity(scope,peerId,senderId,messageId))return;
        const key=this.sessionKey(scope,peerId),prefs=this.modelResolver.prefs,old=prefs.getLifecycle(key);
        if(messageId&&old?.lastMessageId===messageId&&old?.bootId===hostBootId)return;
        const now=Date.now(),idle=this.config.sessionLifecycle.inactivityMs??43200000;
        if(!Number.isFinite(idle)||idle<1)throw Error('Invalid Conversation inactivity interval');
        const value={...old,bootId:old?.bootId??'',lastUserAt:now,lastMessageId:messageId??null,
            due:old?.due??((this.config.sessionLifecycle.freshOnHostRestart!==false&&old?.bootId!==hostBootId)?'host_restart':old&&now-old.lastUserAt>=idle?'user_inactivity':null)};
        prefs.commitLifecycle(key,value);
    }
    async inConversation(key,operation){
        const run=(this.lifecycleLocks.get(key)??Promise.resolve()).catch(()=>{}).then(()=>{if(this.closed)throw Error('Conversation manager disposed');return operation();});
        this.lifecycleLocks.set(key,run);
        try{return await run;}finally{if(this.lifecycleLocks.get(key)===run)this.lifecycleLocks.delete(key);}
    }
    async unfinishedPersisted(sessionId){
        const persistence=this.ctx.get('sessionPersistence');
        if(!persistence)throw Error('Conversation lifecycle requires Session persistence');
        const loaded=await this.readPersistedSession(sessionId);if(!loaded)return false;
        let open=false;const pending={'next-turn':[], 'next-step':[]};
        for(const event of loaded.events??[]){
            if(event.type==='turn/start')open=true;if(event.type==='turn/end')open=false;
            if(event.type==='agent/inbox/spliced'){const d=event.data,list=pending[d.target];if(list)list.splice(d.start,d.removedCount??d.deleteCount??0,...(d.inserted??[]));}
        }
        return open||Object.values(pending).some(a=>a.length>0);
    }
    async rotateSession(scope,peerId,senderId,replyTarget,old,state){
        const key=this.sessionKey(scope,peerId),previous=old?.sessionId??this.currentSessionId(key);
        const protectedOld=()=>{const live=this.agents.get(previous);return this.protectedSession(old)||!!live&&(live.status==='running'||live.inbox?.hasPending);};
        if(protectedOld()){state.blocker='unfinished_interaction';this.modelResolver.prefs.commitLifecycle(key,state);return null;}
        if(!old&&await this.unfinishedPersisted(previous)){state.blocker='unfinished_persisted_work';this.modelResolver.prefs.commitLifecycle(key,state);return null;}
        // Adapters keep existing reminders on their original roots. Character
        // provides a stable-conversation bridge; other integrations defer safely.
        const schedules=this.ctx.get('schedule');
        const reminders=schedules?await schedules.list({sessionId:previous}):[];
        if(reminders.length&&this.preserveScheduledSession?.(previous)!==true){state.blocker='existing_schedule';this.modelResolver.prefs.commitLifecycle(key,state);return null;}
        if(protectedOld())return null;
        const composed=await this.composePreset(old?.agentPreset??this.getEffectivePresetByKey(key)),route=this.modelResolver.getEffectiveRoute(key),id=SessionId(randomUUID());
        const handle=await this.agents.create({sessionId:id,meta:{cwd:this.config.cwd||process.cwd(),agentPreset:composed.agentPreset},...(route?{agentOptions:route}:{}),setup:composed.setup});
        try{
            if(this.closed)throw Error('Conversation manager closed during rotation');
            if(protectedOld()){await this.disposeHandle(handle);return null;}
            const sessions=this.ctx.get('sessions');if(!sessions||!await sessions.flush(handle.agent.session))throw Error('Fresh Conversation Session was not durably stored');
            if(this.closed)throw Error('Conversation manager closed during rotation');
            if(protectedOld()){await this.disposeHandle(handle);return null;}
            const next={...this.modelResolver.prefs.getLifecycle(key),bootId:hostBootId,due:null,blocker:null,generation:(state.generation??0)+1,previousSessionId:previous};
            this.modelResolver.prefs.commitLifecycle(key,next,id);
            const record={sessionKey:key,sessionId:id,agent:handle.agent,handle,replyTarget,scope,peerId,senderId,lastActivity:Date.now(),agentPreset:composed.agentPreset};
            this.sessions.set(key,record);
            if(old){this.releaseRecord(old);await this.disposeHandle(old.handle);}
            return record;
        }catch(error){if(this.sessions.get(key)?.sessionId!==id)await this.disposeHandle(handle).catch(()=>{});throw error;}
    }
    sessionKey(scope, peerId) {
        return this.adapter.key(scope,peerId);
    }
    deriveSessionId(sessionKey) {
        const hash = createHash('sha256').update(sessionKey).digest('hex');
        return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    }
    currentSessionId(sessionKey) {
        return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
    }
    /** Host admission check, not a model-provided identity. Recheck after await. */
    isCurrentSession(record) {
        return !this.closed && this.sessions.get(record?.sessionKey) === record
            && record.sessionId === this.currentSessionId(record.sessionKey)
            && this.agents.get(record.sessionId) === record.agent;
    }
    async composePreset(presetId) {
        const presets = this.getPresetsService();
        if (!presets) throw new Error('Conversation requires the Host agentPresets service; refusing fallback');
        const resolved = await presets.resolve(presetId);
        if (resolved.broken !== undefined || (presetId && resolved.id !== presetId))
            throw new Error('Conversation preset unavailable; refusing fallback');
        return { agentPreset: resolved.id, setup: async (agentCtx) => { await presets.mount(agentCtx, resolved.id); } };
    }
    /** 获取或恢复或创建会话（get → resume → create） */
    async getOrCreate(scope, peerId, senderId, replyTarget) {
        return this.inConversation(this.sessionKey(scope,peerId),async()=>{
            await this.drainSessionClosures(this.currentSessionId(this.sessionKey(scope,peerId)));
            // Remote Ops restores the owner route at Gateway startup without a
            // message id. Restoration must neither count as user activity nor
            // consume a deferred rotation; only actual admitted input may do that.
            if(this.lifecycleEnabled(scope)&&this.adapter.isUserInput(replyTarget)){
                const key=this.sessionKey(scope,peerId);
                this.noteUserMessage(scope,peerId,senderId,this.adapter.inputId(replyTarget));
                const state=this.modelResolver.prefs.getLifecycle(key),old=this.sessions.get(key);
                if(state?.due){const rotated=await this.rotateSession(scope,peerId,senderId,replyTarget,old,state);if(rotated)return rotated;}
            }
            return this.getOrRestore(scope,peerId,senderId,replyTarget);
        });
    }
    async getOrRestore(scope, peerId, senderId, replyTarget) {
        const key = this.sessionKey(scope, peerId);
        const existing = this.sessions.get(key);
        if (existing) {
            existing.replyTarget = replyTarget;
            existing.lastActivity = Date.now();
            return existing;
        }
        const route = this.modelResolver.getEffectiveRoute(key);
        const sessionId = SessionId(this.currentSessionId(key));
        this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);
        let agent;
        let handle;
        let agentPreset;
        const live = this.agents.get(sessionId);
        if (live) {
            agent = live;
            agentPreset = this.getPresetsService()?.composedPreset?.(live.ctx);
            this.logger.info(`reusing live agent: key=${key}`);
        }
        else {
            // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
            // 优先 session 当初的 preset（started 锁定语义），无则用当前 effective preset。
            const persisted=await this.readPersistedSession(sessionId);
            const presetId = persisted?.meta?.agentPreset ?? this.getEffectivePresetByKey(key);
            const composed = await this.composePreset(presetId);
            agentPreset = composed.agentPreset;
            if(persisted) {
                const resumeRoute = this.modelResolver.getResumeRoute(key);
                const resumed = await this.agents.resume({
                    resumeSessionId: sessionId,
                    ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = resumed.agent;
                handle = resumed;
                this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
            }
            else {
                const created = await this.agents.create({
                    sessionId,
                    meta: {
                        cwd: this.config.cwd || process.cwd(),
                        ...(agentPreset ? { agentPreset } : {}),
                    },
                    ...(route ? { agentOptions: route } : {}),
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = created.agent;
                handle = created;
                try{if(!await this.ctx.get('sessions')?.flush(agent.session))throw Error('Created Conversation Session was not durably stored');}
                catch(error){await this.disposeHandle(handle).catch(()=>{});throw error;}
                this.logger.info(`created new session: key=${key} preset=${agentPreset ?? 'none'}`);
            }
        }
        const record = {
            sessionKey: key,
            sessionId,
            agent,
            handle: handle ?? { agent, dispose: async () => { } },
            replyTarget,
            scope,
            peerId,
            senderId,
            lastActivity: Date.now(),
            agentPreset,
        };
        if(this.closed){await this.disposeHandle(record.handle);throw Error('Conversation manager closed during restoration');}
        this.sessions.set(key, record);
        return record;
    }
    findBySessionId(sessionId) {
        for (const record of this.sessions.values()) {
            if (record.sessionId === sessionId)
                return record;
        }
        return undefined;
    }
    findByAgent(agent) {
        for (const record of this.sessions.values()) {
            if (record.agent === agent)
                return record;
        }
        return undefined;
    }
    async remove(scope, peerId) {
        return this.inConversation(this.sessionKey(scope,peerId),()=>this.removeSession(scope,peerId));
    }
    async removeSession(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        this.modelResolver.setSessionId(key, randomUUID());
        if (!record)
            return;
        this.releaseRecord(record);
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        await this.disposeHandle(record.handle).catch(() => { });
        this.logger.info(`session removed: key=${key}`);
    }
    /**
     * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
     *
     * 需通过 agentPresets.serviceFor(agent, 'compaction') 解析；未挂载时优雅降级。
     * 这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
     */
    async compact(scope, peerId) {
        return this.inConversation(this.sessionKey(scope,peerId),()=>this.compactSession(scope,peerId));
    }
    async compactSession(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        if (!record)
            return { ok: false, reason: 'no-session' };
        if (record.agent.status !== 'idle')
            return { ok: false, reason: 'busy' };
        let compaction;
        try {
            const presets = this.getPresetsService();
            compaction = (presets?.serviceFor(record.agent, 'compaction') ?? this.ctx.get('compaction'));
        }
        catch {
            compaction = undefined;
        }
        if (!compaction)
            return { ok: false, reason: 'unavailable' };
        const route = this.modelResolver.getEffectiveRoute(key);
        const agentCtx = {
            session: record.agent.session,
            options: { provider: route?.provider, model: route?.model },
            runMaintenance: record.agent.runMaintenance.bind(record.agent),
        };
        try {
            const result = await compaction.compactNow(agentCtx, new AbortController().signal);
            if (result === null)
                return { ok: true, shadowed: 0, tokens: 0 };
            return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
        }
        catch (err) {
            const code = err?.code;
            // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
            if (code === 'summary') {
                return { ok: true, shadowed: 0, tokens: 0 };
            }
            // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
            if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
                this.logger.debug(`compact declined: key=${key} code=${code}`);
                return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
            }
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`compact failed: key=${key} err=${message}`);
            return { ok: false, reason: 'failed', message };
        }
    }
    disposeAll(){return this.closing??=this.closeAll();}
    async closeAll() {
        this.closed=true;
        for(const dispose of this.disposers.splice(0))if(typeof dispose==='function')try{dispose();}catch(error){this.cleanupErrors.push(error);}
        this.evictor.dispose();
        for(const record of this.sessions.values())this.releaseRecord(record);
        await Promise.allSettled([...this.lifecycleLocks.values()]);
        const records = [...this.sessions.values()];
        this.sessions.clear();
        for (const record of records) {
            this.releaseRecord(record);
            try{record.agent.cancel({ kind: 'user' });}catch(error){this.cleanupErrors.push(error);}
            void this.disposeHandle(record.handle).catch(()=>{});
        }
        await Promise.allSettled([...this.closingHandles.values()]);
        this.logger.info(`all sessions disposed (count=${records.length})`);
        if(this.cleanupErrors.length)throw new AggregateError([...new Set(this.cleanupErrors)],'Conversation cleanup failed');
    }
    records(){return this.sessions.values();}
    ownershipState(key){if(this.closed)throw Error('Conversation manager disposed');if(this.modelResolver.prefs.loadError)throw Error("Conversation state unreadable");const state=this.modelResolver.prefs.getLifecycle(key);return Object.freeze({sessionId:this.currentSessionId(key),previousSessionId:state?.previousSessionId,generation:state?.generation??0,blocker:state?.blocker??null});}
    get size() {
        return this.sessions.size;
    }
}
/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(message) {
    const blocks = message?.content;
    if (!blocks || !Array.isArray(blocks))
        return '';
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text' && block.text) {
            parts.push(block.text);
        }
    }
    return parts.join('\n').trim();
}
