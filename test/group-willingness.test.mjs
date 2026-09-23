/**
 * 群聊发言意愿与节流（`lib/group-willingness.js`）的用例。
 *
 * 移植自上游 1.0.1-beta10 的 purity 层 + 本地补充的冷却间隔。要钉住：
 *   ① 关闭时完全放行（行为与加这层之前一致）；
 *   ② @ 机器人强制通过（绕过概率与冷却）；
 *   ③ 分数累积（条数边际递减 / 引用 / 关键词）与半衰期衰减；
 *   ④ 低于阈值不回；超过阈值按概率投骰子；
 *   ⑤ 回复后消耗（不连着抢话）；
 *   ⑥ **冷却间隔**：距上次发言不足间隔时不回（本地需求）；
 *   ⑦ 每群状态隔离。
 *
 * 运行：node test/group-willingness.test.mjs
 */
import assert from 'node:assert/strict'

import {
  DEFAULT_GROUP_WILLINGNESS, resolveGroupWillingness, decayWillingness,
  evaluateGroupWillingness, consumeGroupWillingness, GroupWillingnessStore,
} from '../lib/group-willingness.js'

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

const T0 = 1_800_000_000_000
console.log('群聊发言意愿与节流')

/* ------------------------------------------------------- ① 配置与关闭态 */

ok('默认关闭，且关闭时放行一切', () => {
  assert.equal(DEFAULT_GROUP_WILLINGNESS.enabled, false)
  const d = evaluateGroupWillingness(undefined, {}, { now: T0, messageCount: 1, content: '随便聊聊', mentionedBot: false })
  assert.equal(d.shouldCall, true)
  assert.equal(d.probability, 1)
  assert.equal(d.reason, 'disabled')
})

ok('resolveGroupWillingness：缺省兜底与越界收敛', () => {
  const c = resolveGroupWillingness({ enabled: true, threshold: 999, decayHalfLifeSeconds: -5, keywords: [' 超纲 ', '', 42] })
  assert.equal(c.enabled, true)
  assert.equal(c.threshold, 10, '越界收敛到上限')
  assert.equal(c.decayHalfLifeSeconds, 1, '越界收敛到下限')
  assert.deepEqual(c.keywords, ['超纲', '42'], '关键词去空、转字符串')
})

ok('resolveGroupWillingness：非对象/缺字段安全', () => {
  const c = resolveGroupWillingness(undefined)
  assert.equal(c.enabled, false)
  assert.deepEqual(c.keywords, [])
  assert.equal(resolveGroupWillingness(null).baseGain, DEFAULT_GROUP_WILLINGNESS.baseGain)
})

/* ------------------------------------------------------- ② @ 强制通过 */

ok('@ 机器人 → 强制通过（概率 1，绕过一切）', () => {
  // 分数为 0、冷却中，也不该拦住被点名的情况。
  const d = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, {
    enabled: true, minReplyIntervalSeconds: 3600,
  }, { now: T0, messageCount: 1, content: '机器人呢', mentionedBot: true, lastReplyAt: T0 - 1000 })
  assert.equal(d.shouldCall, true)
  assert.equal(d.probability, 1)
  assert.equal(d.reason, 'forced-mention')
})

/* ------------------------------------------------------- ③ 累积与衰减 */

ok('条数越多加得越多，但有上限（边际递减）', () => {
  const cfg = { enabled: true, threshold: 0 }
  const one = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, cfg, { now: T0, messageCount: 1, content: 'a' })
  const three = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, cfg, { now: T0, messageCount: 3, content: 'a' })
  assert.ok(three.state.score > one.state.score, '3 条 > 1 条')
  const ten = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, cfg, { now: T0, messageCount: 10, content: 'a' })
  assert.equal(ten.state.score, three.state.score, '条数封顶在 3（再多不加）')
})

ok('引用机器人 / 命中关键词额外加分', () => {
  const cfg = { enabled: true, keywords: ['求助'] }
  const base = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, cfg, { now: T0, messageCount: 1, content: '普通消息' })
  const quote = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, cfg, { now: T0, messageCount: 1, content: '普通消息', quotedBot: true })
  const keyword = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, cfg, { now: T0, messageCount: 1, content: '这里有求助' })
  assert.ok(quote.state.score > base.state.score, '引用加分')
  assert.ok(keyword.state.score > base.state.score, '关键词加分')
})

ok('半衰期衰减：过了一个半衰期分数减半', () => {
  const cfg = resolveGroupWillingness({ enabled: true, decayHalfLifeSeconds: 180 })
  const decayed = decayWillingness({ score: 0.8, updatedAt: T0 }, cfg, T0 + 180_000)
  assert.ok(Math.abs(decayed.score - 0.4) < 1e-9, `实际 ${decayed.score}`)
  const long = decayWillingness({ score: 0.8, updatedAt: T0 }, cfg, T0 + 3 * 3600_000)
  assert.equal(long.score, 0, '衰减到极小归零（不留浮点尾巴）')
})

/* ------------------------------------------------------- ④ 阈值与概率 */

ok('低于阈值 → 不回', () => {
  const d = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, {
    enabled: true, threshold: 0.9, baseGain: 0.1,
  }, { now: T0, messageCount: 1, content: 'x' })
  assert.equal(d.shouldCall, false)
  assert.equal(d.reason, 'below-threshold')
  assert.equal(d.probability, 0)
})

ok('超过阈值 → 按概率投骰子（同分数下随机值决定）', () => {
  const cfg = { enabled: true, threshold: 0.2, baseGain: 0.5, probabilityAmplifier: 2 }
  const hit = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, cfg, {
    now: T0, messageCount: 1, content: 'x', random: () => 0.01,
  })
  const miss = evaluateGroupWillingness({ score: 0, updatedAt: T0 }, cfg, {
    now: T0, messageCount: 1, content: 'x', random: () => 0.99,
  })
  assert.equal(hit.reason, 'probability-roll')
  assert.equal(hit.shouldCall, true, '低随机值命中')
  assert.equal(miss.shouldCall, false, '高随机值不命中')
  assert.ok(hit.probability > 0 && hit.probability <= 1, `概率应在 (0,1]：${hit.probability}`)
})

/* ------------------------------------------------------- ⑤ 回复消耗 */

ok('回复后消耗分数（不连着抢话）', () => {
  const cfg = resolveGroupWillingness({ enabled: true, replyCost: 0.55 })
  const before = { score: 0.8, updatedAt: T0 }
  const after = consumeGroupWillingness(before, cfg, T0)
  assert.ok(Math.abs(after.score - 0.25) < 1e-9, `实际 ${after.score}`)
})

ok('消耗不会把分数压成负数', () => {
  const cfg = resolveGroupWillingness({ enabled: true, replyCost: 0.55 })
  assert.equal(consumeGroupWillingness({ score: 0.1, updatedAt: T0 }, cfg, T0).score, 0)
})

/* ------------------------------------------------------- ⑥ 冷却（本地补充） */

ok('冷却：距上次发言不足间隔 → 不回（即使分数够）', () => {
  const cfg = { enabled: true, threshold: 0.1, baseGain: 0.5, minReplyIntervalSeconds: 60 }
  const d = evaluateGroupWillingness({ score: 0.9, updatedAt: T0 }, cfg, {
    now: T0, messageCount: 2, content: 'x', lastReplyAt: T0 - 30_000, random: () => 0.001,
  })
  assert.equal(d.shouldCall, false)
  assert.equal(d.reason, 'cooldown')
})

ok('冷却：过了间隔就恢复判定', () => {
  const cfg = { enabled: true, threshold: 0.1, baseGain: 0.5, minReplyIntervalSeconds: 60 }
  const d = evaluateGroupWillingness({ score: 0.9, updatedAt: T0 }, cfg, {
    now: T0, messageCount: 2, content: 'x', lastReplyAt: T0 - 90_000, random: () => 0.001,
  })
  assert.notEqual(d.reason, 'cooldown')
  assert.equal(d.shouldCall, true)
})

ok('冷却默认关闭（0 秒 = 不限制）', () => {
  assert.equal(DEFAULT_GROUP_WILLINGNESS.minReplyIntervalSeconds, 0)
  const d = evaluateGroupWillingness({ score: 0.9, updatedAt: T0 }, {
    enabled: true, threshold: 0.1, baseGain: 0.5,
  }, { now: T0, messageCount: 2, content: 'x', lastReplyAt: T0, random: () => 0.001 })
  assert.notEqual(d.reason, 'cooldown')
})

/* ------------------------------------------------------- ⑦ 每群隔离 */

ok('每群一份状态，互不影响', () => {
  const store = new GroupWillingnessStore()
  const cfg = { enabled: true, threshold: 0.1, baseGain: 0.5 }
  const a = evaluateGroupWillingness(store.stateOf('group:A'), cfg, { now: T0, messageCount: 1, content: 'x' })
  store.setState('group:A', a.state)
  assert.ok(store.stateOf('group:A').score > 0, 'A 群有分')
  assert.equal(store.stateOf('group:B'), undefined, 'B 群不受影响')
})

ok('noteReply 同时记冷却时刻并消耗意愿', () => {
  const store = new GroupWillingnessStore()
  const cfg = resolveGroupWillingness({ enabled: true, replyCost: 0.5 })
  store.setState('group:A', { score: 0.9, updatedAt: T0 })
  store.noteReply('group:A', cfg, T0)
  assert.equal(store.lastReplyOf('group:A'), T0, '冷却时刻已记')
  assert.ok(Math.abs(store.stateOf('group:A').score - 0.4) < 1e-9, '意愿已消耗')
})

ok('snapshot 给出诊断用快照', () => {
  const store = new GroupWillingnessStore()
  store.setState('group:A', { score: 0.3, updatedAt: T0 })
  store.noteReply('group:A', {}, T0)
  const snap = store.snapshot()
  assert.ok(snap['group:A'], '含该群')
  assert.equal(typeof snap['group:A'].lastReplyAt, 'number')
})

/* ------------------------------------------------------- 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)
