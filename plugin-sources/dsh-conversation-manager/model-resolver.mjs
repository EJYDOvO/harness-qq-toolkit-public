import { PrefsStore } from "./preferences.mjs";

export class ModelResolver {
    prefs;
    ctx;
    config;
    logger;
    constructor(ctx, config, logger) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        this.prefs = config.preferences ?? new PrefsStore(undefined,config.stateFile);
    }
    /**
     * 获取指定 sessionKey 的有效模型路由（create 用）
     *
     * 优先级：Conversation 偏好 > Adapter 显式配置 > 原生 Host 选择。
     */
    getEffectiveRoute(sessionKey) {
        return this.prefs.getOverride(sessionKey) ?? this.resolveDefault();
    }
    /**
     * 获取 resume 时覆盖 session 的模型路由
     *
     * 优先级：Conversation 偏好 > Adapter 显式配置 > 原生 Host 选择。
     *
     * 这里不返回 undefined，因为未装 installModelSelection，system-prompt 的
     * {{model}} 变量直接读 agent.options.model——若无值会抛
     * "prompt variable {{model}} has no value for this assembly"。
     * 因此兜底到默认链，确保 agent.options.model 始终有值。
     */
    getResumeRoute(sessionKey) {
        const override = this.prefs.getOverride(sessionKey);
        if (override)
            return override;
        if (this.config.provider && this.config.model) {
            return { provider: this.config.provider, model: this.config.model };
        }
        return this.resolveDefault();
    }
    /**
     * 设置 per-peer 模型偏好并持久化到隔离文件
     */
    setOverride(sessionKey, route) {
        this.prefs.setOverride(sessionKey, route);
    }
    /**
     * 清除 per-peer 模型偏好并持久化
     */
    clearOverride(sessionKey) {
        this.prefs.clearOverride(sessionKey);
    }
    /**
     * 是否存在指定 session 的模型偏好
     */
    hasOverride(sessionKey) {
        return this.prefs.hasOverride(sessionKey);
    }
    /**
     * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
     */
    getSessionId(sessionKey) {
        return this.prefs.getSessionId(sessionKey);
    }
    /**
     * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
     */
    setSessionId(sessionKey, sessionId) {
        this.prefs.setSessionId(sessionKey, sessionId);
    }
    /**
     * 清除指定 sessionKey 的 sessionId 记录
     */
    clearSessionId(sessionKey) {
        this.prefs.clearSessionId(sessionKey);
    }
    /**
     * 获取指定 sessionKey 的 per-peer preset 覆盖
     */
    getPreset(sessionKey) {
        return this.prefs.getPreset(sessionKey);
    }
    /**
     * 设置 per-peer preset 覆盖并持久化
     */
    setPreset(sessionKey, presetId) {
        this.prefs.setPreset(sessionKey, presetId);
    }
    /**
     * 清除 per-peer preset 覆盖并持久化
     */
    clearPreset(sessionKey) {
        return this.prefs.clearPreset(sessionKey);
    }
    /**
     * 解析默认模型路由（不含 per-peer 偏好）
     *
     * 只读取显式配置或原生 agentDefaultModel，不读取任何平台私有设置。
     * 没有可信模型路由时拒绝，不静默切换到其他提供方。
     */
    resolveDefault() {
        if (this.config.provider && this.config.model) {
            return { provider: this.config.provider, model: this.config.model };
        }
        const fromHost = this.readFromHost();
        if (fromHost)
            return fromHost;
        throw Error('No explicit or native Host model selection; refusing fallback');
    }
    /**
     * 列出所有可用模型
     *
     * 通过原生 ctx.llm 发现模型；服务不可用时返回空清单。
     */
    async listModels() {
        const llm = this.getLlmService();
        if (!llm)
            return [];
        try {
            const providers = llm.listProviders();
            const entries = [];
            for (const provider of providers) {
                const providerId = typeof provider === 'string' ? provider : provider.id;
                try {
                    const models = await llm.listModels(providerId);
                    for (const model of models) {
                        entries.push({ provider: providerId, id: model.id, name: model.name });
                    }
                }
                catch (err) {
                    // 单个 provider 失败，跳过
                    this.logger?.debug(`ModelResolver: provider ${providerId} 模型列表获取失败: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (entries.length > 0)
                return entries;
        }
        catch (err) {
            this.logger?.warn(`ModelResolver: model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return [];
    }
    /**
     * 列出可用 provider 名称
     */
    listProviders() {
        const llm = this.getLlmService();
        if (llm) {
            const providers = llm.listProviders();
            if (providers.length > 0) {
                const first = providers[0];
                if (typeof first === 'string')
                    return providers;
                return providers.map((p) => p.id);
            }
        }
        return [];
    }
    // ── 私有方法 ──
    readFromHost() {
        try {
            const agentDefaultModel = this.getService('agentDefaultModel');
            if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
                const selection = agentDefaultModel.currentSelection();
                if (selection?.provider && selection?.model) {
                    return { provider: selection.provider, model: selection.model };
                }
            }
        }
        catch (err) {
            if (this.config.debug) {
                this.logger?.debug(`ModelResolver: host service failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return undefined;
    }
    /** 统一的 Cordis 服务访问（可选获取：服务未注入时静默返回 undefined，避免 Proxy 抛错） */
    getService(name) {
        try {
            const ctxAny = this.ctx;
            return typeof ctxAny.get === 'function' ? ctxAny.get(name) : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** 获取 ctx.llm 服务（最小接口收窄，不可用时返回 undefined） */
    getLlmService() {
        try {
            const llm = this.getService('llm');
            if (llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
                return llm;
            }
        }
        catch (err) {
            this.logger?.warn(`ModelResolver: ctx.llm 服务访问失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        return undefined;
    }
}
