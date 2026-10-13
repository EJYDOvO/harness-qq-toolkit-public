import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskMemoryStore, normalizeTaskId, taskIdFromCwd } from '../lib/store.js'

async function withStore(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-task-memory-test-'))
  try {
    await fn(new TaskMemoryStore(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('normalizeTaskId slugs, lowercases and keeps CJK', () => {
  assert.equal(normalizeTaskId('  Demo Task  '), 'demo-task')
  assert.equal(normalizeTaskId('中文任务'), '中文任务')
  assert.equal(normalizeTaskId('a.b_c-d'), 'a.b_c-d')
  assert.throws(() => normalizeTaskId('!!!'), /no usable characters/)
  assert.throws(() => normalizeTaskId('   '), /non-empty/)
})

test('normalizeTaskId truncates over-long ids with a hash suffix', () => {
  const long = 'x'.repeat(200)
  const id = normalizeTaskId(long)
  assert.ok(id.length <= 120)
  assert.ok(/^x+-[0-9a-f]{8}$/.test(id))
})

test('taskIdFromCwd is stable per cwd and distinct across cwds', () => {
  const a = taskIdFromCwd('/tmp/proj-one')
  const b = taskIdFromCwd('/tmp/proj-one')
  const c = taskIdFromCwd('/tmp/proj-two')
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('remember upserts by key and keeps the entry id', async () => {
  await withStore(async (store) => {
    const first = await store.remember({ taskId: 't', key: 'k', content: 'one' })
    const second = await store.remember({ taskId: 't', key: 'k', content: 'two' })
    assert.equal(first.entry.id, second.entry.id)
    assert.equal(second.entry.content, 'two')
    assert.equal(second.evicted, 0)
    const vault = await store.load('t')
    assert.equal(vault.entries.length, 1)
  })
})

test('tasks are isolated on disk', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 'task-a', key: 'k', content: 'A fact' })
    await store.remember({ taskId: 'task-b', key: 'k', content: 'B fact' })
    const a = await store.load('task-a')
    const b = await store.load('task-b')
    assert.equal(a.entries[0].content, 'A fact')
    assert.equal(b.entries[0].content, 'B fact')
  })
})

test('forget removes a key and reports false for missing keys', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 't', key: 'k', content: 'c' })
    const miss = await store.forget('t', 'nope')
    assert.equal(miss.deleted, false)
    const hit = await store.forget('t', 'k')
    assert.equal(hit.deleted, true)
    assert.equal(hit.vault.entries.length, 0)
  })
})

test('clearTask empties the vault and returns the count', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 't', key: 'a', content: '1' })
    await store.remember({ taskId: 't', key: 'b', content: '2' })
    const { cleared, vault } = await store.clearTask('t')
    assert.equal(cleared, 2)
    assert.equal(vault.entries.length, 0)
  })
})

test('maxEntries evicts oldest non-pinned entries first and never drops pinned', async () => {
  await withStore(async (store) => {
    const t0 = Date.now() - 1000
    await store.remember({ taskId: 't', key: 'pinned', content: 'p', pinned: true })
    await store.remember({ taskId: 't', key: 'old', content: 'o' })
    await store.remember({ taskId: 't', key: 'new', content: 'n' })
    // Force deterministic recency by rewriting timestamps under the lock.
    await store.update('t', (v) => {
      const [pinned, old, newest] = v.entries
      pinned.updatedAt = t0
      old.updatedAt = t0 + 100
      newest.updatedAt = t0 + 200
    })

    const res = await store.remember({ taskId: 't', key: 'extra', content: 'x', maxEntries: 3 })
    assert.equal(res.evicted, 1)
    const after = await store.load('t')
    const keys = after.entries.map((e) => e.key).sort()
    // The oldest non-pinned entry ("old") is dropped; pinned and newer ones stay.
    assert.deepEqual(keys, ['extra', 'new', 'pinned'])
  })
})

test('concurrent remembers to the same task never lose updates', async () => {
  await withStore(async (store) => {
    const total = 25
    await Promise.all(Array.from({ length: total }, (_, i) =>
      store.remember({ taskId: 't', key: `k${i}`, content: `c${i}` })))
    const vault = await store.load('t')
    assert.equal(vault.entries.length, total)
    const keys = new Set(vault.entries.map((e) => e.key))
    for (let i = 0; i < total; i++) assert.ok(keys.has(`k${i}`))
  })
})

test('concurrent mutations across different tasks do not deadlock', async () => {
  await withStore(async (store) => {
    await Promise.all([
      store.remember({ taskId: 'a', key: 'k', content: '1' }),
      store.remember({ taskId: 'b', key: 'k', content: '2' }),
      store.forget('a', 'missing'),
      store.clearTask('b'),
    ])
    const a = await store.load('a')
    const b = await store.load('b')
    assert.equal(a.entries.length, 1)
    assert.equal(b.entries.length, 0)
  })
})

test('setTitle is serialized with remembers and never loses entries', async () => {
  await withStore(async (store) => {
    const writes = Promise.all(Array.from({ length: 10 }, (_, i) =>
      store.remember({ taskId: 't', key: `k${i}`, content: `c${i}` })))
    const titled = store.setTitle('t', 'New Title')
    await Promise.all([writes, titled])
    const vault = await store.load('t')
    assert.equal(vault.title, 'New Title')
    assert.equal(vault.entries.length, 10)
  })
})

test('update RMW is serialized with remembers and never loses entries', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 't', key: 'seed', content: 's' })
    const writes = Promise.all(Array.from({ length: 10 }, (_, i) =>
      store.remember({ taskId: 't', key: `k${i}`, content: `c${i}` })))
    const titled = store.update('t', (vault) => {
      vault.title = 'From update'
    })
    await Promise.all([writes, titled])

    const after = await store.load('t')
    assert.equal(after.title, 'From update')
    // seed + 10 remembers; update reloads inside the lock so inserts survive.
    assert.equal(after.entries.length, 11)
  })
})

test('locked save replaces the vault but does not deadlock with remembers', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 't', key: 'seed', content: 's' })
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) =>
        store.remember({ taskId: 't', key: `k${i}`, content: `c${i}` })),
      (async () => {
        for (let i = 0; i < 8; i++) {
          const v = await store.load('t')
          v.title = `save-${i}`
          await store.save(v)
        }
      })(),
    ])
    // Must settle with a readable vault (lock prevents torn writes).
    const after = await store.load('t')
    assert.ok(after.title.startsWith('save-'))
    assert.ok(after.entries.length >= 1)
  })
})

test('remember rejects non-positive maxEntries instead of disabling the cap', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => store.remember({ taskId: 't', key: 'k', content: 'c', maxEntries: 0 }),
      /maxEntries must be an integer >= 1/,
    )
    await assert.rejects(
      () => store.remember({ taskId: 't', key: 'k', content: 'c', maxEntries: -5 }),
      /maxEntries must be an integer >= 1/,
    )
  })
})

test('remember rejects when the new entry would be evicted immediately', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 't', key: 'p1', content: 'x', pinned: true })
    await store.remember({ taskId: 't', key: 'p2', content: 'x', pinned: true })
    await assert.rejects(
      () => store.remember({ taskId: 't', key: 'new', content: 'y', maxEntries: 2 }),
      /cannot accept a new entry/,
    )
    const vault = await store.load('t')
    assert.equal(vault.entries.length, 2)
    assert.ok(!vault.entries.some((e) => e.key === 'new'))
  })
})

test('remember rejects a pinned write when only pinned entries could be evicted', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 't', key: 'p1', content: 'x', pinned: true })
    await store.remember({ taskId: 't', key: 'p2', content: 'x', pinned: true })
    await assert.rejects(
      () => store.remember({ taskId: 't', key: 'p3', content: 'y', pinned: true, maxEntries: 2 }),
      /cannot accept a new entry/,
    )
  })
})

test('upsert is not blocked by an over-capacity all-pinned vault', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 't', key: 'a', content: 'v1', pinned: true })
    await store.remember({ taskId: 't', key: 'b', content: 'x', pinned: true })
    await store.remember({ taskId: 't', key: 'c', content: 'x', pinned: true })
    // maxEntries lowered below the current size — the vault is already over.
    const res = await store.remember({ taskId: 't', key: 'a', content: 'v2', maxEntries: 2 })
    assert.equal(res.entry.content, 'v2')
    assert.equal(res.evicted, 0)
    const vault = await store.load('t')
    assert.equal(vault.entries.length, 3) // still over capacity — pre-existing state
    const a = vault.entries.find((e) => e.key === 'a')
    assert.equal(a.content, 'v2')
  })
})

test('upsert shrinks an over-capacity vault best-effort but never rejects', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 't', key: 'pin', content: 'p', pinned: true })
    await store.remember({ taskId: 't', key: 'old1', content: 'o1' })
    await store.remember({ taskId: 't', key: 'old2', content: 'o2' })
    const res = await store.remember({ taskId: 't', key: 'pin', content: 'p2', maxEntries: 2 })
    assert.equal(res.evicted, 1)
    const vault = await store.load('t')
    assert.equal(vault.entries.length, 2)
    assert.ok(vault.entries.some((e) => e.key === 'pin' && e.content === 'p2'))
    assert.ok(vault.entries.some((e) => e.key === 'old2'))
    assert.ok(!vault.entries.some((e) => e.key === 'old1'))
  })
})

test('listTasks returns all vaults sorted by recency', async () => {
  await withStore(async (store) => {
    await store.remember({ taskId: 'a', key: 'k', content: '1' })
    await store.remember({ taskId: 'b', key: 'k', content: '2' })
    const tasks = await store.listTasks()
    assert.equal(tasks.length, 2)
    for (const t of tasks) assert.equal(t.count, 1)
    // Most recently updated first.
    assert.ok(tasks[0].updatedAt >= tasks[1].updatedAt)
  })
})

test('cleanupTmp removes only stale tmp files', async () => {
  await withStore(async (store) => {
    const stale = path.join(store.root, 'stale.pid.tmp')
    const fresh = path.join(store.root, 'fresh.pid.tmp')
    await writeFile(stale, 'x')
    await writeFile(fresh, 'x')
    const now = new Date()
    await utimes(stale, now, new Date(now.getTime() - 2 * 60 * 60 * 1000))
    await utimes(fresh, now, now)

    const removed = await store.cleanupTmp()
    assert.equal(removed, 1)
    const { access } = await import('node:fs/promises')
    await assert.rejects(() => access(stale))
    await access(fresh)
  })
})
