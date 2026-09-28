/**
 * 跨群投递测试（移植自上游 `1.0.1-rc11` 的 `crossConversationActions`）。
 *
 * 上游语义：私聊回合里她**可以另外**给某个群发一条消息；`availableGroupTargets`
 * 列出可发目标（是"可发对象"而非"已发回执"）；用精确 participantId；
 * 私聊回复与群里那条是两件事；**答应稍后发 ≠ 已经发了**；目的地不明不要猜。
 *
 * 本仓落地：`interlude_say` 的可选 `target` 参数（`group:<id>`），
 * 目标来自本 bot 已绑定的**群**会话 + 白名单；每回合上限 `maxPerTurn`；
 * 投递走通道一次（与回合结束的常规投递分开，避免冲掉 lastImDelivery 与投递账本）。
 *
 * 覆盖：
 *   A. 目标解析与提示段（私聊才有、群目标才列、白名单过滤、关闭则无）；
 *   B. 投递：带 target 的消息真的发到那个群，并记入 state.crossDeliveries；
 *   C. 拒绝路径：未知目标 / 超过每轮上限 / 自言自语 / 未启用；
 *   D. 常规（无 target）路径行为不变。
 *
 * 运行：node test/cross-conversation.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { BindingStore } from '../lib/qq-im/binding.js'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-cross', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../lib/index.js')

const PRESET_ID = 'preset-hds-cross'
const SESSION = 'session-cross-1'
const GROUP_KEY = 'group:777'
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

function makeState() {
  const dir = path.join(TEST_HOME, 'hds-interlude')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(dir, `${SESSION}.json`), JSON.stringify({
    version: 1, sessionId: SESSION, canonInjected: true, canonInjectedIm: 'im', roleplay: false,
    turns: 2, lastUserAt: now - 120_000, lastAssistantAt: now - 60_000,
    intents: [], ledger: { cursor: 0, nextId: 1, entries: [] },
  }, null, 2), 'utf8')
}
const readState = () => JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hds-interlude', `${SESSION}.json`), 'utf8'))

async function boot({ enabled = true, whitelist = [], maxPerTurn = 1, transport } = {}) {
  const agent = {
    session: { id: SESSION, header: { id: SESSION, agentPreset: PRESET_ID, cwd: TEST_HOME } },
    followup() {},
  }
  const tools = new Map()
  const sent = []
  const ctx = new Context()
  ctx.provide('agents', { get: () => agent, list: () => [agent], currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: (def) => { tools.set(def.name, def); return () => {} } })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', { describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} })
  ctx.provide('configEditor', { entries: () => [], edit: async () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('agentPresets', { async register() { return async () => {} }, async resolve(id) { throw new Error(`Unknown ${id}`) } })
  ctx.provide('sessionController', { async resolveAgent() { return agent } })
  // 通道出口：测试注入的 transport 走的是**同一条记账与分条路径**。
  ctx.__qqImTransport = transport ?? ((peer, chunk) => { sent.push({ peer, chunk }); return { sent: true } })

  const store = new BindingStore({ home: TEST_HOME })
  store.set({ conversationKey: 'c2c:USER1', sessionId: SESSION, botId: 'qq_test', name: '测试' })
  store.set({ conversationKey: GROUP_KEY, sessionId: 'session-group-777', botId: 'qq_test', name: '老同学群' })

  const cfg = plugin.Config({
    timeZone: 'Asia/Shanghai',
    runtime: { autoAdvanceEnabled: false, restWindows: [] },
    proactive: { enabled: false },
    im: {
      enabled: true, appId: 'test-app',
      bots: [{ botId: 'qq_test', appId: '1', alias: '测试', agentPreset: PRESET_ID }],
      crossConversation: { enabled, whitelist, maxPerTurn },
    },
  })
  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(600)
  return { ctx, agent, tools, sent }
}

async function injectOnce(ctx, agent) {
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  return (decision.messages ?? [])
    .map((m) => (m.content ?? []).map((b) => b.text ?? '').join(''))
    .join('\n')
}

console.log('跨群投递（rc11 移植）')

/* ─────────────────── A. 目标解析与提示段 ─────────────────── */

await check('私聊 + 已绑定群 → 注入【跨频道投递】段并列出精确 participantId', async () => {
  makeState()
  const { ctx, agent } = await boot()
  const text = await injectOnce(ctx, agent)
  assert.ok(text.includes('【跨频道投递】'), text.slice(-300))
  assert.ok(text.includes('target=`group:777`'), '应给出精确 participantId')
  assert.ok(text.includes('老同学群'), '应带上群名（上游 label）')
  assert.ok(text.includes('答应稍后发不等于已经发了'), '必须点明「承诺 ≠ 已发」')
  assert.ok(text.includes('不要想象群里的反应'), '必须禁止想象观众反应')
})

await check('未启用 → 不注入；白名单不含该群 → 不列出', async () => {
  makeState()
  const off = await boot({ enabled: false })
  const offText = await injectOnce(off.ctx, off.agent)
  assert.ok(!offText.includes('【跨频道投递】'))

  makeState()
  const filtered = await boot({ whitelist: ['group:999'] })
  const filteredText = await injectOnce(filtered.ctx, filtered.agent)
  assert.ok(!filteredText.includes('【跨频道投递】'), '白名单外不该出现')
})

/* ─────────────────── B. 投递 ─────────────────── */

await check('带 target → 真的发到那个群，并记入 state.crossDeliveries', async () => {
  makeState()
  const { ctx, agent, tools, sent } = await boot()
  await injectOnce(ctx, agent)  // 回合开始：上限归零
  const say = tools.get('interlude_say')
  assert.ok(say, 'interlude_say 应已注册')
  const reply = await say.execute({ text: '我先说一句\n再说一句', target: 'group:777' }, { agent })
  assert.ok(String(reply).includes('已发到'), String(reply))
  assert.ok(String(reply).includes('老同学群'))
  assert.equal(sent.length, 2, '两行文本 = 两条消息，transport 应收到两次')
  // 注意：transport 收到的是**已剥离 `group:` 前缀**的 targetId——
  // 前缀由通道（channel.js 的 send）在真正发送时才拼回去。
  assert.ok(sent.every((m) => m.peer === '777'), `两次都应发到群目标 777，实际 ${JSON.stringify(sent.map((m) => m.peer))}`)
  const state = readState()
  const record = (state.crossDeliveries ?? []).at(-1)
  assert.ok(record, '应记录 crossDeliveries')
  assert.equal(record.participantId, 'group:777')
  assert.equal(record.ok, true)
  assert.equal(record.sentCount, 2)
  assert.ok(record.text.includes('我先说一句'))
  // 常规路径不受影响：没带 target 的调用仍是「回合结束再发」
  const normal = await say.execute({ text: '这是私聊回复' }, { agent })
  assert.ok(String(normal).includes('将在本回合结束时发送'), String(normal))
  assert.equal(sent.length, 2, '常规路径不该立刻发')
})

/* ─────────────────── C. 拒绝路径 ─────────────────── */

await check('未知目标 → 拒绝且不发送', async () => {
  makeState()
  const { ctx, agent, tools, sent } = await boot()
  await injectOnce(ctx, agent)
  const reply = await tools.get('interlude_say').execute({ text: '喂', target: 'group:888' }, { agent })
  assert.ok(String(reply).includes('没有这个跨群目标'), String(reply))
  assert.equal(sent.length, 0)
})

await check('超过每轮上限 → 拒绝第二次', async () => {
  makeState()
  const { ctx, agent, tools, sent } = await boot({ maxPerTurn: 1 })
  await injectOnce(ctx, agent)
  const say = tools.get('interlude_say')
  const first = await say.execute({ text: '第一条', target: 'group:777' }, { agent })
  assert.ok(String(first).includes('已发到'), String(first))
  const second = await say.execute({ text: '第二条', target: 'group:777' }, { agent })
  assert.ok(String(second).includes('达到上限'), String(second))
  assert.equal(sent.length, 1, '第二次不该发出去')
  // 新回合（pre-step step 1）后上限归零
  await injectOnce(ctx, agent)
  const third = await say.execute({ text: '第三条', target: 'group:777' }, { agent })
  assert.ok(String(third).includes('已发到'), String(third))
  assert.equal(sent.length, 2)
})

await check('自言自语内容跨群 → 拒绝（与常规投递同一道闸）', async () => {
  makeState()
  const { ctx, agent, tools, sent } = await boot()
  await injectOnce(ctx, agent)
  const reply = await tools.get('interlude_say').execute(
    { text: 'I should use interlude_say to tell him now', target: 'group:777' }, { agent })
  assert.ok(String(reply).includes('自言自语'), String(reply))
  assert.equal(sent.length, 0)
})

console.log(`\n跨群投递：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
