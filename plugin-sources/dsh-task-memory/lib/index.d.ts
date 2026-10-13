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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "task-memory";
export declare const inject: string[];
export interface Config {
    /** Max memories injected into the system prompt for the active task. */
    injectLimit?: number;
    /** Soft character budget for the injected memory block. */
    injectMaxChars?: number;
    /** When true, inject pinned + recent memories for the active task (per agent). */
    injectPrompt?: boolean;
    /** Per-entry character cap inside the injected block (content is truncated). */
    injectMaxEntryChars?: number;
    /** Max entries per vault (>= 1); oldest non-pinned entries are evicted first on overflow. */
    maxEntries?: number;
    /** Optional override for the on-disk vault root. */
    storageRoot?: string;
}
export declare const Config: z<Config>;
/**
 * Register memory tools and optional per-agent system-prompt injection.
 * @param ctx - Cordis context with tools + systemPrompt.
 * @param config - plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
