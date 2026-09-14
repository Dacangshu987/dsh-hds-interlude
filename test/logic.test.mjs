// 纯逻辑模块单元测试 —— 验证 clock / alter / agency / preplan 四个忠实移植的模块。
// 只依赖 node:assert，可直接 `node test/logic.test.mjs` 运行。

import assert from 'node:assert/strict'

import { resolveTimezone, storyLocalTimeContext, calendarDayKey, localClockMinutes, inRestWindow, sameLocalDay, formatGap, resolveZone } from '../lib/clock.js'
import { createAlterSystemState, normalizeAlterValue, advanceAlterSystem, completeAlterAnalysis, emotionalOffsetForPrompt, calculateAlterThreshold, resolveAlterSystemConfig } from '../lib/alter.js'
import { resolveAgencyConfig, normalizeAgencyWindowState, evaluateAgencyCapacity, proactiveCandidateFingerprint, proactiveOriginBypassesOrdinaryInterval } from '../lib/agency.js'
import { resolveSchedulePreplanConfig, materializeSchedulePreplan, schedulePreplanWindow, nextSchedulePreplanTransition, applySchedulePreplanProposal } from '../lib/preplan.js'
import { emptyState, addFact, rankFacts, closeFact } from '../lib/state.js'

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

/* ------------------------------------------------------------------ clock */

check('resolveTimezone：合法时区保留，非法回退 UTC，空回退 UTC', () => {
  assert.equal(resolveTimezone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(resolveTimezone('not/a-zone'), 'UTC')
  assert.equal(resolveTimezone(''), 'UTC')
})

check('resolveZone：空值取进程时区，非法显式时区抛错', () => {
  assert.equal(typeof resolveZone(undefined), 'string')
  assert.throws(() => resolveZone('not/a-zone'))
})

check('storyLocalTimeContext：时段与日照预期正确', () => {
  const c = storyLocalTimeContext(new Date('2026-09-11T03:00:00Z'), 'Asia/Shanghai')
  assert.equal(c.hour, 11) // 03:00Z = 11:00 +08
  assert.equal(c.period, 'morning')
  assert.ok(c.daylightExpectation.includes('daylight'))
  assert.ok(c.local.includes('2026-09-11'))
})

check('calendarDayKey 与 sameLocalDay 按本地日判定', () => {
  assert.equal(calendarDayKey(new Date('2026-09-11T03:00:00Z'), 'Asia/Shanghai'), '2026-09-11')
  assert.ok(sameLocalDay(Date.parse('2026-09-11T16:00:00Z'), Date.parse('2026-09-11T18:00:00Z'), 'Asia/Shanghai'))
})

check('localClockMinutes 按本地时区换算', () => {
  assert.equal(localClockMinutes(new Date('2026-09-11T03:00:00Z'), 'Asia/Shanghai'), 11 * 60)
})

check('inRestWindow：跨午夜窗口正确', () => {
  const win = [{ enabled: true, start: '23:00', end: '07:00' }]
  assert.equal(inRestWindow(Date.parse('2026-09-10T16:30:00Z'), 'Asia/Shanghai', win), true) // 00:30 本地
  assert.equal(inRestWindow(Date.parse('2026-09-11T03:00:00Z'), 'Asia/Shanghai', win), false) // 11:00 本地
})

check('formatGap：人话时长', () => {
  assert.equal(formatGap(30_000), '不到 1 分钟')
  assert.equal(formatGap(2 * 3600_000 + 13 * 60_000), '2 小时 13 分钟')
  assert.equal(formatGap(-5), '未知')
})

/* ------------------------------------------------------------------ alter */

check('normalizeAlterValue：截断到 -5..5 并取整', () => {
  assert.equal(normalizeAlterValue(7), 5)
  assert.equal(normalizeAlterValue(-9), -5)
  assert.equal(normalizeAlterValue(2.6), 3)
  assert.equal(normalizeAlterValue('x'), undefined)
})

check('advanceAlterSystem：累计并触发阈值', () => {
  const cfg = resolveAlterSystemConfig({ enabled: true, baseThreshold: 10, densityFactor: 0 })
  const now = new Date()
  let r = advanceAlterSystem(undefined, 5, 'user-message', now, cfg)
  assert.equal(r.state.alterValue, 5)
  assert.equal(r.thresholdReached, false)
  r = advanceAlterSystem(r.state, 6, 'user-message', now, cfg)
  assert.equal(r.state.alterValue, 11)
  assert.equal(r.thresholdReached, true)
})

check('advanceAlterSystem：激活后反向位移衰减权重并清除底色', () => {
  const cfg = resolveAlterSystemConfig({ enabled: true, baseThreshold: 10, oppositeDecay: 0.5, minWeight: 0.2, densityFactor: 0 })
  const now = new Date()
  let r = advanceAlterSystem(undefined, 6, 'user-message', now, cfg)
  r = advanceAlterSystem(r.state, 6, 'user-message', now, cfg) // 累计 12，触发阈值
  assert.equal(r.thresholdReached, true)
  const activated = completeAlterAnalysis(r.state, '更严肃', r.threshold, now, cfg) // 激活底色，权重 1
  assert.equal(activated.emotionalOffset.direction, 'serious')
  const after = advanceAlterSystem(activated, -4, 'user-message', now, cfg) // 反向 → 权重衰减到 0 → 清除底色
  assert.equal(after.state.emotionalOffset, null)
  assert.equal(after.offsetExpired, true)
})

check('completeAlterAnalysis：生成底色并清零累计', () => {
  const cfg = resolveAlterSystemConfig({ enabled: true, baseThreshold: 10, maxIntensity: 2 })
  const now = new Date()
  const state = { ...createAlterSystemState(now), alterValue: 12, alterWeight: 1 }
  const done = completeAlterAnalysis(state, '整体更严肃', 10, now, cfg)
  assert.equal(done.alterValue, 0)
  assert.equal(done.emotionalOffset.direction, 'serious')
  assert.equal(done.emotionalOffset.intensity, 1.2)
})

check('emotionalOffsetForPrompt：禁用或权重不足时不注入', () => {
  const cfg = resolveAlterSystemConfig({ enabled: false })
  const state = { ...createAlterSystemState(), emotionalOffset: { direction: 'serious', description: 'x', intensity: 1 }, alterWeight: 1 }
  assert.equal(emotionalOffsetForPrompt(state, cfg), null)
})

check('calculateAlterThreshold：密集对话降低阈值但不低于一半', () => {
  const cfg = resolveAlterSystemConfig({ baseThreshold: 10, densityFactor: 0.5 })
  const now = new Date()
  const dense = Array.from({ length: 10 }, (_, i) => ({ timestamp: new Date(now.getTime() - i * 60_000).toISOString() }))
  const sparse = [{ timestamp: new Date(now.getTime() - 10 * 3600_000).toISOString() }]
  assert.ok(calculateAlterThreshold(dense, cfg, now) < calculateAlterThreshold(sparse, cfg, now))
  assert.ok(calculateAlterThreshold(dense, cfg, now) >= 5)
})

/* ----------------------------------------------------------------- agency */

check('evaluateAgencyCapacity：设备不可用拦截', () => {
  const window = { activityLoad: 'free', privacy: 'private', deviceAccess: 'unavailable', validUntil: new Date(Date.now() + 60_000).toISOString() }
  const candidate = { origin: 'life-event', disclosure: 'ordinary', motive: 'x', sourceEntryIds: [1], outcome: 'send-now' }
  const r = evaluateAgencyCapacity(window, candidate, new Date(), resolveAgencyConfig({}), undefined)
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'device-unavailable')
})

check('evaluateAgencyCapacity：负荷过载拦截、负荷占用允许 practical-update', () => {
  const cfg = resolveAgencyConfig({})
  const now = new Date()
  const mkWindow = (load) => ({ activityLoad: load, privacy: 'private', deviceAccess: 'available', validUntil: new Date(now.getTime() + 60_000).toISOString() })
  const candidate = (origin) => ({ participantId: 'p1', origin, disclosure: 'ordinary', motive: 'x', sourceEntryIds: [1], outcome: 'send-now' })
  assert.equal(evaluateAgencyCapacity(mkWindow('overloaded'), candidate('life-event'), now, cfg, undefined).allowed, false)
  assert.equal(evaluateAgencyCapacity(mkWindow('occupied'), candidate('practical-update'), now, cfg, undefined).allowed, true)
  assert.equal(evaluateAgencyCapacity(mkWindow('occupied'), candidate('life-event'), now, cfg, undefined).allowed, false)
})

check('evaluateAgencyCapacity：隐私不足拦截 personal 披露', () => {
  const cfg = resolveAgencyConfig({})
  const now = new Date()
  const window = { activityLoad: 'free', privacy: 'shared', deviceAccess: 'available', validUntil: new Date(now.getTime() + 60_000).toISOString() }
  const candidate = { participantId: 'p1', origin: 'life-event', disclosure: 'personal', motive: 'x', sourceEntryIds: [1], outcome: 'send-now' }
  assert.equal(evaluateAgencyCapacity(window, candidate, now, cfg, undefined).reason, 'privacy-insufficient')
})

check('evaluateAgencyCapacity：容量可用放行', () => {
  const cfg = resolveAgencyConfig({})
  const now = new Date()
  const window = { activityLoad: 'free', privacy: 'private', deviceAccess: 'available', validUntil: new Date(now.getTime() + 60_000).toISOString() }
  const candidate = { participantId: 'p1', origin: 'life-event', disclosure: 'ordinary', motive: 'x', sourceEntryIds: [1], outcome: 'send-now' }
  assert.equal(evaluateAgencyCapacity(window, candidate, now, cfg, undefined).allowed, true)
})

check('normalizeAgencyWindowState：非法枚举返回 undefined', () => {
  assert.equal(normalizeAgencyWindowState({ activityLoad: 'bad' }), undefined)
})

check('proactiveCandidateFingerprint 与 promise 绕过间隔', () => {
  const c = { participantId: 'p1', origin: 'life-event', sourceEntryIds: [2, 1] }
  assert.equal(proactiveCandidateFingerprint(c), 'p1|life-event|1,2')
  assert.equal(proactiveOriginBypassesOrdinaryInterval('promise'), true)
  assert.equal(proactiveOriginBypassesOrdinaryInterval('life-event'), false)
})

/* ---------------------------------------------------------------- preplan */

check('materializeSchedulePreplan：周规律展开为逐日', () => {
  const regimes = [{
    id: 'week', label: '上课', from: '2026-09-01', weekly: {
      monday: [{ id: 'm1', start: '09:00', end: '12:00', label: '上课', kind: 'fixed' }],
    },
  }]
  const days = materializeSchedulePreplan(regimes, [], '2026-09-07', 7)
  assert.equal(days.length, 7)
  // 2026-09-07 是周一
  assert.equal(days[0].date, '2026-09-07')
  assert.equal(days[0].blocks[0].label, '上课')
})

check('materializeSchedulePreplan：日期例外 replace 覆盖', () => {
  const regimes = [{
    id: 'week', label: '上课', from: '2026-09-01', weekly: {
      monday: [{ id: 'm1', start: '09:00', end: '12:00', label: '上课', kind: 'fixed' }],
    },
  }]
  const exceptions = [{ date: '2026-09-07', mode: 'replace', reason: '放假', blocks: [{ id: 'x', start: '10:00', end: '11:00', label: '补觉', kind: 'flexible' }] }]
  const days = materializeSchedulePreplan(regimes, exceptions, '2026-09-07', 1)
  assert.equal(days[0].blocks[0].label, '补觉')
})

check('schedulePreplanWindow：只投影未来 12 小时', () => {
  const record = {
    storyId: 's', timezone: 'Asia/Shanghai', revision: 1,
    materializedDays: [{ date: '2026-09-11', blocks: [{ id: 'b', start: '10:00', end: '11:00', label: '例会', kind: 'fixed' }] }],
  }
  const now = new Date('2026-09-11T01:00:00Z') // 09:00 本地
  const w = schedulePreplanWindow(record, now, 'Asia/Shanghai', 12)
  assert.ok(w)
  assert.equal(w.blocks.length, 1)
  assert.equal(w.blocks[0].label, '例会')
})

check('schedulePreplanWindow：时区不匹配返回 null', () => {
  const record = { storyId: 's', timezone: 'UTC', revision: 1, materializedDays: [] }
  assert.equal(schedulePreplanWindow(record, new Date(), 'Asia/Shanghai', 12), null)
})

check('nextSchedulePreplanTransition：固定日程边界成为锚点', () => {
  const record = {
    storyId: 's', timezone: 'Asia/Shanghai', revision: 1,
    materializedDays: [{ date: '2026-09-11', blocks: [{ id: 'b', start: '10:00', end: '11:00', label: '例会', kind: 'fixed' }] }],
  }
  const now = new Date('2026-09-11T01:00:00Z') // 09:00 本地
  const next = nextSchedulePreplanTransition(record, now, 'Asia/Shanghai', 12)
  assert.ok(next instanceof Date)
  assert.ok(next.getTime() > now.getTime())
})

check('applySchedulePreplanProposal：replace 建立新日程', () => {
  const cfg = resolveSchedulePreplanConfig({ horizonDays: 7 })
  const now = new Date()
  const proposal = { outcome: 'replace', reason: '新日程', regimes: [{ id: 'r', label: '作息', from: '2026-09-11', sourceEntryIds: [3], weekly: { monday: [{ id: 'b', start: '09:00', end: '10:00', label: '晨练', kind: 'routine' }] } }], exceptions: [] }
  const record = applySchedulePreplanProposal(undefined, proposal, [{ id: 3 }], '2026-09-11', 'Asia/Shanghai', cfg, now, 'stable')
  assert.ok(record)
  assert.equal(record.revision, 1)
  assert.equal(record.regimes[0].label, '作息')
})

check('applySchedulePreplanProposal：非法提议保留原日程', () => {
  const cfg = resolveSchedulePreplanConfig({ horizonDays: 7 })
  const now = new Date()
  const existing = { storyId: '', revision: 1, timezone: 'Asia/Shanghai', validFrom: '2026-09-10', validThrough: '2026-09-16', lastReviewedLocalDate: '2026-09-10', lastEvidenceEntryId: 0, reviewReason: '', regimes: [], exceptions: [], materializedDays: [], createdAt: now, updatedAt: now }
  const record = applySchedulePreplanProposal(existing, { outcome: 'bad', reason: '' }, [{ id: 1 }], '2026-09-11', 'Asia/Shanghai', cfg, now, 'stable')
  assert.equal(record.revision, 1) // 保留
})

/* -------------------------------------------- 长期事实的排序（不是取前 N 条） */

console.log('\n长期事实排序')

check('重要的挤掉不重要的（哪怕不重要的写得更晚）', () => {
  const now = Date.now()
  const state = emptyState()
  addFact(state, { content: '随口说过今天吃了面', importance: 0.1 }, now - 1000)
  addFact(state, { content: '答应过周末陪她去看展', importance: 0.95, scope: 'promise' }, now - 1000)
  const top = rankFacts(state, 1, now)
  assert.equal(top[0].content, '答应过周末陪她去看展')
})

check('未兑现的承诺获得额外权重（还欠着的事不该被挤掉）', () => {
  const now = Date.now()
  const state = emptyState()
  // 两条同等重要，一条是 promise、一条是 general
  addFact(state, { content: '普通事实', importance: 0.6, scope: 'general', confidence: 0.6 }, now)
  addFact(state, { content: '答应他的事', importance: 0.5, scope: 'promise', confidence: 0.5 }, now)
  assert.equal(rankFacts(state, 1, now)[0].content, '答应他的事')
})

check('时间衰减：很久没提起的事会沉下去', () => {
  const now = Date.now()
  const state = emptyState()
  const old = addFact(state, { content: '半年前的小事', importance: 0.5, confidence: 0.9 }, now)
  old.lastSeenAt = now - 180 * 86_400_000 // 180 天前
  addFact(state, { content: '昨天刚说的事', importance: 0.5, confidence: 0.5 }, now)
  assert.equal(rankFacts(state, 1, now)[0].content, '昨天刚说的事')
})

check('已关闭的事实不参与排序', () => {
  const now = Date.now()
  const state = emptyState()
  const fact = addFact(state, { content: '已经了结的事', importance: 1 }, now)
  closeFact(state, fact.id)
  assert.equal(rankFacts(state, 5, now).length, 0)
})

check('没有事实时安静返回空数组', () => {
  assert.deepEqual(rankFacts(emptyState(), 5), [])
  assert.deepEqual(rankFacts({}, 5), [])
})

check('limit 生效，且不改变原数组顺序', () => {
  const now = Date.now()
  const state = emptyState()
  addFact(state, { content: 'a', importance: 0.1 }, now)
  addFact(state, { content: 'b', importance: 0.9 }, now)
  addFact(state, { content: 'c', importance: 0.5 }, now)
  assert.equal(rankFacts(state, 2, now).length, 2)
  assert.deepEqual(state.facts.map(f => f.content), ['a', 'b', 'c'], '排序不该就地打乱存储顺序')
})

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n逻辑层：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  for (const f of failures) console.error(`\n[FAIL] ${f.name}\n${f.error.stack}`)
  process.exit(1)
}
