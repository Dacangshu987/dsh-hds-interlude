/**
 * 群聊发言意愿**档位化 + auto 档**测试。
 *   移植自上游 `1.0.1-rc23` 的 `test/group-willingness-tiers.test.ts`（8 用例）。
 *
 * 上游把「10 个数值参数」收敛为单选档位，并新增 auto 档：按主角生活状态
 * （busy/asleep/idle）自动切档。**评分数学零改动**——档位只是参数来源。
 *
 * 基线校准（上游以固定掷骰 0.4 锁定）：eager=1、active=2、normal=4~5、
 * reserved=6~8、quiet=9~13（单条批次连续到达时的期望首发位置）。
 *
 * 运行：node test/group-willingness-tiers.test.mjs
 */
import assert from 'node:assert/strict'
import {
  WILLINGNESS_TIERS,
  WILLINGNESS_TIERS_LIST,
  DEFAULT_AUTO_WILLINGNESS,
  ASLEEP_PROBABILITY_MULTIPLIER,
  LIFE_STATUS_STALE_MS,
  normalizeLifeStatusDraft,
  resolveAutoWillingness,
  evaluateWillingnessGate,
  consumeWillingnessGate,
  resolveGroupWillingness,
} from '../lib/group-willingness.js'
import { normalizeLifeStatus } from '../lib/state.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

const FIXED_ROLL = 0.4
const NOW = Date.now()

/**
 * 用固定掷骰跑连续单条消息，返回**首次触发**的序号（1 起）。
 * 与上游校准口径一致：单条批次、无引用、无关键词、不被 @。
 */
function firstCallAt(preset, { auto = undefined, lifeStatus = undefined, legacy = {} } = {}) {
  let state
  for (let i = 1; i <= 20; i += 1) {
    const now = NOW + i * 1000
    const decision = evaluateWillingnessGate(state, preset, auto, lifeStatus, legacy, {
      now, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => FIXED_ROLL,
    })
    state = decision.state
    if (decision.shouldCall) return i
  }
  return Infinity
}

console.log('群聊发言意愿档位（rc23 移植）')

check('五档校准区间：eager=1、active=2、normal=4~5、reserved=6~8、quiet=9~13', () => {
  const eager = firstCallAt('eager')
  const active = firstCallAt('active')
  const normal = firstCallAt('normal')
  const reserved = firstCallAt('reserved')
  const quiet = firstCallAt('quiet')
  assert.equal(eager, 1, `eager 应第 1 条就开口，实际 ${eager}`)
  assert.equal(active, 2, `active 应第 2 条开口，实际 ${active}`)
  assert.ok(normal >= 4 && normal <= 5, `normal 应在 4~5，实际 ${normal}`)
  assert.ok(reserved >= 6 && reserved <= 8, `reserved 应在 6~8，实际 ${reserved}`)
  assert.ok(quiet >= 9 && quiet <= 13, `quiet 应在 9~13，实际 ${quiet}`)
})

check('off：仅按响应模式与冷却生效（shouldCall=true, reason=disabled）', () => {
  const decision = evaluateWillingnessGate(undefined, 'off', undefined, undefined, {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.99,
  })
  assert.equal(decision.shouldCall, true)
  assert.equal(decision.reason, 'disabled')
  assert.equal(decision.diagnosis.preset, 'off')
})

check('存量兼容：preset 为空/off 但旧数值门 enabled=true → 按 custom 处理', () => {
  const legacy = { enabled: true, threshold: 0.1, baseGain: 0.9, maxScore: 2, probabilityAmplifier: 2, decayHalfLifeSeconds: 180, replyCost: 0.5, quoteGain: 0, keywordGain: 0, keywords: [] }
  for (const preset of ['', 'off', undefined]) {
    const d = evaluateWillingnessGate(undefined, preset, undefined, undefined, legacy, {
      now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.9,
    })
    assert.equal(d.diagnosis.preset, 'custom', `preset=${String(preset)} 应解析为 custom`)
    assert.equal(d.shouldCall, true, 'custom 沿用旧数值（高 baseGain 应立刻开口）')
  }
  // 未启用旧门时，preset 为空 → off
  const off = evaluateWillingnessGate(undefined, '', undefined, undefined, { enabled: false }, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.9,
  })
  assert.equal(off.diagnosis.preset, 'off')
})

check('auto 档：三态映射 + 自定义映射生效', () => {
  const fresh = () => undefined
  const life = (status) => ({ status, updatedAt: new Date(NOW - 60_000).toISOString() })
  // 默认映射：busy→quiet、idle→active、asleep→quiet
  const busy = evaluateWillingnessGate(fresh(), 'auto', undefined, life('busy'), {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.99,
  })
  assert.equal(busy.diagnosis.tier, 'quiet')
  assert.equal(busy.diagnosis.lifeStatus, 'busy')
  const idle = evaluateWillingnessGate(fresh(), 'auto', undefined, life('idle'), {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.99,
  })
  assert.equal(idle.diagnosis.tier, 'active')
  // 自定义映射
  const custom = evaluateWillingnessGate(fresh(), 'auto', { busy: 'eager', idle: 'quiet', asleep: 'reserved' }, life('busy'), {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.99,
  })
  assert.equal(custom.diagnosis.tier, 'eager', '自定义 busy=eager 应生效')
})

check('asleep：@ 不再直通，且概率 ×0.2，失败原因记为 asleep', () => {
  const life = { status: 'asleep', updatedAt: new Date(NOW - 60_000).toISOString() }
  // 用一个「必然越过阈值」的档位（eager）确认 @ 仍被阻断
  const atDecision = evaluateWillingnessGate(undefined, 'auto', { busy: 'quiet', idle: 'active', asleep: 'eager' }, life, {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: true, random: () => 0,
  })
  assert.notEqual(atDecision.reason, 'forced-mention', '睡眠态 @ 不应直通')
  assert.equal(atDecision.diagnosis.asleep, true)
  // 概率 ×0.2：与同档位非睡眠态对比
  const roll0 = () => 0
  const awake = evaluateWillingnessGate(undefined, 'eager', undefined, undefined, {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: roll0,
  })
  const asleep = evaluateWillingnessGate(undefined, 'auto', { busy: 'quiet', idle: 'active', asleep: 'eager' }, life, {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: roll0,
  })
  assert.equal(asleep.diagnosis.tier, 'eager', '睡眠态仍用所配档位')
  const ratio = asleep.probability / awake.probability
  assert.ok(Math.abs(ratio - ASLEEP_PROBABILITY_MULTIPLIER) < 1e-9,
    `概率应为 awake × ${ASLEEP_PROBABILITY_MULTIPLIER}，实际比值 ${ratio}`)
  // 掷骰失败 → reason=asleep
  const failedRoll = evaluateWillingnessGate(undefined, 'auto', { busy: 'quiet', idle: 'active', asleep: 'eager' }, life, {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.999,
  })
  assert.equal(failedRoll.shouldCall, false)
  assert.equal(failedRoll.reason, 'asleep')
})

check('lifeStatus 过期/缺失 → auto 回退 normal（stale 标记）', () => {
  const stale = { status: 'asleep', updatedAt: new Date(NOW - LIFE_STATUS_STALE_MS - 1000).toISOString() }
  const d1 = evaluateWillingnessGate(undefined, 'auto', undefined, stale, {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.99,
  })
  assert.equal(d1.diagnosis.tier, 'normal', '过期应回退 normal')
  assert.equal(d1.diagnosis.stale, true)
  assert.equal(d1.diagnosis.asleep, false, '回退后不再是睡眠态')
  const d2 = evaluateWillingnessGate(undefined, 'auto', undefined, undefined, {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.99,
  })
  assert.equal(d2.diagnosis.tier, 'normal', '缺失应回退 normal')
  assert.equal(d2.diagnosis.stale, undefined, '从未有过状态时不算 stale')
  // 非法状态值同样回退
  const d3 = evaluateWillingnessGate(undefined, 'auto', undefined, { status: 'awake', updatedAt: new Date(NOW).toISOString() }, {}, {
    now: NOW, messageCount: 1, content: '', quotedBot: false, mentionedBot: false, random: () => 0.99,
  })
  assert.equal(d3.diagnosis.tier, 'normal')
})

check('归一函数：normalizeLifeStatusDraft / resolveAutoWillingness / state.normalizeLifeStatus', () => {
  assert.equal(normalizeLifeStatusDraft('busy'), 'busy')
  assert.equal(normalizeLifeStatusDraft('asleep'), 'asleep')
  assert.equal(normalizeLifeStatusDraft('awake'), undefined)
  assert.equal(normalizeLifeStatusDraft(undefined), undefined)
  assert.deepEqual(resolveAutoWillingness(undefined), DEFAULT_AUTO_WILLINGNESS)
  assert.deepEqual(resolveAutoWillingness({ busy: 'eager', idle: 'bogus' }), { busy: 'eager', idle: 'active', asleep: 'quiet' })
  // state 侧归一：形状不对一律 null
  assert.deepEqual(normalizeLifeStatus({ status: 'idle', updatedAt: '2026-09-28T10:00:00.000Z' }),
    { status: 'idle', updatedAt: '2026-09-28T10:00:00.000Z' })
  assert.equal(normalizeLifeStatus({ status: 'idle' }), null, '缺时间戳应回 null')
  assert.equal(normalizeLifeStatus({ status: 'awake', updatedAt: '2026-09-28T10:00:00.000Z' }), null)
  assert.equal(normalizeLifeStatus({ status: 'idle', updatedAt: 'not-a-date' }), null)
  assert.equal(normalizeLifeStatus(null), null)
})

check('档位单调性：quiet→eager 阈值递减、增益递增', () => {
  const thresholds = WILLINGNESS_TIERS_LIST.map((t) => WILLINGNESS_TIERS[t].threshold)
  for (let i = 1; i < thresholds.length; i += 1) {
    assert.ok(thresholds[i] < thresholds[i - 1], `阈值应严格递减：${WILLINGNESS_TIERS_LIST.join('→')}`)
  }
  const gains = WILLINGNESS_TIERS_LIST.map((t) => WILLINGNESS_TIERS[t].baseGain)
  for (let i = 1; i < gains.length; i += 1) {
    assert.ok(gains[i] > gains[i - 1], 'baseGain 应严格递增')
  }
  for (const tier of WILLINGNESS_TIERS_LIST) {
    assert.equal(WILLINGNESS_TIERS[tier].enabled, true, `${tier} 档应启用`)
  }
  // keywords 与档位正交：档位表里 keywords 恒为空，实际取旧配置
  const legacy = { keywords: ['猫', '雨'] }
  const d = evaluateWillingnessGate(undefined, 'normal', undefined, undefined, legacy, {
    now: NOW, messageCount: 1, content: '下雨了猫在窗台', quotedBot: false, mentionedBot: false, random: () => 0.99,
  })
  assert.equal(d.diagnosis.tier, 'normal')
})

check('consumeWillingnessGate：与评估门共用档位（replyCost 对齐）', () => {
  const before = { score: 1.5, updatedAt: NOW }
  const quiet = consumeWillingnessGate(before, 'quiet', undefined, undefined, {}, NOW)
  const eager = consumeWillingnessGate(before, 'eager', undefined, undefined, {}, NOW)
  assert.equal(quiet.score, 1.5 - WILLINGNESS_TIERS.quiet.replyCost)
  assert.equal(eager.score, 1.5 - WILLINGNESS_TIERS.eager.replyCost)
  assert.ok(eager.score > quiet.score, 'eager 扣得更少 → 更容易接着说')
  // custom 沿用旧数值
  const legacy = { enabled: true, replyCost: 0.42 }
  const custom = consumeWillingnessGate(before, 'custom', undefined, undefined, legacy, NOW)
  assert.ok(Math.abs(custom.score - (1.5 - 0.42)) < 1e-9)
  // resolveGroupWillingness 仍可用于旧路径（回归保护）
  assert.equal(resolveGroupWillingness({ enabled: true }).enabled, true)
})

console.log(`\n意愿档位：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
