/**
 * 用户自报钟点的**提示词投影**测试（上游 `1.0.1-rc13` 的 `userReportedTimes`）。
 *
 * 上游把提取结果作为 payload 字段交给模型；本仓提示词是文本块，因此渲染成一条
 * 事实行。这里钉住三件事：
 *   ① 「他刚说完、正在回他」时出现，并带上钟点与相对关系；
 *   ② 她刚说完（lastAssistantAt ≥ lastUserAt）时**不出现**——那不是在回他，
 *      拿旧话里的钟点当"他刚才说的"就是凭空捏造；
 *   ③ 没有明确钟点时零开销、不出现。
 *
 * 运行：node test/user-reported-times-wiring.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { BindingStore } from '../lib/qq-im/binding.js'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-urt', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../lib/index.js')

const PRESET_ID = 'preset-hds-urt'
const SESSION = 'session-urt-1'
const presetDir = path.join(TEST_HOME, '.agent-presets', PRESET_ID)
fs.mkdirSync(presetDir, { recursive: true })
fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: "测试"\n', 'utf8')

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 写一份会话状态：ledger 末尾是给定的用户消息。 */
function makeState({ userText, lastUserAt, lastAssistantAt }) {
  const dir = path.join(TEST_HOME, 'hds-interlude')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const entries = []
  if (userText) {
    entries.push({
      id: 1, kind: 'user-message', participantId: SESSION, actor: 'user',
      content: userText, occurredAt: new Date(lastUserAt ?? now).toISOString(), metadata: {},
    })
  }
  fs.writeFileSync(path.join(dir, `${SESSION}.json`), JSON.stringify({
    version: 1, sessionId: SESSION, canonInjected: true, canonInjectedIm: 'im', roleplay: false,
    turns: 2, lastUserAt: lastUserAt ?? now, lastAssistantAt: lastAssistantAt ?? (now - 60_000),
    intents: [], ledger: { cursor: 0, nextId: entries.length + 1, entries },
  }, null, 2), 'utf8')
}

async function boot() {
  const agent = {
    session: { id: SESSION, header: { id: SESSION, agentPreset: PRESET_ID, cwd: TEST_HOME } },
    followup() {},
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
  const store = new BindingStore({ home: TEST_HOME })
  store.set({ conversationKey: 'c2c:USER1', sessionId: SESSION, botId: 'qq_test', name: '测试' })

  const cfg = plugin.Config({
    timeZone: 'Asia/Shanghai',
    runtime: { autoAdvanceEnabled: false, restWindows: [] },
    proactive: { enabled: false },
    im: { enabled: false, bots: [{ botId: 'qq_test', appId: '1', alias: '测试', agentPreset: PRESET_ID }] },
  })
  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(600)
  return { ctx, agent }
}

async function injectOnce(ctx, agent) {
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  return (decision.messages ?? [])
    .map((m) => (m.content ?? []).map((b) => b.text ?? '').join(''))
    .join('\n')
}

console.log('用户自报钟点投影（rc13）')

await check('他刚说完且带钟点 → 注入事实行（含钟点与相对关系）', async () => {
  // 故事时区 06:00 的「八点半」→ 还没到；用一个固定的过去时间做基准更稳：
  makeState({ userText: '我八点半开会', lastUserAt: Date.now(), lastAssistantAt: Date.now() - 60_000 })
  const { ctx, agent } = await boot()
  const text = await injectOnce(ctx, agent)
  assert.ok(text.includes('对方刚才亲口提到的钟点'), `应注入事实行，实际片段：${text.slice(-260)}`)
  assert.ok(text.includes('08:30'), '应含钟点 08:30（而非 08:00）')
  assert.ok(/（(还没到|已经过去|就是现在)）/.test(text), '应带相对关系标注')
})

await check('她刚说完（不是回他）→ 不注入（不能把旧话当"他刚才说"）', async () => {
  makeState({ userText: '我八点半开会', lastUserAt: Date.now() - 120_000, lastAssistantAt: Date.now() - 60_000 })
  const { ctx, agent } = await boot()
  const text = await injectOnce(ctx, agent)
  assert.ok(!text.includes('对方刚才亲口提到的钟点'), '不该把旧消息里的钟点当作他刚说的')
})

await check('没有明确钟点 → 零开销、不出现', async () => {
  makeState({ userText: '今天有点累，早点休息', lastUserAt: Date.now(), lastAssistantAt: Date.now() - 60_000 })
  const { ctx, agent } = await boot()
  const text = await injectOnce(ctx, agent)
  assert.ok(!text.includes('对方刚才亲口提到的钟点'))
  assert.ok(!text.includes('08:30'))
})

console.log(`\n用户自报钟点投影：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
