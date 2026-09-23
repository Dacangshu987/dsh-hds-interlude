/**
 * 剧本条目账本的墓碑与范围软删（`lib/script-entry.js` 的 redact 扩展）用例。
 *
 * 对齐上游 1.0.0-beta16「redacted 墓碑过滤」与 `purgeStoryRange` 软删语义：
 *   ① redactRange 只软删范围内条目、不回收 id、不动发号器；
 *   ② 墓碑条目从读取路径（recentEntries / entriesAfter / validEntryIds）消失；
 *   ③ 逐字校验对墓碑条目自然失败（正文已替换为占位符）。
 *
 * 运行：node test/script-entry-redact.test.mjs
 */
import assert from 'node:assert/strict'

import {
  createLedger, appendEntry, redactRange, isRedactedEntry,
  recentEntries, entriesAfter, validEntryIds, entryById, verifyQuote,
} from '../lib/script-entry.js'

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

const MINUTE = 60_000
console.log('剧本条目账本：墓碑与范围软删')

function sampleLedger() {
  const ledger = createLedger()
  const t0 = Date.parse('2026-09-01T10:00:00Z')
  // 三条：10:00 / 12:00 / 14:00
  appendEntry(ledger, { kind: 'user-message', content: '第一条消息', occurredAt: new Date(t0).toISOString() })
  appendEntry(ledger, { kind: 'script', content: '第二条剧本正文', occurredAt: new Date(t0 + 2 * 3600_000).toISOString() })
  appendEntry(ledger, { kind: 'character-message', content: '第三条回复', occurredAt: new Date(t0 + 4 * 3600_000).toISOString() })
  return { ledger, t0 }
}

ok('isRedactedEntry：只认墓碑标记', () => {
  const { ledger } = sampleLedger()
  assert.equal(isRedactedEntry(ledger.entries[0]), false)
  assert.equal(isRedactedEntry({ kind: 'redacted' }), true)
  assert.equal(isRedactedEntry({ metadata: { redacted: true } }), true)
})

ok('redactRange：只软删范围内条目，返回被删 id', () => {
  const { ledger, t0 } = sampleLedger()
  const removed = redactRange(ledger, { from: t0 + MINUTE, to: t0 + 3 * 3600_000 })
  assert.deepEqual(removed, [2], '只删 12:00 那条')
  assert.equal(ledger.entries[1].kind, 'redacted')
  assert.equal(ledger.entries[1].content, '[管理员已删除剧本内容]')
  assert.equal(ledger.entries[1].metadata.redacted, true)
})

ok('redactRange：不回收 id、不动发号器', () => {
  const { ledger, t0 } = sampleLedger()
  const nextIdBefore = ledger.nextId
  redactRange(ledger, { from: 0, to: t0 + 24 * 3600_000 })
  assert.equal(ledger.nextId, nextIdBefore, '发号器不动')
  assert.equal(ledger.entries[0].id, 1, 'id 保留')
})

ok('redactRange：非法范围 → 不动', () => {
  const { ledger, t0 } = sampleLedger()
  const removed = redactRange(ledger, { from: t0 + 3600_000, to: t0 - 3600_000 })
  assert.deepEqual(removed, [])
  assert.equal(ledger.entries.length, 3)
})

ok('recentEntries / entriesAfter：墓碑不进结果', () => {
  const { ledger, t0 } = sampleLedger()
  redactRange(ledger, { from: t0, to: t0 + 3 * 3600_000 })
  const recent = recentEntries(ledger, 10)
  assert.deepEqual(recent.map((e) => e.id), [3], '墓碑从最近列表消失')
  const after = entriesAfter(ledger, 0, 10)
  assert.deepEqual(after.map((e) => e.id), [3])
})

ok('validEntryIds：墓碑 id 从有效集合消失', () => {
  const { ledger, t0 } = sampleLedger()
  redactRange(ledger, { from: 0, to: t0 + 24 * 3600_000 })
  const ids = validEntryIds(ledger)
  assert.equal(ids.size, 0)
})

ok('verifyQuote：对墓碑条目自然失败（正文已替换）', () => {
  const { ledger, t0 } = sampleLedger()
  redactRange(ledger, { from: 0, to: t0 + 24 * 3600_000 })
  const result = verifyQuote(ledger, 2, '第二条剧本正文')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'quote-not-in-entry')
})

ok('entryById：墓碑仍可查（保留溯源完整性）', () => {
  const { ledger, t0 } = sampleLedger()
  redactRange(ledger, { from: 0, to: t0 + 24 * 3600_000 })
  const entry = entryById(ledger, 2)
  assert.ok(entry)
  assert.equal(entry.kind, 'redacted')
})

/* ------------------------------------------------------------ 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)
