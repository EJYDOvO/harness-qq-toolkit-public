import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** One durable memory entry inside a single task vault. */
export interface MemoryEntry {
  readonly id: string
  /** Short stable label the model can recall by name. */
  readonly key: string
  readonly content: string
  readonly tags: readonly string[]
  /** Pinned entries are preferred for prompt injection and are never evicted. */
  readonly pinned: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** On-disk vault for one task boundary. */
export interface TaskVault {
  readonly taskId: string
  title: string
  updatedAt: number
  entries: MemoryEntry[]
}

/** Normalize a free-form task label into a filesystem-safe id. */
export function normalizeTaskId(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) throw new Error('taskId must be a non-empty string')
  const slug = trimmed
    .replace(/[^a-z0-9\u4e00-\u9fff._-]+/giu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) throw new Error(`taskId ${JSON.stringify(raw)} has no usable characters`)
  if (slug.length > 120) return `${slug.slice(0, 100)}-${hashShort(slug)}`
  return slug
}

/** Derive the default task id from a workspace cwd. */
export function taskIdFromCwd(cwd: string): string {
  const resolved = path.resolve(cwd)
  const base = path.basename(resolved) || 'workspace'
  return normalizeTaskId(`${base}-${hashShort(resolved)}`)
}

function hashShort(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

/**
 * File-backed store: one JSON vault per task under `$DSH_HOME/storages/task-memory`.
 *
 * Mutations (remember / forget / clearTask / setTitle / save / update) are
 * serialized per task through an in-process async lock: each read-modify-write
 * round runs after the previous one for the same task has settled, so concurrent
 * tool calls from parallel agents cannot lose updates. Reads (load) are lock-free
 * — writes are atomic renames, so a reader always observes a consistent snapshot.
 */
export class TaskMemoryStore {
  readonly root: string

  /** Per-task async lock chains; a key's tail resolves when its last mutation settled. */
  private readonly locks = new Map<string, Promise<void>>()

  constructor(root?: string) {
    this.root = root ?? path.join(resolveDshHome(), 'storages', 'task-memory')
  }

  private vaultPath(taskId: string): string {
    return path.join(this.root, `${normalizeTaskId(taskId)}.json`)
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  /** Serialize one mutation for a task behind any in-flight mutation of the same task. */
  private async withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(taskId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.catch(() => undefined).then(() => gate)
    this.locks.set(taskId, tail)
    await prev.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      // Drop our tail only if it is still the latest, so a waiter that queued
      // behind us keeps the chain alive until it settles too.
      if (this.locks.get(taskId) === tail) this.locks.delete(taskId)
    }
  }

  async load(taskId: string): Promise<TaskVault> {
    const id = normalizeTaskId(taskId)
    await this.ensureRoot()
    const file = this.vaultPath(id)
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as TaskVault
      if (parsed.taskId !== id || !Array.isArray(parsed.entries)) {
        throw new Error(`corrupt vault for task ${id}`)
      }
      return {
        taskId: id,
        title: typeof parsed.title === 'string' ? parsed.title : id,
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        entries: parsed.entries.map(normalizeEntry),
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { taskId: id, title: id, updatedAt: Date.now(), entries: [] }
      }
      throw error
    }
  }

  /**
   * Persist a vault snapshot under the per-task lock.
   *
   * This **replaces** the on-disk vault with `vault` as given. For read-modify-write
   * (e.g. tweak one field after a prior `load`), use {@link update} instead so the
   * mutate runs against a fresh snapshot inside the same critical section.
   */
  async save(vault: TaskVault): Promise<void> {
    const id = normalizeTaskId(vault.taskId)
    return this.withLock(id, () => this.writeVault(vault))
  }

  /**
   * Read-modify-write under the per-task lock. Prefer this over
   * `load` → mutate → {@link save}, which can clobber concurrent writes even when
   * `save` itself is locked.
   */
  async update(
    taskId: string,
    mutate: (vault: TaskVault) => void | Promise<void>,
  ): Promise<TaskVault> {
    const id = normalizeTaskId(taskId)
    return this.withLock(id, async () => {
      const vault = await this.load(id)
      await mutate(vault)
      await this.writeVault(vault)
      return vault
    })
  }

  /** Atomic write; caller must already hold the per-task lock. */
  private async writeVault(vault: TaskVault): Promise<void> {
    await this.ensureRoot()
    const id = normalizeTaskId(vault.taskId)
    const file = this.vaultPath(id)
    const tmp = `${file}.${process.pid}.tmp`
    const now = Date.now()
    vault.updatedAt = now
    const payload: TaskVault = {
      taskId: id,
      title: vault.title,
      updatedAt: now,
      entries: vault.entries,
    }
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  async listTasks(): Promise<Array<{ taskId: string; title: string; count: number; updatedAt: number }>> {
    await this.ensureRoot()
    const names = (await readdir(this.root)).filter((name) => name.endsWith('.json'))
    const vaults = await Promise.all(names.map((name) => this.load(name.slice(0, -'.json'.length))))
    const out = vaults.map((vault) => ({
      taskId: vault.taskId,
      title: vault.title,
      count: vault.entries.length,
      updatedAt: vault.updatedAt,
    }))
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  }

  /**
   * Remove stale `*.tmp` files left behind by crashed saves. Only files older
   * than `maxAgeMs` are touched, so another live process's in-flight write
   * (its tmp name embeds its own pid) is never deleted mid-rename.
   */
  async cleanupTmp(maxAgeMs = 60 * 60 * 1000): Promise<number> {
    await this.ensureRoot()
    const now = Date.now()
    let removed = 0
    const names = await readdir(this.root)
    await Promise.all(names.map(async (name) => {
      if (!name.endsWith('.tmp')) return
      const file = path.join(this.root, name)
      try {
        const info = await stat(file)
        if (now - info.mtimeMs > maxAgeMs) {
          await rm(file, { force: true })
          removed++
        }
      } catch {
        // Raced with a writer or the file is gone; leave it alone.
      }
    }))
    return removed
  }

  async remember(input: {
    taskId: string
    key: string
    content: string
    tags?: string[]
    pinned?: boolean
    title?: string
    /** Vault cap (>= 1); when exceeded, oldest non-pinned entries are evicted first. */
    maxEntries?: number
  }): Promise<{ entry: MemoryEntry; vault: TaskVault; evicted: number }> {
    const id = normalizeTaskId(input.taskId)
    if (input.maxEntries !== undefined) assertMaxEntries(input.maxEntries)
    return this.withLock(id, async () => {
      const key = sanitizeKey(input.key)
      const content = input.content.trim()
      if (!content) throw new Error('content must be a non-empty string')
      const vault = await this.load(id)
      if (input.title?.trim()) vault.title = input.title.trim()
      const now = Date.now()
      const tags = uniqueTags(input.tags ?? [])
      const existing = vault.entries.findIndex((e) => e.key === key)
      let entry: MemoryEntry
      if (existing >= 0) {
        const prev = vault.entries[existing]!
        entry = {
          id: prev.id,
          key,
          content,
          tags,
          pinned: input.pinned ?? prev.pinned,
          createdAt: prev.createdAt,
          updatedAt: now,
        }
        vault.entries[existing] = entry
      } else {
        entry = {
          id: `m_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          key,
          content,
          tags,
          pinned: input.pinned ?? false,
          createdAt: now,
          updatedAt: now,
        }
        vault.entries.push(entry)
      }

      let evicted = 0
      const max = input.maxEntries
      if (typeof max === 'number' && vault.entries.length > max) {
        const need = vault.entries.length - max
        // Pinned entries are never evicted; only the oldest non-pinned ones go,
        // and never the entry this call just wrote.
        const victims = vault.entries
          .filter((e) => !e.pinned && e.id !== entry.id)
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, need)
        if (existing >= 0) {
          // Upsert of an existing key: never reject for capacity. The vault may
          // already be over max (lowered maxEntries / hand-edited file) — shrink
          // as far as removable non-pinned entries allow and keep the update.
          const victimIds = new Set(victims.map((v) => v.id))
          vault.entries = vault.entries.filter((e) => !victimIds.has(e.id))
          evicted = victims.length
        } else {
          // New key: it must survive and the cap must hold afterwards.
          if (victims.length < need) {
            throw new Error(
              `vault ${JSON.stringify(id)} cannot accept a new entry (maxEntries=${max}): `
              + 'pinned entries are never evicted and there are not enough removable '
              + 'non-pinned entries; forget or unpin an entry first',
            )
          }
          const victimIds = new Set(victims.map((v) => v.id))
          vault.entries = vault.entries.filter((e) => !victimIds.has(e.id))
          evicted = victims.length
        }
      }

      vault.updatedAt = now
      await this.writeVault(vault)
      return { entry, vault, evicted }
    })
  }

  async forget(taskId: string, key: string): Promise<{ deleted: boolean; vault: TaskVault }> {
    const id = normalizeTaskId(taskId)
    return this.withLock(id, async () => {
      const vault = await this.load(id)
      const before = vault.entries.length
      const k = sanitizeKey(key)
      vault.entries = vault.entries.filter((e) => e.key !== k)
      const deleted = vault.entries.length !== before
      if (deleted) {
        vault.updatedAt = Date.now()
        await this.writeVault(vault)
      }
      return { deleted, vault }
    })
  }

  async clearTask(taskId: string): Promise<{ cleared: number; vault: TaskVault }> {
    const id = normalizeTaskId(taskId)
    return this.withLock(id, async () => {
      const vault = await this.load(id)
      const cleared = vault.entries.length
      vault.entries = []
      vault.updatedAt = Date.now()
      await this.writeVault(vault)
      return { cleared, vault }
    })
  }

  /**
   * Set a vault's human title. Runs under the same per-task lock as the other
   * mutations, so it can never overwrite entries written concurrently by
   * another agent (unlike an unlocked load → mutate → save).
   */
  async setTitle(taskId: string, title: string): Promise<TaskVault> {
    const id = normalizeTaskId(taskId)
    return this.withLock(id, async () => {
      const vault = await this.load(id)
      vault.title = title.trim()
      await this.writeVault(vault)
      return vault
    })
  }
}

function assertMaxEntries(maxEntries: number): void {
  if (!Number.isFinite(maxEntries) || maxEntries < 1 || !Number.isInteger(maxEntries)) {
    throw new Error(`maxEntries must be an integer >= 1, got ${maxEntries}`)
  }
}

function sanitizeKey(raw: string): string {
  const key = raw.trim()
  if (!key) throw new Error('key must be a non-empty string')
  if (key.length > 120) throw new Error('key must be at most 120 characters')
  return key
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const t = tag.trim().toLowerCase()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function normalizeEntry(raw: MemoryEntry): MemoryEntry {
  return {
    id: String(raw.id),
    key: String(raw.key),
    content: String(raw.content),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    pinned: Boolean(raw.pinned),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
}
