/**
 * Integration tests: apply() on a real Cordis context with the real
 * SystemPrompt + ToolRuntime services, driving the tools through the actual
 * execution pipeline and assembling prompts per agent scope.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { apply } from '../lib/index.js'

let callSeq = 0

async function setup(config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-task-memory-int-'))
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, {})
  apply(ctx, { storageRoot: root, ...config })
  return { ctx, root }
}

function makeAgent(ctx, id, cwd) {
  const { ctx: agentCtx } = createScope(ctx, {})
  return {
    agent: { id, session: { id, header: { cwd } }, ctx: agentCtx },
    scopeKey: scopeOf(agentCtx),
  }
}

function run(ctx, agent, name, args) {
  return ctx.tools.execute({
    callId: `call-${callSeq++}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent,
  })
}

function contextText(assembly) {
  return assembly.contexts.map((c) => c.text).join('\n')
}

test('bind → current → dispose lifecycle works end to end', async (t) => {
  const { ctx, root } = await setup()
  const { agent } = makeAgent(ctx, 'sess-a', '/tmp/projA')
  t.after(async () => {
    await ctx.emit('agent/disposed', { agent })
    await rm(root, { recursive: true, force: true })
  })

  // Unbound tools fall back to the cwd-derived default task.
  const remembered = await run(ctx, agent, 'memory_remember', { key: 'k', content: 'fact' })
  assert.equal(remembered.isError, false)
  const defaultTask = remembered.value.taskId
  assert.match(defaultTask, /^proja-[0-9a-f]{8}$/)

  const bound = await run(ctx, agent, 'memory_bind_task', { taskId: 'proj-x', title: 'Project X' })
  assert.equal(bound.value.taskId, 'proj-x')
  assert.equal(bound.value.title, 'Project X')

  const current = await run(ctx, agent, 'memory_current_task', {})
  assert.equal(current.value.source, 'binding')
  assert.equal(current.value.taskId, 'proj-x')

  // Dispose must drop the binding (P2 fix), falling back to the default task.
  await ctx.emit('agent/disposed', { agent })
  const after = await run(ctx, agent, 'memory_current_task', {})
  assert.equal(after.value.source, 'default')
  assert.equal(after.value.taskId, defaultTask)
})

test('bindings are cleaned up on dispose even when injectPrompt=false', async (t) => {
  const { ctx, root } = await setup({ injectPrompt: false })
  const { agent } = makeAgent(ctx, 'sess-b', '/tmp/projB')
  t.after(async () => {
    await ctx.emit('agent/disposed', { agent })
    await rm(root, { recursive: true, force: true })
  })

  await run(ctx, agent, 'memory_bind_task', { taskId: 'proj-y' })
  const before = await run(ctx, agent, 'memory_current_task', {})
  assert.equal(before.value.source, 'binding')

  await ctx.emit('agent/disposed', { agent })
  const after = await run(ctx, agent, 'memory_current_task', {})
  assert.equal(after.value.source, 'default')
})

test('bind with a title never loses stored memories', async (t) => {
  const { ctx, root } = await setup()
  const { agent } = makeAgent(ctx, 'sess-c', '/tmp/projC')
  t.after(async () => {
    await ctx.emit('agent/disposed', { agent })
    await rm(root, { recursive: true, force: true })
  })

  await run(ctx, agent, 'memory_bind_task', { taskId: 'task-c', title: 'First title' })
  await run(ctx, agent, 'memory_remember', { key: 'k1', content: 'c1' })
  // Rebinding with a new title must go through the per-task lock and keep entries.
  await run(ctx, agent, 'memory_bind_task', { taskId: 'task-c', title: 'Second title' })
  const recall = await run(ctx, agent, 'memory_recall', { key: 'k1' })
  assert.equal(recall.value.found, true)
  assert.equal(recall.value.entry.content, 'c1')
  const current = await run(ctx, agent, 'memory_current_task', {})
  assert.equal(current.value.title, 'Second title')
})

test('prompt injection is isolated per agent scope', async (t) => {
  const { ctx, root } = await setup()
  const a = makeAgent(ctx, 'sess-a1', '/tmp/projA')
  const b = makeAgent(ctx, 'sess-b1', '/tmp/projB')
  t.after(async () => {
    await ctx.emit('agent/disposed', { agent: a.agent })
    await ctx.emit('agent/disposed', { agent: b.agent })
    await rm(root, { recursive: true, force: true })
  })

  await ctx.emit('agent/created', { agent: a.agent })
  await ctx.emit('agent/created', { agent: b.agent })

  // Agent A stores a fact in its own bound task.
  await run(ctx, a.agent, 'memory_bind_task', { taskId: 'task-a' })
  await run(ctx, a.agent, 'memory_remember', { key: 'k', content: 'A secret fact' })

  // A's assembly shows exactly its own task's memories.
  const aText = contextText(await ctx.systemPrompt.assemble({ scope: a.scopeKey }))
  assert.ok(aText.includes('task-a'))
  assert.ok(aText.includes('A secret fact'))

  // B's assembly must not show A's task or its facts.
  const bText = contextText(await ctx.systemPrompt.assemble({ scope: b.scopeKey }))
  assert.ok(!bText.includes('A secret fact'))
  assert.ok(!bText.includes('task-a'))
})

test('eviction is surfaced through the remember tool', async (t) => {
  const { ctx, root } = await setup({ maxEntries: 2 })
  const { agent } = makeAgent(ctx, 'sess-d', '/tmp/projD')
  t.after(async () => {
    await ctx.emit('agent/disposed', { agent })
    await rm(root, { recursive: true, force: true })
  })

  await run(ctx, agent, 'memory_bind_task', { taskId: 'task-d' })
  await run(ctx, agent, 'memory_remember', { key: 'old', content: 'first' })
  const res = await run(ctx, agent, 'memory_remember', { key: 'new', content: 'second' })
  assert.equal(res.value.evicted, 0)
  const over = await run(ctx, agent, 'memory_remember', { key: 'third', content: 'third' })
  assert.equal(over.value.evicted, 1)
  const recallOld = await run(ctx, agent, 'memory_recall', { key: 'old' })
  assert.equal(recallOld.value.found, false)
  const recallThird = await run(ctx, agent, 'memory_recall', { key: 'third' })
  assert.equal(recallThird.value.found, true)
})
