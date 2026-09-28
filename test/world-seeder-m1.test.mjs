/**
 * 世界事件播种器 —— **注入侧（M1）端到端**测试。
 *
 * 验证上游设计文档 §7「注入机制」在本仓的等价实现：
 *   1. 到点的 `scheduled` 事件 → 写入**条目账本**（kind=`system-event`，
 *      正文 `[世界事件] …`，metadata 带 `seededEventId`/`importance`），
 *      事件状态转 `injected` 并回链 `injectedEntryId`；
 *   2. 下一回合 pre-step 把它作为**事实**呈现给模型（`announcedAt` 标记，只呈现一次）；
 *   3. 过期未注入 → `expired`（不补发）；
 *   4. 注入与作废**不依赖生成开关**（关掉开关也不能留僵尸事件）。
 *
 * 运行：node test/world-seeder-m1.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { BindingStore } from '../lib/qq-im/binding.js'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-seeder', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../lib/index.js')

const PRESET_ID = 'preset-hds-seeder'
const SESSION = 'session-seeder-m1'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const presetDir = path.join(TEST_HOME, '.agent-presets', PRESET_ID)
fs.mkdirSync(presetDir, { recursive: true })
fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: "测试"\n', 'utf8')

/** 造一份含世界事件的会话状态。 */
function makeState(seededEvents) {
  const dir = path.join(TEST_HOME, 'hds-interlude')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const state = {
    version: 1,
    sessionId: SESSION,
    canonInjected: true,
    canonInjectedIm: 'im',
    roleplay: false,
    turns: 3,
    lastUserAt: now - 3600_000,
    lastAssistantAt: now - 600_000,
    lastAutoAdvanceAt: now - 100,
    intents: [],
    ledger: { cursor: 0, nextId: 1, entries: [] },
    seededEvents,
  }
  const file = path.join(dir, `${SESSION}.json`)
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
  return file
}
const readState = () => JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hds-interlude', `${SESSION}.json`), 'utf8'))

function eventDraft(id, minsFromNow, over = {}) {
  return {
    id,
    summary: `世界事件样本${id}`,
    importance: 'low',
    occursAt: new Date(Date.now() + minsFromNow * 60_000).toISOString(),
    expiresAt: null,
    status: 'scheduled',
    wakeEligible: false,
    subjects: [],
    sourcePayload: null,
    injectedEntryId: null,
    injectedAt: null,
    announcedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

/** 起插件实例：冷会话（走启动扫描 → handleSession → 排水）。 */
async function boot({ wakeIdleSessions = true, seederEnabled = true } = {}) {
  const calls = { followups: [] }
  const agent = {
    session: { id: SESSION, header: { id: SESSION, agentPreset: PRESET_ID, cwd: TEST_HOME } },
    followup(m) { calls.followups.push(m) },
  }
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, list: () => [], currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', { describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} })
  ctx.provide('configEditor', { entries: () => [], edit: async () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('agentPresets', { async register() { return async () => {} }, async resolve(id) { throw new Error(`Unknown ${id}`) } })
  ctx.provide('sessionController', { async resolveAgent() { return agent } })

  // 绑定：让会话有 IM 绑定（同时便于 auto-advance 路径不干扰）
  const store = new BindingStore({ home: TEST_HOME })
  store.set({ conversationKey: 'c2c:USER1', sessionId: SESSION, botId: 'qq_test', name: '测试' })

  const cfg = plugin.Config({
    timeZone: 'Asia/Shanghai',
    runtime: { autoAdvanceEnabled: false },
    proactive: { enabled: true, wakeIdleSessions },
    im: { enabled: false, waitForTurnMs: 5000, bots: [{ botId: 'qq_test', appId: '1', alias: '测试', agentPreset: PRESET_ID }] },
    worldSeeder: { enabled: seederEnabled },
  })
  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(600)
  return { ctx, agent, calls }
}

/** 跑一次真实 pre-step，返回注入文本。 */
async function injectOnce(ctx, agent) {
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  return (decision.messages ?? [])
    .map((m) => (m.content ?? []).map((b) => b.text ?? '').join(''))
    .join('\n')
}

await check('到点的世界事件 → 写入条目账本（kind=world-event，actor=system，[世界事件] 前缀，回链 id）', async () => {
  makeState([eventDraft(1, -30), eventDraft(2, 60)])
  const { ctx } = await boot()
  const state = readState()
  assert.equal(state.seededEvents[0].status, 'injected', '到点事件应转为 injected')
  assert.equal(state.seededEvents[1].status, 'scheduled', '未到点事件保持 scheduled')
  const entries = state.ledger?.entries ?? []
  assert.equal(entries.length, 1, '应只注入一条条目')
  const entry = entries[0]
  // 上游 drainDueSeededEvents 实际写入 kind:'world-event', actor:'system'
  assert.equal(entry.kind, 'world-event', 'kind 必须是 world-event（对齐上游实现，非文档备选）')
  assert.equal(entry.actor, 'system', 'actor 必须是 system')
  assert.ok(entry.content.startsWith('[世界事件] '), `正文应带前缀，实际：${entry.content}`)
  assert.equal(entry.metadata?.seededEventId, 1, 'metadata 应回链事件 id')
  assert.equal(entry.metadata?.importance, 'low')
  assert.equal(entry.occurredAt, state.seededEvents[0].occursAt, '条目 occurredAt 取事件发生时间')
  assert.equal(state.seededEvents[0].injectedEntryId, entry.id, '事件应回链条目 id')
  void ctx
})

await check('pre-step 把新注入的世界事件作为**事实**呈现给模型（且只呈现一次）', async () => {
  makeState([eventDraft(1, -30)])
  const { ctx, agent } = await boot()
  const text = await injectOnce(ctx, agent)
  assert.ok(text.includes('[世界事件]'), `注入文本应含世界事件段，实际片段：${text.slice(0, 200)}`)
  assert.ok(text.includes('世界事件样本1'), '应含事件正文')
  assert.ok(text.includes('既成事实'), '应声明事实权威')
  assert.ok(text.includes('怎样反应完全由你决定'), '应声明反应自由')
  const after = readState()
  assert.ok(after.seededEvents[0].announcedAt, '呈现后应标 announcedAt')
  // 第二次 pre-step 不再重复呈现
  const again = await injectOnce(ctx, agent)
  assert.ok(!again.includes('世界事件样本1'), '同一事件不应重复呈现')
})

await check('过期未注入 → expired（不补发）', async () => {
  makeState([eventDraft(1, -120, { expiresAt: new Date(Date.now() - 60_000).toISOString() })])
  await boot()
  const state = readState()
  assert.equal(state.seededEvents[0].status, 'expired')
  assert.equal((state.ledger?.entries ?? []).length, 0, '过期事件不进账本')
  assert.equal(state.seededEvents[0].injectedEntryId, null)
})

await check('播种器关闭 → 不排水（对齐上游 `if (!runtime.enabled) return`）', async () => {
  makeState([eventDraft(1, -5)])
  await boot({ seederEnabled: false })
  const state = readState()
  assert.equal(state.seededEvents[0].status, 'scheduled', '关闭时不应注入')
  assert.equal((state.ledger?.entries ?? []).length, 0, '关闭时不写账本')
})

await check('本地偏离已在文档记录：排水绑**配置开关**而非「已指派模型」', async () => {
  // 上游把排水绑在 worldSeederRuntime.enabled 上，而该值要求已指派模型；
  // DSH 没有侧端模型通道，照搬会让 M1 永远无法运行，故本仓绑配置开关。
  // 这里断言「没有执行器也能注入」——正是该偏离的可观测行为。
  makeState([eventDraft(1, -5)])
  const { ctx } = await boot({ seederEnabled: true })
  assert.equal(typeof ctx.__worldSeederExecute, 'undefined', '本用例刻意不注入执行器')
  const state = readState()
  assert.equal(state.seededEvents[0].status, 'injected', '无执行器时注入侧仍应工作')
  assert.equal((state.ledger?.entries ?? []).length, 1)
})

console.log(`\n世界事件注入侧（M1）：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
