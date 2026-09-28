/**
 * 世界事件播种器 —— **生成侧（M2）**测试。
 *
 * 对齐上游 `src/service.ts` 的 `worldSeederSweep` / `buildWorldSeederPayload`
 * 与 `src/world-seeder.ts` 的 `acceptSeedDrafts` 等价逻辑：
 *   A. 频控与节律：抖动跳过、maxPending / dailyCap 上限、近 14 天摘要回传；
 *   B. 载荷：全摘要级、字段裁剪、预算、季节映射、拉黑名单过滤；
 *   C. 逐条采纳：high 每天至多 1 条、四道闸拒绝原因、上限 break；
 *   D. 端到端：注入执行器 → 生成 → 校验 → 入库 scheduled → 到点注入。
 *
 * 运行：node test/world-seeder-m2.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

import {
  resolveWorldSeederRuntime,
  buildWorldSeederPayload,
  planWorldSeederSweep,
  acceptSeedDrafts,
  worldSeederSeason,
} from '../lib/world-seeder.js'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-seeder2', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../lib/index.js')
const { BindingStore } = await import('../lib/qq-im/binding.js')

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const NOW = new Date('2026-09-28T20:00:00+08:00')
const runtime = () => resolveWorldSeederRuntime({ enabled: true }, { enabled: true })
const ev = (over = {}) => ({
  id: 1, summary: '楼下开始装修', importance: 'low',
  occursAt: new Date(NOW.getTime() + 3600_000).toISOString(), expiresAt: null,
  status: 'scheduled', subjects: [], injectedAt: null, ...over,
})

console.log('世界事件播种器（M2 生成侧）')

/* ─────────────────────── A. 频控与节律 ─────────────────────── */

await check('抖动：随机值 < 0.25 时跳过本轮（避免固定节律感）', () => {
  const base = { events: [], runtime: runtime(), now: NOW.getTime() }
  assert.equal(planWorldSeederSweep({ ...base, random: () => 0.1 }).reason, 'jitter')
  assert.equal(planWorldSeederSweep({ ...base, random: () => 0.9 }).proceed, true)
})

await check('频控：挂起数达 maxPending、当日注入达 dailyCap → 不生成', () => {
  const r = { ...runtime(), maxPending: 2, dailyCap: 2 }
  const scheduled = [ev({ id: 1 }), ev({ id: 2 })]
  const p1 = planWorldSeederSweep({ events: scheduled, runtime: r, now: NOW.getTime(), random: () => 0.9 })
  assert.equal(p1.proceed, false)
  assert.equal(p1.reason, 'max-pending')

  const injected = [
    ev({ id: 3, status: 'injected', injectedAt: new Date(NOW.getTime() - 3600_000).toISOString() }),
    ev({ id: 4, status: 'injected', injectedAt: new Date(NOW.getTime() - 7200_000).toISOString() }),
  ]
  const p2 = planWorldSeederSweep({ events: injected, runtime: r, now: NOW.getTime(), random: () => 0.9 })
  assert.equal(p2.reason, 'daily-cap')
  assert.equal(p2.injectedToday, 2)
})

await check('近 14 天已注入摘要回传（去重闸输入），更早的不带', () => {
  const events = [
    ev({ id: 1, status: 'injected', injectedAt: new Date(NOW.getTime() - 2 * 86400_000).toISOString(), summary: '两天前的事' }),
    ev({ id: 2, status: 'injected', injectedAt: new Date(NOW.getTime() - 30 * 86400_000).toISOString(), summary: '一个月前的事' }),
  ]
  const plan = planWorldSeederSweep({ events, runtime: runtime(), now: NOW.getTime(), random: () => 0.9 })
  assert.deepEqual(plan.recentSummaries, ['两天前的事'])
})

await check('disabled → 不生成', () => {
  const off = resolveWorldSeederRuntime({ enabled: true }, undefined)
  assert.equal(planWorldSeederSweep({ events: [], runtime: off, now: NOW.getTime(), random: () => 0.9 }).reason, 'disabled')
})

/* ─────────────────────────── B. 载荷 ─────────────────────────── */

await check('季节映射：3–5 春 / 6–8 夏 / 9–11 秋 / 其余冬', () => {
  assert.equal(worldSeederSeason(4), 'spring')
  assert.equal(worldSeederSeason(7), 'summer')
  assert.equal(worldSeederSeason(10), 'autumn')
  assert.equal(worldSeederSeason(1), 'winter')
  assert.equal(worldSeederSeason(12), 'winter')
})

await check('载荷：字段裁剪、预算、拉黑名单过滤、约束写入', () => {
  const long = 'x'.repeat(1000)
  const payload = JSON.parse(buildWorldSeederPayload({
    now: NOW,
    timezone: 'Asia/Shanghai',
    story: { character: { name: '江柚', profile: long }, world: { setting: long, location: long, supportingCast: long } },
    recentEntries: Array.from({ length: 20 }, (_, i) => ({ kind: 'script', at: NOW.toISOString(), text: `第${i}条` })),
    currentScene: long,
    workingDetails: Array.from({ length: 12 }, (_, i) => ({ label: `l${i}`, value: `v${i}` })),
    blockedNames: ['小鹿', '林', ''],
    recentSummaries: Array.from({ length: 14 }, (_, i) => `事件${i}`),
    runtime: runtime(),
  }))
  assert.equal(payload.season, 'autumn', '9 月应是秋天')
  assert.equal(payload.worldSetting.characterName, '江柚')
  assert.equal(payload.worldSetting.characterProfile.length, 600, 'profile 截断到 600')
  assert.equal(payload.worldSetting.world.length, 800)
  assert.equal(payload.worldSetting.location.length, 300)
  assert.equal(payload.worldSetting.supportingCast.length, 400)
  assert.equal(payload.currentScene.length, 500)
  assert.ok(payload.recentEstablishedLife.length <= 14, '历史最多 14 条（上游 slice(-14)）')
  assert.equal(payload.workingDetails.length, 8, '在办细节最多 8 条（上游 slice(-8)）')
  assert.deepEqual(payload.blockedNames, ['小鹿'], '长度 <2 的名字被过滤（上游 filter length>=2）')
  assert.equal(payload.recentlySeededEvents.length, 10, '近期已播种最多 10 条（上游 slice(-10)）')
  assert.equal(payload.constraints.dailyBudget, runtime().dailyCap)
  assert.ok(payload.constraints.note.includes('BLOCKED NAMES'))
  assert.ok(payload.nowLocal.length > 0)
})

await check('载荷：预算裁剪（近处优先，不超预算）', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ kind: 'script', at: NOW.toISOString(), text: 'y'.repeat(240) }))
  const payload = JSON.parse(buildWorldSeederPayload({
    now: NOW, timezone: 'Asia/Shanghai', story: {}, recentEntries: entries, runtime: runtime(),
  }))
  const total = payload.recentEstablishedLife.reduce((sum, item) => sum + item.text.length, 0)
  assert.ok(total <= 2000, `载荷预算应 ≤2000，实际 ${total}`)
  assert.ok(payload.recentEstablishedLife.length > 0, '至少带一条')
})

/* ─────────────────────── C. 逐条采纳 ─────────────────────── */

const validationInput = () => ({
  now: NOW, timezone: 'Asia/Shanghai', maxHorizonHours: 72, blockedNames: [], recentSummaries: [],
})
const draft = (over = {}) => ({
  summary: '小区忽然停水', importance: 'low',
  occursAt: new Date(NOW.getTime() + 3600_000), subjects: [], rationale: 'r', ...over,
})

await check('采纳：high 每天至多 1 条', () => {
  const drafts = [draft({ summary: 'A', importance: 'high' }), draft({ summary: 'B', importance: 'high' })]
  const { accepted, rejected } = acceptSeedDrafts(drafts, validationInput(), {
    maxPending: 4, dailyCap: 4, scheduled: 0, injectedToday: 0, highToday: 0,
  })
  assert.equal(accepted.length, 1, '第二条 high 应被拦下')
  assert.equal(rejected[0].reason, 'high-daily-cap')
})

await check('采纳：上限到达即 break（不再采纳后续）', () => {
  const drafts = [draft({ summary: 'A' }), draft({ summary: 'B' }), draft({ summary: 'C' })]
  const { accepted } = acceptSeedDrafts(drafts, validationInput(), {
    maxPending: 2, dailyCap: 4, scheduled: 0, injectedToday: 0, highToday: 0,
  })
  assert.equal(accepted.length, 2, 'maxPending=2 时最多采纳 2 条')
})

await check('采纳：四道闸的拒绝原因如实回传（不重试）', () => {
  const input = { ...validationInput(), blockedNames: ['小鹿'], recentSummaries: ['小区忽然停水'] }
  const drafts = [
    draft({ summary: '室友小鹿又来借东西' }),                                    // blocked-name
    draft({ summary: '小区忽然停水' }),                                          // duplicate
    draft({ summary: '深夜的事', importance: 'high', occursAt: new Date('2026-09-29T02:00:00+08:00') }), // night-high
    draft({ summary: '过去的', occursAt: new Date(NOW.getTime() - 1000) }),      // invalid-time
    draft({ importance: 'urgent' }),                                             // invalid-importance
    draft({ summary: '合法的新事件' }),                                          // 通过
  ]
  const { accepted, rejected } = acceptSeedDrafts(drafts, input, {
    maxPending: 4, dailyCap: 4, scheduled: 0, injectedToday: 0, highToday: 0,
  })
  assert.equal(accepted.length, 1)
  assert.deepEqual(rejected.map((r) => r.reason),
    ['blocked-name', 'duplicate', 'night-high', 'invalid-time', 'invalid-importance'])
})

/* ─────────────────────── D. 端到端（注入执行器） ─────────────────────── */

const PRESET_ID = 'preset-hds-seeder2'
const SESSION = 'session-seeder-m2'
const presetDir = path.join(TEST_HOME, '.agent-presets', PRESET_ID)
fs.mkdirSync(presetDir, { recursive: true })
fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: "测试"\n', 'utf8')

function makeState(over = {}) {
  const dir = path.join(TEST_HOME, 'hds-interlude')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(dir, `${SESSION}.json`), JSON.stringify({
    version: 1, sessionId: SESSION, canonInjected: true, canonInjectedIm: 'im', roleplay: false,
    turns: 3, lastUserAt: now - 3600_000, lastAssistantAt: now - 600_000, lastAutoAdvanceAt: now - 100,
    intents: [], ledger: { cursor: 0, nextId: 1, entries: [] },
    seededEvents: [], lastSeedSweepAt: null, ...over,
  }, null, 2), 'utf8')
}
const readState = () => JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hds-interlude', `${SESSION}.json`), 'utf8'))

async function boot({ seederEnabled = true, executor, blockedNames = [] } = {}) {
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, list: () => [], currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', { describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} })
  ctx.provide('configEditor', { entries: () => [], edit: async () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('agentPresets', { async register() { return async () => {} }, async resolve(id) { throw new Error(`Unknown ${id}`) } })
  ctx.provide('sessionController', { async resolveAgent() { return undefined } })
  if (typeof executor === 'function') ctx.__worldSeederExecute = executor

  const store = new BindingStore({ home: TEST_HOME })
  store.set({ conversationKey: 'c2c:USER1', sessionId: SESSION, botId: 'qq_test', name: '测试' })

  const cfg = plugin.Config({
    timeZone: 'Asia/Shanghai',
    runtime: { autoAdvanceEnabled: false, restWindows: [] },
    proactive: { enabled: false },
    im: { enabled: false, waitForTurnMs: 5000, bots: [{ botId: 'qq_test', appId: '1', alias: '测试', agentPreset: PRESET_ID }] },
    worldSeeder: { enabled: seederEnabled, cadenceMinutes: 45, blockedNames },
  })
  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(600)
  return ctx
}

/**
 * 重试启动直到**真正跑过一轮生成**。
 *
 * 上游语义里有 25% 的随机抖动跳过（`Math.random() < 0.25`，避免固定节律感），
 * 所以带执行器的集成用例天然带概率：单次可能整轮被跳过。
 * 每轮重建状态文件（避免 `lastSeedSweepAt` 节流），最多 6 次——
 * 连续 6 次被跳过的概率约 0.02%，足以判定「不是抖动而是真故障」。
 */
async function bootSeeded({ executor, blockedNames = [], attempts = 6 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    makeState()
    let called = false
    const ctx = await boot({
      blockedNames,
      executor: async (req) => { called = true; return executor(req) },
    })
    if (called) return { ctx, state: readState() }
  }
  throw new Error(`世界播种器连续 ${attempts} 次被抖动跳过（概率上不该发生）`)
}

await check('端到端：执行器给出事件 → 通过闸 → 入库 scheduled（并带上载荷为摘要级）', async () => {
  let seenPayload = null
  const occursAt = new Date(Date.now() + 2 * 3600_000).toISOString()
  const { state } = await bootSeeded({
    executor: async (req) => {
      seenPayload = JSON.parse(req.user)
      return { events: [{ summary: '楼下五金店开始装修，电钻声断断续续。', importance: 'low', occursAt, subjects: [], rationale: '质感级' }] }
    },
  })
  assert.equal(state.seededEvents.length, 1, '应排期一条事件')
  const event = state.seededEvents[0]
  assert.equal(event.status, 'scheduled')
  assert.equal(event.importance, 'low')
  assert.equal(event.subjects.length, 0)
  assert.equal(event.sourcePayload?.rationale, '质感级')
  assert.ok(Number.isFinite(state.lastSeedSweepAt), '应记录扫描时刻（节流用）')
  assert.ok(seenPayload, '执行器应收到载荷')
  assert.ok(seenPayload.worldSetting !== undefined && seenPayload.constraints, '载荷形状与上游一致')
  assert.ok(Array.isArray(seenPayload.blockedNames))
})

await check('端到端：未注入执行器 → 不生成（与上游「未勾选连接即关闭」一致）', async () => {
  makeState()
  await boot({ executor: undefined })
  const state = readState()
  assert.equal(state.seededEvents.length, 0, '没有执行器就不该排期')
  assert.equal(state.lastSeedSweepAt, null, '未开启可用性时连节流戳都不写')
})

await check('端到端：校验闸拦下的事件不入库', async () => {
  const { state } = await bootSeeded({
    blockedNames: ['小鹿'],
    executor: async () => ({ events: [
      { summary: '室友小鹿来了', importance: 'low', occursAt: new Date(Date.now() + 3600_000).toISOString() },
      { summary: '楼下停水了', importance: 'low', occursAt: new Date(Date.now() + 3600_000).toISOString() },
    ] }),
  })
  assert.equal(state.seededEvents.length, 1, '只应入库合法那条')
  assert.equal(state.seededEvents[0].summary, '楼下停水了')
})

await check('端到端：high 事件每天至多 1 条（同一轮两条 high 只收一条）', async () => {
  // 刻意放到**次日 14:00（故事时区白天）**：深夜 high 会被 night-high 闸拦下，
  // 那会掩盖本用例真正要验的「每天至多 1 条 high」。测试必须与运行时刻无关。
  const noon = new Date()
  noon.setDate(noon.getDate() + 1)
  noon.setHours(14, 0, 0, 0)
  const { state } = await bootSeeded({
    executor: async () => ({ events: [
      { summary: '公司来电话说有急事', importance: 'high', occursAt: noon.toISOString() },
      { summary: '房东突然说要涨租', importance: 'high', occursAt: new Date(noon.getTime() + 3600_000).toISOString() },
    ] }),
  })
  assert.equal(state.seededEvents.length, 1, 'high 每天至多 1 条')
  assert.equal(state.seededEvents[0].importance, 'high')
})

console.log(`\n世界事件生成侧（M2）：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
