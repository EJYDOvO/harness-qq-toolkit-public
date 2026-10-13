import { renderStoredMemory } from './render.js';
/**
 * Task-isolated memory for DeepSeek Harness.
 *
 * Isolation model: every remember/recall/search call is bound to one `taskId`.
 * The default task is derived from the session cwd (or process.cwd()). The model
 * can rebind the current session with `memory_bind_task`. Memories never cross
 * task boundaries unless the caller deliberately switches tasks.
 *
 * Prompt injection is registered per agent (agent-scoped `systemPrompt.context`),
 * so each session's system prompt shows exactly its own task's memories — never
 * the "last bound" session of the process.
 *
 * @module dsh-task-memory
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TaskMemoryStore, normalizeTaskId, taskIdFromCwd } from './store.js';
import { renderInjectBlock, searchEntries } from './search.js';
export const name = 'task-memory';
export const inject = ['tools', 'systemPrompt'];
export const Config = z.object({
    injectLimit: z.number().default(8),
    injectMaxChars: z.number().default(2400),
    injectPrompt: z.boolean().default(true),
    injectMaxEntryChars: z.number().default(400),
    maxEntries: z.number().min(1).default(500),
    storageRoot: z.string().default(''),
});
/** Derive the default task id from a workspace cwd. */
function resolveDefaultTaskId(cwd) {
    return taskIdFromCwd(cwd ?? process.cwd());
}
function sessionMeta(exec) {
    const session = exec.agent?.session;
    if (!session)
        return {};
    return { sessionId: session.id, cwd: session.header.cwd };
}
function entryView(entry) {
    return {
        id: entry.id,
        key: entry.key,
        content: entry.content,
        tags: [...entry.tags],
        pinned: entry.pinned,
        updatedAt: entry.updatedAt,
    };
}
const entryOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        key: { type: 'string', required: true },
        content: { type: 'string', required: true },
        tags: { type: 'array', required: true, items: { type: 'string' } },
        pinned: { type: 'boolean', required: true },
        updatedAt: { type: 'integer', required: true },
    },
};
/**
 * Register memory tools and optional per-agent system-prompt injection.
 * @param ctx - Cordis context with tools + systemPrompt.
 * @param config - plugin configuration.
 */
export function apply(ctx, config) {
    /** Session id → explicit task binding, owned by this plugin instance. */
    const sessionTask = new Map();
    /** Prompt cache for sync assembly: taskId → vault snapshot, per instance. */
    const promptCache = new Map();
    const resolveTaskId = (taskId, sessionId, cwd) => {
        if (taskId?.trim())
            return normalizeTaskId(taskId);
        if (sessionId && sessionTask.has(sessionId))
            return sessionTask.get(sessionId);
        return resolveDefaultTaskId(cwd);
    };
    const store = new TaskMemoryStore(config.storageRoot?.trim() ? config.storageRoot : undefined);
    const injectLimit = config.injectLimit ?? 8;
    const injectMaxChars = config.injectMaxChars ?? 2400;
    const injectMaxEntryChars = config.injectMaxEntryChars ?? 400;
    const injectPrompt = config.injectPrompt ?? true;
    const maxEntries = config.maxEntries ?? 500;
    ctx.effect(() => () => {
        sessionTask.clear();
        promptCache.clear();
    });
    ctx.systemPrompt.section({
        name: 'task-memory:guidance',
        order: 120,
        text: 'Task memory tools are available. Memories are isolated by taskId: '
            + 'facts from one task must not be applied to another. '
            + 'Call memory_bind_task at the start of focused work, then '
            + 'memory_remember / memory_recall / memory_search / memory_forget as needed. '
            + 'Use memory_current_task to check the active vault, memory_list_tasks to discover vaults.',
    });
    /** Update the prompt cache from an in-memory vault; a no-op when injection is off. */
    const setCache = (taskId, vault) => {
        if (injectPrompt)
            promptCache.set(taskId, { title: vault.title, entries: vault.entries });
    };
    const refreshCache = async (taskId) => {
        if (!injectPrompt)
            return;
        const vault = await store.load(taskId);
        promptCache.set(taskId, { title: vault.title, entries: vault.entries });
    };
    const taskIdOfAgent = (agent) => sessionTask.get(agent.id) ?? resolveDefaultTaskId(agent.session.header.cwd);
    /** Register this agent's own memory context and warm its default task cache. */
    const registerAgentInjection = (agent) => {
        agent.ctx.systemPrompt.context({
            name: 'task-memory',
            order: 50,
            text: () => {
                const taskId = taskIdOfAgent(agent);
                const cached = promptCache.get(taskId);
                if (!cached)
                    return '';
                return renderInjectBlock(taskId, cached.title, cached.entries, injectLimit, injectMaxChars, injectMaxEntryChars);
            },
        });
        void refreshCache(taskIdOfAgent(agent)).catch(() => undefined);
    };
    if (injectPrompt) {
        ctx.on('agent/created', ({ agent }) => registerAgentInjection(agent));
        // Cover agents that already exist when this plugin (re)loads. New agents are
        // handled by agent/created; if the agents service is not up yet, skip.
        try {
            for (const agent of ctx.agents.list())
                registerAgentInjection(agent);
        }
        catch {
            // agents service unavailable at this point — nothing to do.
        }
    }
    // Bindings are consulted by the tools regardless of prompt injection, so the
    // cleanup must run even when injectPrompt is off — otherwise bindings leak as
    // agents are disposed and a reused session id could resolve to a stale vault.
    ctx.on('agent/disposed', ({ agent }) => {
        // Agent-scoped registrations unwind on disposal by themselves; only this
        // instance's binding map needs explicit cleanup.
        sessionTask.delete(agent.id);
    });
    // Housekeeping: drop stale tmp files from crashed saves, warm the process-cwd cache.
    void store.cleanupTmp().catch(() => undefined);
    void refreshCache(resolveDefaultTaskId(process.cwd())).catch(() => undefined);
    ctx.tools.register(defineTool({
        name: 'memory_bind_task',
        description: 'Bind the CURRENT session to a task memory vault. All later memory tools '
            + 'default to this taskId until rebound. Use a short stable name per project '
            + 'or feature. Isolation is the point: '
            + 'facts from other tasks will not leak in.',
        parameters: {
            taskId: {
                type: 'string',
                required: true,
                description: 'Task id / label to bind for this session.',
            },
            title: {
                type: 'string',
                description: 'Optional human title for the task vault.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    entryCount: { type: 'integer', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Bound session to task "${value.taskId}" (${value.entryCount} memories).`,
                }],
        },
        async execute(args, exec) {
            const { sessionId } = sessionMeta(exec);
            if (!sessionId)
                throw new Error('memory_bind_task requires an owning agent session');
            const taskId = normalizeTaskId(args.taskId);
            sessionTask.set(sessionId, taskId);
            // Title updates go through the store's per-task lock so they can never
            // overwrite entries written concurrently by another agent.
            const vault = typeof args.title === 'string' && args.title.trim()
                ? await store.setTitle(taskId, args.title.trim())
                : await store.load(taskId);
            setCache(taskId, vault);
            return { taskId, title: vault.title, entryCount: vault.entries.length };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory_current_task',
        description: 'Show the task vault this session is currently on: the explicit '
            + 'memory_bind_task binding, or the cwd-derived default. Read-only; never rebinds.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    entryCount: { type: 'integer', required: true },
                    source: { type: 'string', required: true, enum: ['binding', 'default'] },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Session is on task "${value.taskId}" (${value.entryCount} memories, ${value.source}).`,
                }],
        },
        async execute(_args, exec) {
            const meta = sessionMeta(exec);
            if (!meta.sessionId)
                throw new Error('memory_current_task requires an owning agent session');
            const bound = sessionTask.has(meta.sessionId);
            const taskId = resolveTaskId(undefined, meta.sessionId, meta.cwd);
            const vault = await store.load(taskId);
            setCache(taskId, vault);
            const source = bound ? 'binding' : 'default';
            return {
                taskId,
                title: vault.title,
                entryCount: vault.entries.length,
                source,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory_remember',
        description: 'Store or update one fact in the ACTIVE task vault (upsert by key). '
            + 'Never write secrets. Keep content concise and reusable across sessions '
            + 'of the SAME task only.',
        parameters: {
            key: {
                type: 'string',
                required: true,
                description: 'Short stable key for this fact.',
            },
            content: {
                type: 'string',
                required: true,
                description: 'The fact to remember.',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tags for search.',
            },
            pinned: {
                type: 'boolean',
                description: 'Pin for prompt injection priority.',
            },
            taskId: {
                type: 'string',
                description: 'Override task vault. Defaults to the session binding / cwd task.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    entry: { ...entryOutputSchema, required: true },
                    evicted: { type: 'integer', description: 'Entries dropped by the vault cap, when any.' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.evicted
                        ? `Remembered "${value.entry.key}" in task ${value.taskId} (evicted ${value.evicted} old entries).`
                        : `Remembered "${value.entry.key}" in task ${value.taskId}.`,
                }],
        },
        async execute(args, exec) {
            const meta = sessionMeta(exec);
            const taskId = resolveTaskId(typeof args.taskId === 'string' ? args.taskId : undefined, meta.sessionId, meta.cwd);
            const tags = Array.isArray(args.tags)
                ? args.tags.filter((t) => typeof t === 'string')
                : undefined;
            const { entry, vault, evicted } = await store.remember({
                taskId,
                key: args.key,
                content: args.content,
                tags,
                pinned: typeof args.pinned === 'boolean' ? args.pinned : undefined,
                maxEntries,
            });
            setCache(taskId, vault);
            return { taskId, entry: entryView(entry), evicted };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory_recall',
        description: 'Recall one memory by exact key from the ACTIVE task vault. '
            + 'Returns found=false when the key is absent in this task (other tasks are invisible).',
        parameters: {
            key: { type: 'string', required: true, description: 'Exact memory key.' },
            taskId: {
                type: 'string',
                description: 'Override task vault.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    found: { type: 'boolean', required: true },
                    entry: entryOutputSchema,
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: value.found && value.entry
                        ? renderStoredMemory(value)
                        : `No memory "${args.key}" in task ${value.taskId}.`,
                }],
        },
        async execute(args, exec) {
            const meta = sessionMeta(exec);
            const taskId = resolveTaskId(typeof args.taskId === 'string' ? args.taskId : undefined, meta.sessionId, meta.cwd);
            const vault = await store.load(taskId);
            setCache(taskId, vault);
            const entry = vault.entries.find((e) => e.key === args.key.trim());
            if (!entry)
                return { taskId, found: false };
            return { taskId, found: true, entry: entryView(entry) };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory_search',
        description: 'Search memories INSIDE the ACTIVE task vault (Chinese/English keyword match). '
            + 'Does not search other tasks. Empty query returns pinned/recent entries.',
        parameters: {
            query: {
                type: 'string',
                required: true,
                description: 'Search query. Empty string lists recent/pinned entries.',
            },
            limit: {
                type: 'integer',
                description: 'Max hits (default 10).',
            },
            taskId: {
                type: 'string',
                description: 'Override task vault.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    hits: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                score: { type: 'number', required: true },
                                id: { type: 'string', required: true },
                                key: { type: 'string', required: true },
                                content: { type: 'string', required: true },
                                tags: { type: 'array', required: true, items: { type: 'string' } },
                                pinned: { type: 'boolean', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.hits.length === 0
                        ? `No hits in task ${value.taskId}.`
                        : renderStoredMemory(value),
                }],
        },
        async execute(args, exec) {
            const meta = sessionMeta(exec);
            const taskId = resolveTaskId(typeof args.taskId === 'string' ? args.taskId : undefined, meta.sessionId, meta.cwd);
            const vault = await store.load(taskId);
            setCache(taskId, vault);
            const limit = typeof args.limit === 'number' ? args.limit : 10;
            const hits = searchEntries(vault.entries, args.query, limit);
            return {
                taskId,
                hits: hits.map((h) => ({
                    score: h.score,
                    id: h.entry.id,
                    key: h.entry.key,
                    content: h.entry.content,
                    tags: [...h.entry.tags],
                    pinned: h.entry.pinned,
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory_forget',
        description: 'Delete one memory by key from the ACTIVE task vault.',
        parameters: {
            key: { type: 'string', required: true, description: 'Exact memory key to delete.' },
            taskId: {
                type: 'string',
                description: 'Override task vault.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    deleted: { type: 'boolean', required: true },
                },
            },
            render: (args, value) => [{
                    type: 'text',
                    text: value.deleted
                        ? `Forgot "${args.key}" in task ${value.taskId}.`
                        : `Nothing to forget for "${args.key}" in task ${value.taskId}.`,
                }],
        },
        async execute(args, exec) {
            const meta = sessionMeta(exec);
            const taskId = resolveTaskId(typeof args.taskId === 'string' ? args.taskId : undefined, meta.sessionId, meta.cwd);
            const { deleted, vault } = await store.forget(taskId, args.key);
            setCache(taskId, vault);
            return { taskId, deleted };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory_list_tasks',
        description: 'List known task vaults and how many memories each holds. '
            + 'Use this before switching tasks with memory_bind_task.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tasks: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                taskId: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                count: { type: 'integer', required: true },
                                updatedAt: { type: 'integer', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.tasks.length === 0
                        ? 'No task vaults yet.'
                        : value.tasks.map((t) => `${t.taskId} (${t.count})`).join(', '),
                }],
        },
        async execute() {
            const tasks = await store.listTasks();
            return { tasks };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory_clear_task',
        description: 'Delete ALL memories in one task vault. Irreversible. '
            + 'Requires the explicit taskId (never silently clears the default).',
        parameters: {
            taskId: {
                type: 'string',
                required: true,
                description: 'Task vault to clear.',
            },
            confirm: {
                type: 'boolean',
                required: true,
                description: 'Must be true to proceed.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taskId: { type: 'string', required: true },
                    cleared: { type: 'integer', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Cleared ${value.cleared} memories from task ${value.taskId}.`,
                }],
        },
        async execute(args) {
            if (args.confirm !== true)
                throw new Error('memory_clear_task requires confirm=true');
            const taskId = normalizeTaskId(args.taskId);
            const { cleared, vault } = await store.clearTask(taskId);
            setCache(taskId, vault);
            return { taskId, cleared };
        },
    }));
}
