/**
 * Urge 弹性推进（`lib/urge.js`）的用例。
 *
 * 移植自上游 `src/urge.ts`。要钉住：
 *   ① 配置解析的四档频率默认值与上游一致；
 *   ② 用户事件合并进 2 分钟桶、密度随半衰期衰减；
 *   ③ commitUrge 的「引用必须在正文里」与「非法输入清掉旧慢速」语义；
 *   ④ planUrge 的三条分支（休息/慢速、爆发、密度衰减）与随机性边界。
 *
 * 运行：node test/urge.test.mjs
 */
import assert from 'node:assert/strict'

import {
  resolveUrgeConfig, normalizeUrgeState, urgeUserEvent, urgeDensity,
  commitUrge, acknowledgeUrge, urgeBurstActive, planUrge, urgeInstruction,
  parseUrgeHandoff, stripUrgeHandoff,
} from '../lib/urge.js'

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
console.log('Urge 弹性推进')

/* ------------------------------------------------------------ ① 配置解析 */

ok('resolveUrgeConfig：默认 medium 档参数与上游一致', () => {
  const c = resolveUrgeConfig({})
  assert.equal(c.enabled, false)
  assert.equal(c.frequency, 'medium')
  assert.deepEqual(c.hot, [10, 20])
  assert.deepEqual(c.idle, [35, 55])
  assert.deepEqual(c.burst, [3, 7])
  assert.deepEqual(c.slow, [110, 130])
  assert.equal(c.willingness, 0.4)
  assert.equal(c.threshold, 0.75)
  assert.equal(c.halfLife, 45)
})

ok('resolveUrgeConfig：high/low 档默认值', () => {
  const high = resolveUrgeConfig({ frequency: 'high' })
  assert.deepEqual(high.hot, [6, 12])
  assert.deepEqual(high.idle, [20, 35])
  const low = resolveUrgeConfig({ frequency: 'low' })
  assert.deepEqual(low.slow, [120, 180])
})

ok('resolveUrgeConfig：advanced 覆盖合法区间，越界收敛', () => {
  const c = resolveUrgeConfig({
    enabled: true,
    proactiveWillingnessThreshold: 0.8,
    advanced: { hotMin: 999, hotMax: -5, halfLifeMinutes: 3, burstBudget: 99 },
  })
  assert.equal(c.enabled, true)
  assert.equal(c.willingness, 0.8)
  // hotMin=999 合法（保留 999）；hotMax=-5 非法 → 收敛到 ≥ hotMin（999）。
  assert.deepEqual(c.hot, [999, 999])
  assert.equal(c.halfLife, 5)
  assert.equal(c.budget, 10)
})

/* ------------------------------------------------------------ ② 状态规范化 */

ok('normalizeUrgeState：非 v1 / 非法输入降级为空', () => {
  assert.deepEqual(normalizeUrgeState(undefined, Date.now()), { version: 1, buckets: [] })
  assert.deepEqual(normalizeUrgeState({ version: 2 }, Date.now()), { version: 1, buckets: [] })
  assert.deepEqual(normalizeUrgeState('junk', Date.now()), { version: 1, buckets: [] })
})

ok('normalizeUrgeState：超过 240 分钟的桶被丢弃', () => {
  const now = Date.now()
  const old = now - 300 * MINUTE
  const state = normalizeUrgeState({ version: 1, buckets: [old, now] }, now)
  assert.deepEqual(state.buckets, [now])
})

ok('normalizeUrgeState：armed/burst 只接受合法形状', () => {
  const now = Date.now()
  const state = normalizeUrgeState({
    version: 1,
    armed: { participantId: 'u1', entryId: 3, at: now },
    burst: { participantId: 'u1', started: now, used: 2 },
  }, now)
  assert.deepEqual(state.armed, { participantId: 'u1', entryId: 3, at: now })
  assert.deepEqual(state.burst, { participantId: 'u1', started: now, used: 2 })
})

/* ------------------------------------------------------------ ③ 用户事件与密度 */

ok('urgeUserEvent：2 分钟桶合并打字碎片', () => {
  const base = Math.floor(Date.now() / (2 * MINUTE)) * 2 * MINUTE
  const now = base + MINUTE / 2 // 桶前 1/4 处，留足桶内余量
  const state = normalizeUrgeState({ version: 1, buckets: [] }, now)
  const s1 = urgeUserEvent(state, now)
  const s2 = urgeUserEvent(s1, now + 1 * MINUTE) // 同一桶内
  assert.equal(s2.buckets.length, 1, '同一桶内的事件合并')
  const s3 = urgeUserEvent(s2, now + 3 * MINUTE) // 新桶
  assert.equal(s3.buckets.length, 2)
  assert.equal(s3.spent, false)
})

ok('urgeUserEvent：新事件清掉 armed/burst/spent', () => {
  const now = Date.now()
  const state = normalizeUrgeState({
    version: 1,
    buckets: [now],
    armed: { participantId: 'u1', entryId: 3, at: now },
    burst: { participantId: 'u1', started: now, used: 1 },
    spent: true,
  }, now)
  const next = urgeUserEvent(state, now + 5 * MINUTE)
  assert.equal(next.armed, undefined)
  assert.equal(next.burst, undefined)
  assert.equal(next.spent, false)
})

ok('urgeDensity：无事件为 0；事件越近越高', () => {
  const now = Date.now()
  const c = resolveUrgeConfig({})
  const empty = normalizeUrgeState({ version: 1, buckets: [] }, now)
  assert.equal(urgeDensity(empty, now, c), 0)
  const fresh = urgeUserEvent(empty, now)
  const d0 = urgeDensity(fresh, now, c)
  const dLater = urgeDensity(fresh, now + 30 * MINUTE, c)
  assert.ok(d0 > dLater, '越近越高（半衰期衰减）')
})

/* ------------------------------------------------------------ ④ commitUrge */

ok('commitUrge：引用不在正文里 → 不采纳并清掉旧慢速', () => {
  const now = Date.now()
  const slow = normalizeUrgeState({ version: 1, buckets: [], pace: 'slow', suggested: 300 }, now)
  const next = commitUrge(slow, { value: 0.9, basisQuote: '不存在的句子' }, '这是正文', 7, 'u1', now, resolveUrgeConfig({}))
  assert.equal(next.pace, 'normal')
  assert.equal(next.armed, undefined)
  assert.equal(next.suggested, undefined)
})

ok('commitUrge：value 非法 → 不采纳', () => {
  const now = Date.now()
  const state = normalizeUrgeState({ version: 1, buckets: [] }, now)
  const next = commitUrge(state, { value: 'high', basisQuote: '正文' }, '正文', 1, 'u1', now, resolveUrgeConfig({}))
  assert.equal(next.value, undefined)
})

ok('commitUrge：高意愿 + 目标 + 未 spent + 未爆发 → armed', () => {
  const now = Date.now()
  const state = normalizeUrgeState({ version: 1, buckets: [] }, now)
  const c = resolveUrgeConfig({ enabled: true, advanced: { burstBudget: 3 } })
  const next = commitUrge(state, { value: 0.9, pace: 'normal', basisQuote: '正文' }, '正文', 7, 'u1', now, c, () => 0.5)
  assert.ok(next.armed, '应武装联系意图')
  assert.equal(next.armed.participantId, 'u1')
  assert.equal(next.value, 0.9)
})

ok('commitUrge：慢速 pace → 不 armed', () => {
  const now = Date.now()
  const state = normalizeUrgeState({ version: 1, buckets: [] }, now)
  const c = resolveUrgeConfig({ enabled: true, advanced: { burstBudget: 3 } })
  const next = commitUrge(state, { value: 0.9, pace: 'slow', basisQuote: '正文' }, '正文', 7, 'u1', now, c, () => 0.5)
  assert.equal(next.armed, undefined)
  assert.equal(next.pace, 'slow')
})

ok('commitUrge：extremeChance 触发时用随机值而非模型值', () => {
  const now = Date.now()
  const state = normalizeUrgeState({ version: 1, buckets: [] }, now)
  const c = resolveUrgeConfig({ enabled: true, advanced: { extremeChance: 1, burstBudget: 3 } })
  const next = commitUrge(state, { value: 0.2, basisQuote: '正文' }, '正文', 1, 'u1', now, c, () => 0.99)
  assert.equal(next.value, 0.99)
})

/* ------------------------------------------------------------ ⑤ acknowledge / burst */

ok('acknowledgeUrge：命中 armed → 消耗并开爆发', () => {
  const now = Date.now()
  const state = normalizeUrgeState({
    version: 1,
    buckets: [],
    armed: { participantId: 'u1', entryId: 5, at: now },
  }, now)
  const next = acknowledgeUrge(state, 'u1', 5, now)
  assert.equal(next.armed, undefined)
  assert.equal(next.spent, true)
  assert.equal(next.burst.participantId, 'u1')
  assert.equal(next.burst.used, 0)
})

ok('acknowledgeUrge：participant 不匹配 → 状态不变', () => {
  const now = Date.now()
  const state = normalizeUrgeState({
    version: 1,
    buckets: [],
    armed: { participantId: 'u1', entryId: 5, at: now },
  }, now)
  const next = acknowledgeUrge(state, 'u2', 5, now)
  assert.ok(next.armed, '不匹配时 armed 保留')
  assert.equal(next.armed.participantId, 'u1')
  assert.equal(next.burst, undefined, '不产生爆发')
})

ok('urgeBurstActive：TTL 内且预算未用尽', () => {
  const now = Date.now()
  const c = resolveUrgeConfig({ advanced: { burstBudget: 3, burstTtlMinutes: 35 } })
  const active = normalizeUrgeState({ version: 1, buckets: [], burst: { participantId: 'u1', started: now, used: 1 } }, now)
  assert.equal(urgeBurstActive(active, now, c), true)
  assert.equal(urgeBurstActive(active, now, c, 'u2'), false, '限定他人不匹配')
  const expired = normalizeUrgeState({ version: 1, buckets: [], burst: { participantId: 'u1', started: now - 60 * MINUTE, used: 1 } }, now)
  assert.equal(urgeBurstActive(expired, now, c), false, '超出 TTL')
  const slow = normalizeUrgeState({ version: 1, buckets: [], burst: { participantId: 'u1', started: now, used: 1 }, pace: 'slow' }, now)
  assert.equal(urgeBurstActive(slow, now, c), false, '慢速时不爆发')
})

/* ------------------------------------------------------------ ⑥ planUrge */

ok('planUrge：休息窗口 → slow 档且清掉爆发', () => {
  const now = Date.now()
  const c = resolveUrgeConfig({ frequency: 'medium' })
  const state = normalizeUrgeState({ version: 1, buckets: [], burst: { participantId: 'u1', started: now, used: 0 } }, now)
  const { state: next, minutes, reason } = planUrge(state, now, c, 30, false, () => 0)
  assert.equal(reason, 'rest-window')
  assert.ok(minutes >= 30, '休息分钟数不小于剩余休息')
  assert.equal(next.burst, undefined)
})

ok('planUrge：慢速脚本 → script-slow', () => {
  const now = Date.now()
  const c = resolveUrgeConfig({ frequency: 'medium' })
  const state = normalizeUrgeState({ version: 1, buckets: [], pace: 'slow', suggested: 200 }, now)
  const { minutes, reason } = planUrge(state, now, c, 0, false, () => 0)
  assert.equal(reason, 'script-slow')
  assert.ok(minutes >= 110, '慢速档下限')
})

ok('planUrge：爆发期 → confirmed-contact-burst 且预算递增', () => {
  const now = Date.now()
  const c = resolveUrgeConfig({ advanced: { burstBudget: 3, burstTtlMinutes: 35 } })
  const state = normalizeUrgeState({ version: 1, buckets: [], burst: { participantId: 'u1', started: now, used: 0 } }, now)
  const first = planUrge(state, now, c, 0, false, () => 0.5)
  assert.equal(first.reason, 'confirmed-contact-burst')
  assert.equal(first.state.burst.used, 1)
  const second = planUrge(first.state, now, c, 0, false, () => 0.5)
  assert.equal(second.state.burst.used, 2)
})

ok('planUrge：普通 → conversation-density-decay，热度高推进快', () => {
  const now = Date.now()
  const c = resolveUrgeConfig({ frequency: 'medium' })
  const cold = normalizeUrgeState({ version: 1, buckets: [] }, now)
  const hot = urgeUserEvent(cold, now)
  const coldPlan = planUrge(cold, now, c, 0, false, () => 0.5)
  const hotPlan = planUrge(hot, now, c, 0, false, () => 0.5)
  assert.equal(coldPlan.reason, 'conversation-density-decay')
  assert.ok(hotPlan.minutes < coldPlan.minutes, '热络时推进更快')
})

ok('planUrge：不可联系时清掉 armed', () => {
  const now = Date.now()
  const c = resolveUrgeConfig({})
  const state = normalizeUrgeState({ version: 1, buckets: [], armed: { participantId: 'u1', entryId: 1, at: now } }, now)
  const { state: next } = planUrge(state, now, c, 0, true, () => 0.5)
  assert.equal(next.armed, undefined)
})

/* ------------------------------------------------------------ ⑦ 指令与解析 */

ok('urgeInstruction：仅推进/跟进/到期阶段非空', () => {
  assert.ok(urgeInstruction(true, 'advance').length > 0)
  assert.ok(urgeInstruction(true, 'conversation-follow-up').length > 0)
  assert.ok(urgeInstruction(true, 'intent-due').length > 0)
  assert.equal(urgeInstruction(true, 'user-message'), '')
  assert.equal(urgeInstruction(false, 'advance'), '')
})

ok('parseUrgeHandoff：`urge:{...}` 行提取', () => {
  const text = '正文第一行。\nurge:{"value":0.8,"pace":"slow","suggestedDelayMinutes":200,"basisQuote":"正文第一行"}\n'
  const parsed = parseUrgeHandoff(text)
  assert.ok(parsed)
  assert.equal(parsed.value, 0.8)
  assert.equal(parsed.pace, 'slow')
})

ok('parseUrgeHandoff：纯 JSON 整行也认（有 value/pace 键）', () => {
  const parsed = parseUrgeHandoff('{"value":0.5,"pace":"normal"}')
  assert.ok(parsed)
  assert.equal(parsed.value, 0.5)
})

ok('parseUrgeHandoff：解析失败返回 undefined', () => {
  assert.equal(parseUrgeHandoff(''), undefined)
  assert.equal(parseUrgeHandoff('这只是一段普通正文'), undefined)
  assert.equal(parseUrgeHandoff('{"broken":'), undefined)
})

ok('stripUrgeHandoff：urge 行被剥离，正文保留', () => {
  const text = '她坐在窗边发呆。\nurge:{"value":0.2,"basisQuote":"她坐在窗边发呆"}'
  const body = stripUrgeHandoff(text)
  assert.equal(body, '她坐在窗边发呆。')
})

ok('stripUrgeHandoff：剥离后 basisQuote 自引用漏洞消除', () => {
  const text = '她只是安静地坐着。\nurge:{"value":0.9,"basisQuote":"这句并不存在"}'
  const body = stripUrgeHandoff(text)
  assert.ok(!body.includes('这句并不存在'), '剥离后引文不在正文里')
  assert.equal(body, '她只是安静地坐着。')
})

ok('stripUrgeHandoff：无交接行 → 正文原样', () => {
  assert.equal(stripUrgeHandoff('纯正文。'), '纯正文。')
  assert.equal(stripUrgeHandoff(''), '')
})

/* ------------------------------------------------------------ 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)
