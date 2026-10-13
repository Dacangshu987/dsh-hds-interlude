/**
 * 主动联系温度三模式 + 每日上限 0=不限（移植自上游 `1.0.1-rc25`）。
 *
 * 覆盖：
 *   A. schema：contactMode 三值、naturalMinimumIntervalMinutes 默认与夹取；
 *   B. evaluateAgencyCapacity：strict 间隔不变；natural/balanced 用更短安全间隔；
 *      仅当 natural 间隔小于普通间隔时生效；承诺型照旧绕过；
 *   C. 教义渲染：strict 字节不变；natural/balanced 追加情感动机行（balanced 多一条节制行）；
 *   D. maxPerDay=0 → 不限（配额闸与 storyMessageGate 的语义由集成测试覆盖，
 *      这里钉住渲染层面「今日已主动联系 X / 不限」的显示）。
 *
 * 运行：node test/contact-mode.test.mjs
 */
import assert from 'node:assert/strict'
import S from '@deepseek-ai/schemastery'
import { Agency } from '../lib/schema.js'
import { evaluateAgencyCapacity, resolveAgencyConfig, DEFAULT_AGENCY_CONFIG } from '../lib/agency.js'
import { renderRules, renderStatus } from '../lib/render.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('主动联系温度（rc25 移植）')

const parseAgency = (value) => S(Agency)(value)

/* ───────────────────────────── A. schema ───────────────────────────── */

check('schema：contactMode 三值与默认 strict；非法值拒绝', () => {
  assert.equal(parseAgency({}).contactMode, 'strict', '默认 strict（行为不变）')
  assert.equal(parseAgency({}).naturalMinimumIntervalMinutes, 30, '默认 30 分钟（与上游 naturalMinimumIntervalMinutes 一致）')
  assert.equal(parseAgency({ contactMode: 'natural' }).contactMode, 'natural')
  assert.equal(parseAgency({ contactMode: 'balanced' }).contactMode, 'balanced')
  assert.throws(() => parseAgency({ contactMode: 'bogus' }), '非法档位应拒绝')
  assert.equal(parseAgency({ naturalMinimumIntervalMinutes: 0 }).naturalMinimumIntervalMinutes, 0, '0 允许（立即解除间隔）')
})

check('resolveAgencyConfig：与 schema 默认对齐，含新字段', () => {
  const cfg = resolveAgencyConfig({})
  assert.equal(cfg.contactMode, 'strict')
  assert.equal(cfg.naturalMinimumIntervalMinutes, 30)
  assert.equal(DEFAULT_AGENCY_CONFIG.contactMode, 'strict')
})

/* ─────────────────────── B. 容量判定 ─────────────────────── */

const WINDOW = (over = {}) => ({
  activityLoad: 'free', privacy: 'private', deviceAccess: 'available',
  validUntil: new Date('2026-10-04T20:00:00+08:00').toISOString(),
  ...over,
})
const CANDIDATE = (over = {}) => ({
  participantId: 'p1', origin: 'life-event', disclosure: 'ordinary',
  motive: '想他了', sourceEntryIds: [1], outcome: 'send-now',
  ...over,
})
const NOW = new Date('2026-10-04T12:00:00+08:00')

check('strict：普通 60 分钟间隔不变（默认行为字节不变）', () => {
  const cfg = resolveAgencyConfig({ minimumProactiveIntervalMinutes: 60 })
  const lastContact = new Date(NOW.getTime() - 30 * 60_000).toISOString()
  const r = evaluateAgencyCapacity(WINDOW(), CANDIDATE(), NOW, cfg, lastContact)
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'minimum-proactive-interval')
  assert.equal(new Date(r.nextOpportunityAt).getTime() - new Date(lastContact).getTime(), 60 * 60_000, '仍按 60 分钟')
  // 超过间隔 → 放行
  const ok = evaluateAgencyCapacity(WINDOW(), CANDIDATE(), NOW, cfg, new Date(NOW.getTime() - 61 * 60_000).toISOString())
  assert.equal(ok.allowed, true)
})

check('natural/balanced：安全间隔换成 naturalMinimumIntervalMinutes（仅当更小时生效）', () => {
  // natural 30 < 普通 60 → 用 30
  const cfg = resolveAgencyConfig({
    minimumProactiveIntervalMinutes: 60, contactMode: 'natural', naturalMinimumIntervalMinutes: 30,
  })
  const lastContact = new Date(NOW.getTime() - 40 * 60_000).toISOString()
  const r = evaluateAgencyCapacity(WINDOW(), CANDIDATE(), NOW, cfg, lastContact)
  assert.equal(r.allowed, true, '40 分钟 > 30 分钟 natural 间隔 → 放行（strict 下会被拦）')
  // natural 间隔 >= 普通间隔 → 回落普通间隔（取 min 语义）
  const cfg2 = resolveAgencyConfig({
    minimumProactiveIntervalMinutes: 60, contactMode: 'natural', naturalMinimumIntervalMinutes: 90,
  })
  const r2 = evaluateAgencyCapacity(WINDOW(), CANDIDATE(), NOW, cfg2, new Date(NOW.getTime() - 70 * 60_000).toISOString())
  assert.equal(r2.allowed, true, '70 分钟 > 60 分钟 → 放行')
  const r3 = evaluateAgencyCapacity(WINDOW(), CANDIDATE(), NOW, cfg2, new Date(NOW.getTime() - 50 * 60_000).toISOString())
  assert.equal(r3.allowed, false, '50 分钟 < 60 分钟 → 仍拦（min 生效，不放大到 90）')
  assert.equal(new Date(r3.nextOpportunityAt).getTime() - new Date(NOW.getTime() - 50 * 60_000).getTime(), 60 * 60_000, '按普通 60 分钟排下次')
  // balanced 同样生效
  const cfg3 = resolveAgencyConfig({
    minimumProactiveIntervalMinutes: 60, contactMode: 'balanced', naturalMinimumIntervalMinutes: 15,
  })
  assert.equal(evaluateAgencyCapacity(WINDOW(), CANDIDATE(), NOW, cfg3, new Date(NOW.getTime() - 20 * 60_000).toISOString()).allowed, true)
})

check('承诺型照旧绕过间隔；容量硬门（过载/设备/隐私）不受温度影响', () => {
  const cfg = resolveAgencyConfig({ minimumProactiveIntervalMinutes: 60, contactMode: 'natural' })
  const lastContact = new Date(NOW.getTime() - 1 * 60_000).toISOString()
  const promise = evaluateAgencyCapacity(WINDOW(), CANDIDATE({ origin: 'promise' }), NOW, cfg, lastContact)
  assert.equal(promise.allowed, true, '承诺型不经过间隔闸（原本就绕过）')
  const overload = evaluateAgencyCapacity(WINDOW({ activityLoad: 'overloaded' }), CANDIDATE(), NOW, cfg, undefined)
  assert.equal(overload.allowed, false, '过载硬门仍在')
  const noDevice = evaluateAgencyCapacity(WINDOW({ deviceAccess: 'unavailable' }), CANDIDATE(), NOW, cfg, undefined)
  assert.equal(noDevice.allowed, false, '设备硬门仍在')
})

/* ─────────────────────── C. 教义渲染 ─────────────────────── */

const render = (agency) => String(renderRules({
  im: { enabled: false },
  agency,
  alterSystem: { enabled: false }, schedulePreplan: { enabled: false },
}, { imActive: false }))

check('渲染：strict（默认）字节不变——只有基线行，无情感动机行', () => {
  const text = render({ enabled: true })
  assert.ok(text.includes('主动联系要有生活理由，并受日程/隐私/设备与频率的约束；不凭空打扰。'))
  assert.ok(!text.includes('想念'), 'strict 不应出现情感动机教义')
  const strict = render({ enabled: true, contactMode: 'strict' })
  assert.ok(!strict.includes('想念'))
})

check('渲染：natural 追加情感动机行；balanced 额外一条节制行', () => {
  const natural = render({ enabled: true, contactMode: 'natural' })
  assert.ok(natural.includes('想念、好奇近况、想分享此刻也是合法的主动联系动机'))
  assert.ok(natural.includes('安静仍然是合法的'), '保留不联系的出口')
  assert.ok(!natural.includes('节制使用'), 'natural 没有节制行')
  const balanced = render({ enabled: true, contactMode: 'balanced' })
  assert.ok(balanced.includes('想念、好奇近况、想分享此刻也是合法的主动联系动机'))
  assert.ok(balanced.includes('须节制使用'), 'balanced 才有节制行')
})

check('渲染状态卡：非 strict 档显示联系温度；strict 不显示', () => {
  const statusOf = (agency) => String(renderStatus({
    now: NOW.getTime(), zone: 'Asia/Shanghai', state: {}, config: { agency }, due: [],
  }))
  assert.ok(statusOf({ enabled: true, contactMode: 'natural', naturalMinimumIntervalMinutes: 30 }).includes('联系温度：natural'))
  assert.ok(statusOf({ enabled: true, contactMode: 'balanced', naturalMinimumIntervalMinutes: 30 }).includes('联系温度：balanced'))
  assert.ok(!statusOf({ enabled: true, contactMode: 'strict' }).includes('联系温度'))
})

/* ─────────────────────── D. maxPerDay=0 → 不限 ─────────────────────── */

check('状态卡：maxPerDay=0 时显示「不限」', () => {
  const text = String(renderStatus({
    now: NOW.getTime(), zone: 'Asia/Shanghai',
    state: { reachedOut: 2 },
    config: { proactive: { maxPerDay: 0 }, agency: { enabled: false } }, due: [],
  }))
  assert.ok(text.includes('今日已主动联系：2 / 不限'), `实际输出：${text.split('\n').find((l) => l.includes('主动联系'))}`)
})

check('状态卡：maxPerDay 正常值照旧显示数字', () => {
  const text = String(renderStatus({
    now: NOW.getTime(), zone: 'Asia/Shanghai',
    state: { reachedOut: 2 },
    config: { proactive: { maxPerDay: 6 }, agency: { enabled: false } }, due: [],
  }))
  assert.ok(text.includes('今日已主动联系：2 / 6'))
})

/* ─────────── 长线叙事催化器的累计结果（对齐上游 longHorizon 段） ─────────── */

check('状态卡：长线叙事**未启用**时不占一行', () => {
  const text = String(renderStatus({
    now: NOW.getTime(), zone: 'Asia/Shanghai',
    // 即使状态里有累计结果，配置没开也不该显示。
    state: { longHorizon: { score: 30, privateCount: 30, groupCount: 0, reason: 'first-trigger', wouldTrigger: true } },
    config: { agency: { enabled: false } }, due: [],
  }))
  assert.ok(!text.includes('长线叙事'), '默认关，不该显示')
})

check('状态卡：长线叙事启用后显示加权分与判定结论', () => {
  const textOf = (lh) => String(renderStatus({
    now: NOW.getTime(), zone: 'Asia/Shanghai',
    state: { longHorizon: lh },
    config: { longHorizon: { enabled: true }, agency: { enabled: false } }, due: [],
  }))
  // 该触发：如实标出「生成通道未接线」，不假装已经有了一段长线指导。
  const hit = textOf({ score: 30, privateCount: 30, groupCount: 0, reason: 'first-trigger', wouldTrigger: true })
  assert.ok(hit.includes('加权分 30'), `应显示分数：${hit.split('\n').find(l => l.includes('长线叙事'))}`)
  assert.ok(hit.includes('私聊 30 / 群聊 0'), '应分开显示两个来源的条数')
  assert.ok(hit.includes('首次达标'), 'reason 应译成人话')
  assert.ok(hit.includes('该触发'), '达标时应标出')
  assert.ok(hit.includes('生成通道未接线'), '不假装已生成')
  // 未达标：不该出现「该触发」。
  const miss = textOf({ score: 5, privateCount: 5, groupCount: 0, reason: 'not-due' })
  assert.ok(miss.includes('还没到'), '未达标')
  assert.ok(!miss.includes('该触发'), '未达标不该标「该触发」')
  // 还没评估过：如实说「尚未评估」，而不是显示 0 分像「算过了」。
  const fresh = textOf(undefined)
  assert.ok(fresh.includes('尚未评估'), '无累计器时如实标注')
})

console.log(`\n主动联系温度：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
