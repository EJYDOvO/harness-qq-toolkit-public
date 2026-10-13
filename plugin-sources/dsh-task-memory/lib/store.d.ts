/** One durable memory entry inside a single task vault. */
export interface MemoryEntry {
    readonly id: string;
    /** Short stable label the model can recall by name. */
    readonly key: string;
    readonly content: string;
    readonly tags: readonly string[];
    /** Pinned entries are preferred for prompt injection and are never evicted. */
    readonly pinned: boolean;
    readonly createdAt: number;
    readonly updatedAt: number;
}
/** On-disk vault for one task boundary. */
export interface TaskVault {
    readonly taskId: string;
    title: string;
    updatedAt: number;
    entries: MemoryEntry[];
}
/** Normalize a free-form task label into a filesystem-safe id. */
export declare function normalizeTaskId(raw: string): string;
/** Derive the default task id from a workspace cwd. */
export declare function taskIdFromCwd(cwd: string): string;
/**
 * File-backed store: one JSON vault per task under `$DSH_HOME/storages/task-memory`.
 *
 * Mutations (remember / forget / clearTask / setTitle / save / update) are
 * serialized per task through an in-process async lock: each read-modify-write
 * round runs after the previous one for the same task has settled, so concurrent
 * tool calls from parallel agents cannot lose updates. Reads (load) are lock-free
 * — writes are atomic renames, so a reader always observes a consistent snapshot.
 */
export declare class TaskMemoryStore {
    readonly root: string;
    /** Per-task async lock chains; a key's tail resolves when its last mutation settled. */
    private readonly locks;
    constructor(root?: string);
    private vaultPath;
    ensureRoot(): Promise<void>;
    /** Serialize one mutation for a task behind any in-flight mutation of the same task. */
    private withLock;
    load(taskId: string): Promise<TaskVault>;
    /**
     * Persist a vault snapshot under the per-task lock.
     *
     * This **replaces** the on-disk vault with `vault` as given. For read-modify-write
     * (e.g. tweak one field after a prior `load`), use {@link update} instead so the
     * mutate runs against a fresh snapshot inside the same critical section.
     */
    save(vault: TaskVault): Promise<void>;
    /**
     * Read-modify-write under the per-task lock. Prefer this over
     * `load` → mutate → {@link save}, which can clobber concurrent writes even when
     * `save` itself is locked.
     */
    update(taskId: string, mutate: (vault: TaskVault) => void | Promise<void>): Promise<TaskVault>;
    /** Atomic write; caller must already hold the per-task lock. */
    private writeVault;
    listTasks(): Promise<Array<{
        taskId: string;
        title: string;
        count: number;
        updatedAt: number;
    }>>;
    /**
     * Remove stale `*.tmp` files left behind by crashed saves. Only files older
     * than `maxAgeMs` are touched, so another live process's in-flight write
     * (its tmp name embeds its own pid) is never deleted mid-rename.
     */
    cleanupTmp(maxAgeMs?: number): Promise<number>;
    remember(input: {
        taskId: string;
        key: string;
        content: string;
        tags?: string[];
        pinned?: boolean;
        title?: string;
        /** Vault cap (>= 1); when exceeded, oldest non-pinned entries are evicted first. */
        maxEntries?: number;
    }): Promise<{
        entry: MemoryEntry;
        vault: TaskVault;
        evicted: number;
    }>;
    forget(taskId: string, key: string): Promise<{
        deleted: boolean;
        vault: TaskVault;
    }>;
    clearTask(taskId: string): Promise<{
        cleared: number;
        vault: TaskVault;
    }>;
    /**
     * Set a vault's human title. Runs under the same per-task lock as the other
     * mutations, so it can never overwrite entries written concurrently by
     * another agent (unlike an unlocked load → mutate → save).
     */
    setTitle(taskId: string, title: string): Promise<TaskVault>;
}
