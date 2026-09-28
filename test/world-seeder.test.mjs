/**
 * 世界事件播种器（World Event Seeder）测试。
 *   移植自上游 `1.0.1-rc23` 的 `src/world-seeder.ts` 与
 *   `docs/WORLD_EVENT_SEEDER_DESIGN.md §6 宿主校验闸 / §7 注入机制`。
 *
 * 覆盖：
 *   A. 校验闸（宁可错杀，不重试）：时间窗 / 拉黑 / 深夜 high / bigram 去重 / 形状与档位；
 *   B. 解析闸：防御解析（坏项丢弃、字段裁剪）；
 *   C. Jaccard 相似度与上游口径一致；
 *   D. 事件表归一与状态机（scheduled→injected/expired/dropped）；
 *   E. 到点排水：按 occursAt 升序、过期作废、每日上限丢弃。
 *
 * 运行：node test/world-seeder.test.mjs
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_WORLD_SEEDER_RUNTIME,
  resolveWorldSeederRuntime,
  worldSeederSystemPrompt,
  summaryJaccard,
  validateSeedEvent,
  parseWorldSeedEvents,
  normalizeSeededEvent,
  normalizeSeededEvents,
  planSeedDrain,
  worldEventContent,
  createWorldSeeder,
  WORLD_EVENT_PREFIX,
} from '../lib/world-seeder.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TZ = 'Asia/Shanghai'
const NOW = new Date('2026-09-28T20:00:00+08:00')
const BASE = { now: NOW, timezone: TZ, maxHorizonHours: 72, blockedNames: [], recentSummaries: [] }
const draft = (over = {}) => ({
  summary: '楼下五金店开始装修，电钻声断断续续。',
  importance: 'low',
  occursAt: new Date(NOW.getTime() + 3 * 3600_000),
  subjects: [],
  rationale: '上午在家，质感级噪音事件',
  ...over,
})

console.log('世界事件播种器（rc23 移植）')

/* ───────────────────────────── A. 六道校验闸 ───────────────────────────── */

check('闸① 时间窗：过去 / 超时限 / 非法时间一律拒', () => {
  assert.equal(validateSeedEvent(draft(), BASE), undefined, '合法事件应通过')
  assert.equal(validateSeedEvent(draft({ occursAt: new Date(NOW.getTime() - 1000) }), BASE), 'invalid-time', '过去应拒')
  assert.equal(validateSeedEvent(draft({ occursAt: new Date(NOW.getTime() + 73 * 3600_000) }), BASE), 'invalid-time', '超 72h 应拒')
  assert.equal(validateSeedEvent(draft({ occursAt: new Date('bogus') }), BASE), 'invalid-time', '非法时间应拒')
  // 边界：恰好等于 now 也算过去（time <= now）
  assert.equal(validateSeedEvent(draft({ occursAt: new Date(NOW.getTime()) }), BASE), 'invalid-time')
})

check('闸② 拉黑：摘要或 subjects 命中参与者名字即拒（含双向包含）', () => {
  const blocked = { ...BASE, blockedNames: ['小鹿'] }
  assert.equal(validateSeedEvent(draft({ summary: '室友小鹿点了炸鸡' }), blocked), 'blocked-name')
  assert.equal(validateSeedEvent(draft({ subjects: ['小鹿'] }), blocked), 'blocked-name')
  assert.equal(validateSeedEvent(draft({ subjects: ['小鹿鹿'] }), blocked), 'blocked-name', '双向包含也算命中')
  // 单字名字不参与（避免误杀）：上游要求 trimmed.length >= 2
  assert.equal(validateSeedEvent(draft({ summary: '林来了' }), { ...BASE, blockedNames: ['林'] }), undefined)
  assert.equal(validateSeedEvent(draft(), blocked), undefined, '未命中应通过')
})

check('闸③ 深夜 high：故事时区 0:00–6:00 的 high 事件拒，low/medium 不受限', () => {
  const lateNight = new Date('2026-09-29T02:00:00+08:00')
  assert.equal(validateSeedEvent(draft({ importance: 'high', occursAt: lateNight }), BASE), 'night-high')
  assert.equal(validateSeedEvent(draft({ importance: 'medium', occursAt: lateNight }), BASE), undefined, 'medium 不受深夜限制')
  assert.equal(validateSeedEvent(draft({ importance: 'low', occursAt: lateNight }), BASE), undefined)
  // 白天 high 可以
  assert.equal(validateSeedEvent(draft({ importance: 'high', occursAt: new Date('2026-09-29T14:00:00+08:00') }), BASE), undefined)
  // 时区不同 → 深夜判定跟着变：同一 UTC 时刻在 UTC 下是 18:00，不算深夜
  assert.equal(validateSeedEvent(draft({ importance: 'high', occursAt: lateNight }), { ...BASE, timezone: 'UTC' }), undefined)
})

check('闸④ 去重：与近期摘要 bigram Jaccard > 0.6 即拒', () => {
  const recent = { ...BASE, recentSummaries: ['楼下五金店开始装修，电钻声断断续续。'] }
  assert.equal(validateSeedEvent(draft(), recent), 'duplicate', '近重复应拒')
  assert.equal(validateSeedEvent(draft({ summary: '楼下五金店开始装修，电钻声断断续续' }), recent), 'duplicate', '标点差异仍算重复')
  assert.equal(validateSeedEvent(draft({ summary: '小区忽然停水，物业贴了通知。' }), recent), undefined, '不同事件应通过')
  assert.ok(summaryJaccard('楼下五金店开始装修', '楼下五金店开始装修') === 1, '完全相同应为 1')
  assert.equal(summaryJaccard('', '任何'), 0, '空串应为 0')
})

check('闸⑤/⑥ 形状与档位：空摘要 / 超长 / 非法 importance 拒', () => {
  assert.equal(validateSeedEvent(draft({ summary: '   ' }), BASE), 'empty-summary')
  assert.equal(validateSeedEvent(draft({ summary: 'x'.repeat(201) }), BASE), 'empty-summary')
  assert.equal(validateSeedEvent(draft({ importance: 'urgent' }), BASE), 'invalid-importance')
})

/* ───────────────────────────── B. 防御解析 ───────────────────────────── */

check('解析闸：坏项丢弃、字段裁剪、expiresAt 必须晚于 occursAt', () => {
  const parsed = parseWorldSeedEvents({
    events: [
      { summary: '快递到了，放在门口。', importance: 'low', occursAt: '2026-09-29T10:00:00+08:00', subjects: [' 小鹿 ', 123, ''], rationale: 'r' },
      { summary: '', importance: 'low', occursAt: '2026-09-29T10:00:00+08:00' },
      { summary: '坏档位', importance: 'urgent', occursAt: '2026-09-29T10:00:00+08:00' },
      { summary: '坏时间', importance: 'low', occursAt: 'nope' },
      { summary: '第三个（超出 limit 2）', importance: 'low', occursAt: '2026-09-29T10:00:00+08:00' },
    ],
  })
  assert.equal(parsed.length, 1, '只有第 1 条合法')
  assert.deepEqual(parsed[0].subjects, ['小鹿'], '非字符串 subject 应被剔除')
  assert.ok(parsed[0].occursAt instanceof Date)
  // expiresAt 早于 occursAt → 丢弃该字段
  const p2 = parseWorldSeedEvents({ events: [{ summary: 'a', importance: 'low', occursAt: '2026-09-29T10:00:00+08:00', expiresAt: '2026-09-29T09:00:00+08:00' }] })
  assert.equal(p2[0].expiresAt, undefined)
  // 非对象/缺 events → 空数组，不抛
  assert.deepEqual(parseWorldSeedEvents(null), [])
  assert.deepEqual(parseWorldSeedEvents({ events: 'x' }), [])
})

/* ───────────────────────────── C. 运行配置 ───────────────────────────── */

check('运行配置：数值夹取 + 未指定执行器时 enabled 恒为 false', () => {
  const off = resolveWorldSeederRuntime({ enabled: true }, undefined)
  assert.equal(off.enabled, false, '没有执行器 → 关闭（等价于上游未勾选连接）')
  const on = resolveWorldSeederRuntime({ enabled: true, cadenceMinutes: 1, dailyCap: 99 }, { enabled: true })
  assert.equal(on.enabled, true)
  assert.equal(on.cadenceMinutes, 5, '下限 5 分钟')
  assert.equal(on.dailyCap, 20, '上限 20')
  assert.equal(resolveWorldSeederRuntime({}, { enabled: true }).enabled, false, '未显式 enabled → 关')
  assert.deepEqual(
    resolveWorldSeederRuntime(undefined, { enabled: true }).maxHorizonHours,
    DEFAULT_WORLD_SEEDER_RUNTIME.maxHorizonHours,
  )
  // 客户端：无执行器 → available=false 且 generate 抛错
  const client = createWorldSeeder(resolveWorldSeederRuntime({ enabled: true }, undefined), {})
  assert.equal(client.available, false)
})

check('生成侧接缝：注入执行器后 available=true，且把系统提示词逐字带上', async () => {
  const seen = []
  const runtime = resolveWorldSeederRuntime({ enabled: true }, { enabled: true })
  const client = createWorldSeeder(runtime, { execute: async (req) => { seen.push(req); return { events: [] } } })
  assert.equal(client.available, true)
  const out = await client.generate('当前时间：2026-09-28T20:00+08:00')
  assert.deepEqual(out, { events: [] })
  assert.equal(seen[0].system, worldSeederSystemPrompt(), '系统提示词必须与上游逐字一致')
  assert.equal(seen[0].task, '世界播种')
  assert.ok(worldSeederSystemPrompt().includes('MOST RUNS MUST RETURN an empty events array'), '必须保留「多数运行返回空」这条')
  assert.ok(worldSeederSystemPrompt().includes('BLOCKED NAMES'), '必须保留拉黑约束')
})

/* ───────────────────────────── D. 事件表与状态机 ───────────────────────────── */

check('事件表归一：坏项丢弃、id 去重、容量裁剪、nextId 只增', () => {
  const one = normalizeSeededEvent({ id: 3, summary: '停电通知', importance: 'medium', occursAt: '2026-09-29T10:00:00+08:00' })
  assert.equal(one.status, 'scheduled')
  assert.equal(one.importance, 'medium')
  assert.equal(normalizeSeededEvent({ id: 0, summary: 'x', occursAt: '2026-09-29T10:00:00+08:00' }), undefined, 'id<1 丢弃')
  assert.equal(normalizeSeededEvent({ id: 1, summary: '', occursAt: '2026-09-29T10:00:00+08:00' }), undefined, '空摘要丢弃')
  assert.equal(normalizeSeededEvent({ id: 1, summary: 'x', occursAt: 'bad' }), undefined, '坏时间丢弃')
  const table = normalizeSeededEvents([
    { id: 1, summary: 'a', occursAt: '2026-09-29T10:00:00+08:00' },
    { id: 1, summary: 'dup', occursAt: '2026-09-29T11:00:00+08:00' },
    { id: 2, summary: 'b', occursAt: '2026-09-29T12:00:00+08:00', importance: 'urgent' },
  ])
  assert.equal(table.events.length, 2, '同 id 只留一条')
  assert.equal(table.nextId, 3)
  assert.equal(table.events[1].importance, 'low', '非法 importance 回退 low')
})

check('到点排水：按 occursAt 升序；过期作废；未到点不动', () => {
  const now = NOW.getTime()
  const mk = (id, mins, status = 'scheduled', expiresAt = null) => ({
    id, summary: `事件${id}`, importance: 'low', status,
    occursAt: new Date(now + mins * 60_000).toISOString(), expiresAt,
  })
  const { due, expired } = planSeedDrain([
    mk(1, -30),               // 已到点
    mk(2, -10),               // 已到点（更晚）
    mk(3, 30),                // 未到点
    mk(4, -60, 'scheduled', new Date(now - 5 * 60_000).toISOString()), // 到点但已过期
    mk(5, -60, 'injected'),   // 已注入，不再处理
  ], now)
  assert.deepEqual(due.map((e) => e.id), [1, 2], 'due 应按 occursAt 升序，且不含未到点/已注入')
  assert.deepEqual(expired.map((e) => e.id), [4], '过期未注入 → expired')
})

check('注入条目正文带 [世界事件] 前缀（上游注入形态）', () => {
  assert.equal(worldEventContent({ summary: '快递到了' }), `${WORLD_EVENT_PREFIX}快递到了`)
  assert.equal(WORLD_EVENT_PREFIX, '[世界事件] ')
})

console.log(`\n世界事件播种器：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
