/**
 * 健康面板（`lib/health.js`）的用例。
 *
 * 移植自上游 1.0.1-rc1。要钉住：
 *   ① 各计数器的累加与分桶隔离（不同故事互不影响）；
 *   ② 派生率值的算法（成功率 / 缺失率 / 缓存命中率 / 主动联系率 / 中位延迟）；
 *   ③ 分母为 0 时的取值（成功率 1、其余 0，表示"没有样本"而不是"全失败"）；
 *   ④ 延迟样本有界；
 *   ⑤ 首稿缺失与挽回成功**分开**计数（上游 rc2 修过这个混账）。
 *
 * 运行：node test/health.test.mjs
 */
import assert from 'node:assert/strict'

import { HealthMonitor, renderHealthSection, MAX_LATENCIES } from '../lib/health.js'

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

console.log('运行健康面板')

/* ------------------------------------------------------- ① 计数器与分桶 */

ok('空监控器：成功率为 1（无样本不构成问题），其余率为 0', () => {
  const h = new HealthMonitor(0)
  const s = h.snapshot('story-a')
  assert.equal(s.narrativeTotal, 0)
  assert.equal(s.successRate, 1)
  assert.equal(s.structureMissingRate, 0)
  assert.equal(s.cacheHitRate, 0)
  assert.equal(s.proactiveRate, 0)
  assert.equal(s.medianLatencyMs, 0)
})

ok('主叙事成功/失败累加，成功率 = 成功 /（成功+失败）', () => {
  const h = new HealthMonitor(0)
  h.recordNarrativeComplete('a', 100, 'immediate')
  h.recordNarrativeComplete('a', 200, 'immediate')
  h.recordNarrativeFailed('a')
  const s = h.snapshot('a')
  assert.equal(s.narrativeTotal, 2)
  assert.equal(s.narrativeFailed, 1)
  assert.ok(Math.abs(s.successRate - 2 / 3) < 1e-9)
})

ok('不同故事分桶隔离', () => {
  const h = new HealthMonitor(0)
  h.recordNarrativeComplete('a', 10, 'immediate')
  h.recordNarrativeFailed('b')
  assert.equal(h.snapshot('a').narrativeTotal, 1)
  assert.equal(h.snapshot('a').narrativeFailed, 0)
  assert.equal(h.snapshot('b').narrativeTotal, 0)
  assert.equal(h.snapshot('b').narrativeFailed, 1)
})

/* ------------------------------------------------------- ② 回复模式归属 */

ok('回复模式按四类归档（未知值记为「无投递」）', () => {
  const h = new HealthMonitor(0)
  h.recordNarrativeComplete('a', 1, 'immediate')
  h.recordNarrativeComplete('a', 1, 'immediate')
  h.recordNarrativeComplete('a', 1, 'none')
  h.recordNarrativeComplete('a', 1, 'delayed')
  h.recordNarrativeComplete('a', 1, 'weird-value')
  const m = h.snapshot('a').replyModes
  assert.deepEqual(m, { immediate: 2, none: 1, delayed: 1, noDelivery: 1 })
})

/* ------------------------------------------------------- ③ 缺失与挽回分开 */

ok('首稿缺失与挽回成功分开计数（不是一个分支）', () => {
  const h = new HealthMonitor(0)
  h.recordNarrativeComplete('a', 1, 'immediate')
  h.recordNarrativeComplete('a', 1, 'immediate')
  h.recordStructureMissing('a')
  h.recordStructureMissing('a')
  h.recordRecoverySaved('a')
  const s = h.snapshot('a')
  assert.equal(s.structureMissing, 2)
  assert.equal(s.recoverySaved, 1)
  assert.ok(Math.abs(s.structureMissingRate - 1) < 1e-9, '缺失率 = 缺失 / 成功回合')
})

/* ------------------------------------------------------- ④ 侧端 / 主动 / Token */

ok('侧端任务成功失败累加', () => {
  const h = new HealthMonitor(0)
  h.recordSideTask('a', true)
  h.recordSideTask('a', true)
  h.recordSideTask('a', false)
  assert.equal(h.snapshot('a').sideTaskTotal, 3)
  assert.equal(h.snapshot('a').sideTaskFailed, 1)
})

ok('主动联系只按「真的送出去」计数', () => {
  const h = new HealthMonitor(0)
  h.recordProactive('a', true)
  h.recordProactive('a', false)
  h.recordProactive('a', false)
  h.recordProactive('a', true)
  const s = h.snapshot('a')
  assert.equal(s.proactiveTotal, 4)
  assert.equal(s.proactiveSent, 2)
  assert.ok(Math.abs(s.proactiveRate - 0.5) < 1e-9)
})

ok('Token 用量与缓存命中率', () => {
  const h = new HealthMonitor(0)
  h.recordTokens('a', 1000, 400)
  h.recordTokens('a', 500, 100)
  const s = h.snapshot('a')
  assert.equal(s.inputTokens, 1500)
  assert.equal(s.cachedTokens, 500)
  assert.ok(Math.abs(s.cacheHitRate - 500 / 1500) < 1e-9)
})

ok('非法 Token 值被忽略（不污染分母）', () => {
  const h = new HealthMonitor(0)
  h.recordTokens('a', 100, 10)
  h.recordTokens('a', Number.NaN, undefined)
  assert.equal(h.snapshot('a').inputTokens, 100)
})

/* ------------------------------------------------------- ⑤ 延迟与中位数 */

ok('中位延迟：奇数与偶数样本都对', () => {
  const odd = new HealthMonitor(0)
  for (const ms of [300, 100, 200]) odd.recordNarrativeComplete('a', ms, 'immediate')
  assert.equal(odd.snapshot('a').medianLatencyMs, 200)

  const even = new HealthMonitor(0)
  for (const ms of [400, 100, 300, 200]) even.recordNarrativeComplete('b', ms, 'immediate')
  assert.equal(even.snapshot('b').medianLatencyMs, 300, '取上中位（与上游一致）')
})

ok('非法延迟不进样本', () => {
  const h = new HealthMonitor(0)
  h.recordNarrativeComplete('a', Number.NaN, 'immediate')
  h.recordNarrativeComplete('a', -5, 'immediate')
  h.recordNarrativeComplete('a', 120, 'immediate')
  const s = h.snapshot('a')
  assert.equal(s.latenciesMs.length, 1)
  assert.equal(s.medianLatencyMs, 120)
})

ok('延迟样本有界（超出丢弃最旧的）', () => {
  const h = new HealthMonitor(0)
  for (let i = 0; i < MAX_LATENCIES + 50; i += 1) h.recordNarrativeComplete('a', i, 'immediate')
  const s = h.snapshot('a')
  assert.equal(s.latenciesMs.length, MAX_LATENCIES)
  assert.equal(s.latenciesMs[s.latenciesMs.length - 1], MAX_LATENCIES + 49, '保留最新样本')
})

/* ------------------------------------------------------- ⑥ 快照与渲染 */

ok('快照是拷贝：改动不影响内部状态', () => {
  const h = new HealthMonitor(0)
  h.recordNarrativeComplete('a', 100, 'immediate')
  const s = h.snapshot('a')
  s.replyModes.immediate = 999
  s.latenciesMs.push(1)
  assert.equal(h.snapshot('a').replyModes.immediate, 1)
  assert.equal(h.snapshot('a').latenciesMs.length, 1)
})

ok('all() 返回全部故事的快照', () => {
  const h = new HealthMonitor(0)
  h.recordNarrativeComplete('a', 1, 'immediate')
  h.recordNarrativeComplete('b', 1, 'none')
  const all = h.all()
  assert.deepEqual(Object.keys(all).sort(), ['a', 'b'])
})

ok('sinceAt 标注统计起点（重载后归零的语义依据）', () => {
  const h = new HealthMonitor(new Date('2026-09-24T00:00:00.000Z').getTime())
  assert.equal(h.snapshot('a').sinceAt, '2026-09-24T00:00:00.000Z')
})

ok('renderHealthSection：渲染出关键指标；空快照渲染为空串', () => {
  const h = new HealthMonitor(0)
  h.recordNarrativeComplete('a', 1234, 'immediate')
  h.recordNarrativeFailed('a')
  h.recordTokens('a', 1000, 250)
  const text = renderHealthSection(h.snapshot('a'))
  assert.ok(text.includes('主叙事'), '应有主叙事段')
  assert.ok(text.includes('50.0%'), '成功率 1/2')
  assert.ok(text.includes('25.0%'), '缓存命中率 250/1000')
  assert.ok(text.includes('1234ms'), '应有中位延迟')
  assert.equal(renderHealthSection(undefined), '')
  assert.equal(renderHealthSection(null), '')
})

/* ------------------------------------------------------- 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)
