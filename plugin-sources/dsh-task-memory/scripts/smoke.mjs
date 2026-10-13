import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TaskMemoryStore } from '../lib/store.js'
import { searchEntries } from '../lib/search.js'

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-task-memory-'))
  try {
    const store = new TaskMemoryStore(root)
    await store.remember({
      taskId: 'task-a',
      key: 'note-1',
      content: '任务 A 的中文记忆内容',
      tags: ['tag-a'],
      pinned: true,
    })
    await store.remember({
      taskId: 'task-a',
      key: 'note-2',
      content: '另一条同任务记忆',
    })
    await store.remember({
      taskId: 'task-b',
      key: 'note-1',
      content: '仅属于任务 B 的记忆',
    })

    const vault = await store.load('task-a')
    const hits = searchEntries(vault.entries, '中文')
    if (hits.length !== 1 || hits[0]?.entry.key !== 'note-1') {
      throw new Error(`expected Chinese search hit, got ${JSON.stringify(hits)}`)
    }

    const other = await store.load('task-b')
    if (other.entries.some(e => e.content.includes('任务 A 的中文'))) {
      throw new Error('isolation broken: task-a fact leaked into task-b')
    }

    const listed = await store.listTasks()
    if (listed.length !== 2) throw new Error(`expected 2 tasks, got ${listed.length}`)

    // Upsert keeps a single entry; forget removes it.
    const up = await store.remember({ taskId: 'task-a', key: 'note-1', content: '更新后的内容' })
    if (up.vault.entries.length !== 2) throw new Error('upsert duplicated the entry')
    const { deleted } = await store.forget('task-a', 'note-2')
    if (!deleted) throw new Error('forget did not delete note-2')

    // Stale tmp cleanup (backdate so it counts as a crashed write).
    const stale = path.join(root, 'crashed.pid.tmp')
    await writeFile(stale, 'partial')
    const now = new Date()
    await utimes(stale, now, new Date(now.getTime() - 2 * 60 * 60 * 1000))
    const removed = await store.cleanupTmp()
    if (removed !== 1) throw new Error(`expected 1 stale tmp removed, got ${removed}`)

    console.log('ok: isolation + Chinese search + upsert/forget + tmp cleanup')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
