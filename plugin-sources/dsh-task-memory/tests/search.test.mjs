import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchEntries, renderInjectBlock } from '../lib/search.js'

function entry(overrides = {}) {
  return {
    id: 'm_1',
    key: 'k',
    content: 'c',
    tags: [],
    pinned: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

test('exact key match ranks above substring matches', () => {
  const entries = [
    entry({ id: '1', key: 'alpha-beta', content: 'mentions alpha', updatedAt: 1 }),
    entry({ id: '2', key: 'alpha', content: 'exact', updatedAt: 2 }),
  ]
  const hits = searchEntries(entries, 'alpha')
  assert.equal(hits[0].entry.id, '2')
  assert.ok(hits[0].score > hits[1].score)
})

test('Chinese bigram search matches content', () => {
  const entries = [
    entry({ id: '1', key: 'note-1', content: '任务 A 的中文记忆内容' }),
    entry({ id: '2', key: 'note-2', content: '另一条同任务记忆' }),
  ]
  const hits = searchEntries(entries, '中文')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entry.id, '1')
})

test('empty query lists pinned first, then recency', () => {
  const entries = [
    entry({ id: 'old', key: 'old', updatedAt: 100 }),
    entry({ id: 'pin', key: 'pin', pinned: true, updatedAt: 50 }),
    entry({ id: 'new', key: 'new', updatedAt: 200 }),
  ]
  const hits = searchEntries(entries, '', 10)
  assert.deepEqual(hits.map((h) => h.entry.id), ['pin', 'new', 'old'])
})

test('tag matches contribute to scoring', () => {
  const entries = [
    entry({ id: 'tagged', key: 'k1', content: 'x', tags: ['deploy'] }),
    entry({ id: 'plain', key: 'k2', content: 'x' }),
  ]
  const hits = searchEntries(entries, 'deploy')
  assert.equal(hits[0].entry.id, 'tagged')
})

test('renderInjectBlock returns empty for an empty vault', () => {
  assert.equal(renderInjectBlock('t', 'title', [], 8, 2400), '')
})

test('renderInjectBlock respects the global budget', () => {
  const entries = Array.from({ length: 20 }, (_, i) =>
    entry({ id: `m${i}`, key: `key${i}`, content: 'word '.repeat(50), updatedAt: 1000 + i }))
  const block = renderInjectBlock('t', 'T', entries, 20, 500)
  assert.ok(block.length <= 500 + 1)
  // The newest entry is selected first.
  assert.ok(block.includes('key19'))
  // The budget cut the list short before all 20 entries.
  assert.ok(block.split('\n').filter((l) => l.startsWith('- ')).length < 20)
})

test('renderInjectBlock truncates per-entry content', () => {
  const entries = [entry({ key: 'long', content: 'x'.repeat(1000) })]
  const block = renderInjectBlock('t', 'T', entries, 8, 2400, 100)
  assert.ok(block.includes('x'.repeat(100)))
  assert.ok(!block.includes('x'.repeat(101)))
  assert.ok(block.includes('…'))
})

test('renderInjectBlock prefers pinned entries within the limit', () => {
  const entries = [
    entry({ id: '1', key: 'recent', updatedAt: 200 }),
    entry({ id: '2', key: 'pin', pinned: true, updatedAt: 100 }),
  ]
  const block = renderInjectBlock('t', 'T', entries, 1, 2400)
  assert.ok(block.includes('pin'))
  assert.ok(!block.includes('recent'))
})
