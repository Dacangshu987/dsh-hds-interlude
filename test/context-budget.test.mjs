/**
 * 剧本历史上下文预算（rc35 移植）的用例。
 *
 * 上游 rc35 修复：`recentEntriesForPrompt` 里 `Math.max(35, …)` 硬地板使
 * `contextEntryLimit` 调小静默失效，小模型无法收缩历史上下文。修复后
 * 预算判定抽为纯函数 `resolveScriptContextBudget`（条数下限 1、默认 35、
 * 上限 200；时间窗 0–1440、默认 45）。
 *
 * 本仓的特殊问题（比上游更彻底）：这两个键在 index.js 重写后**没有任何消费者**，
 * 是彻底的死键。本轮接回两个真实消费点（interlude_memory 证据窗口、播种器历史
 * 窗口），并按 rc35 口径无硬地板。
 *
 * 运行：node test/context-budget.test.mjs
 */
import assert from 'node:assert/strict'
import { resolveScriptContextBudget, recentEntriesForPrompt } from '../lib/script-entry.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('剧本历史上下文预算（rc35 移植）')

/* ─────────────── resolveScriptContextBudget ─────────────── */

check('预算解析：默认 35 / 45；缺字段回默认（与上游 ?? 35 / ?? 45 一致）', () => {
  assert.deepEqual(resolveScriptContextBudget({}), { count: 35, minutes: 45 })
  assert.deepEqual(resolveScriptContextBudget(undefined), { count: 35, minutes: 45 })
})

check('预算解析：rc35 的核心语义——调小到 1 真的生效（无 Math.max(35) 硬地板）', () => {
  assert.equal(resolveScriptContextBudget({ contextEntryLimit: 1 }).count, 1)
  assert.equal(resolveScriptContextBudget({ contextEntryLimit: 10 }).count, 10)
  assert.equal(resolveScriptContextBudget({ contextEntryLimit: 34 }).count, 34, '35 以下不再被地板顶回')
})

check('预算解析：上限 200 / 1440 夹取；0 时间窗合法（关闭）', () => {
  assert.equal(resolveScriptContextBudget({ contextEntryLimit: 9999 }).count, 200)
  assert.equal(resolveScriptContextBudget({ contextTimeWindowMinutes: 9999 }).minutes, 1440)
  assert.equal(resolveScriptContextBudget({ contextTimeWindowMinutes: 0 }).minutes, 0)
  assert.equal(resolveScriptContextBudget({ contextEntryLimit: 0 }).count, 35, '0 不是合法条数（schema min 1）→ 回默认')
  assert.equal(resolveScriptContextBudget({ contextEntryLimit: -5 }).count, 35)
  assert.equal(resolveScriptContextBudget({ contextEntryLimit: 12.7 }).count, 12, '小数向下取整')
})

/* ─────────────── recentEntriesForPrompt ─────────────── */

const NOW = Date.parse('2026-10-04T12:00:00+08:00')
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString()
/** 造一条 id/occurredAt 齐全的条目。 */
const entry = (id, minutesAgo, kind = 'script') => ({ id, kind, occurredAt: at(minutesAgo), content: `e${id}` })

check('条数闸：只取最新 count 条（调小真的生效）', () => {
  const ledger = { entries: [entry(1, 3000), entry(2, 2000), entry(3, 1000), entry(4, 100)] }
  const out = recentEntriesForPrompt(ledger, { runtime: { contextEntryLimit: 2, contextTimeWindowMinutes: 0 }, now: NOW })
  assert.deepEqual(out.map(e => e.id), [3, 4], '只要最新 2 条')
})

check('时间窗闸：窗口内的条目全部并入，即使超过条数（上游「连发不挤掉同小时的话」）', () => {
  const ledger = { entries: [entry(1, 200), entry(2, 150), entry(3, 100), entry(4, 40), entry(5, 10)] }
  // 条数闸只保 2 条（4、5）；时间窗 60 分钟（NOW-60min 之后的条目：id 3 在 100 分钟前，不在窗内？
  // 100 分钟前 < 60 分钟窗 → 不在。修正预期：窗口内是 4（40 分钟前）、5（10 分钟前）。
  // 条数闸 2 条也是 4、5 → 并集仍是 4、5。为了让时间窗真正「多带」，把 3 改近一点。
  const l2 = { entries: [entry(1, 200), entry(2, 150), entry(3, 50), entry(4, 40), entry(5, 10)] }
  const out = recentEntriesForPrompt(l2, { runtime: { contextEntryLimit: 2, contextTimeWindowMinutes: 60 }, now: NOW })
  assert.deepEqual(out.map(e => e.id), [3, 4, 5], '条数闸带 4、5，时间窗额外并入 3，按 id 升序')
})

check('墓碑（redacted）不进入结果；结果按 id 升序', () => {
  const ledger = { entries: [entry(1, 3000), { ...entry(2, 2000), kind: 'redacted' }, entry(3, 1000)] }
  const out = recentEntriesForPrompt(ledger, { runtime: { contextEntryLimit: 10, contextTimeWindowMinutes: 0 }, now: NOW })
  assert.deepEqual(out.map(e => e.id), [1, 3])
})

check('防御：坏账本/坏时间戳不抛错', () => {
  assert.deepEqual(recentEntriesForPrompt(undefined, { runtime: {} , now: NOW }), [])
  assert.deepEqual(recentEntriesForPrompt({ entries: [{ id: 1, occurredAt: 'not-a-date' }] }, { runtime: { contextEntryLimit: 5, contextTimeWindowMinutes: 30 }, now: NOW }).length, 1, '坏时间戳条目仍可由条数闸带入')
})

console.log(`\n剧本历史上下文预算：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
