/**
 * 管理员注记测试（移植自上游 `1.0.1-rc3`/`rc4` 的 `ADMIN NOTES`）。
 *
 * 上游语义：`[管理员注记]` 开头的是**故事管理员注入的权威事实或指令**，在其主题上
 * 覆盖叙事即兴、直到被后来的注记否定之前一直有效、且**永远不要让她提到"看过一条注记"**。
 * 预算保护（`compactPromptEntries` 的 admin 段）：最多 3 条最新、每条 ≤2000 字、
 * 合计 ≤6000 字，超限保留前半段并标 `…[注记截断]`。
 *
 * 覆盖：
 *   A. 命令写入：条目 kind=admin-note、actor=system、前缀 `[管理员注记] `、
 *      metadata.source=administrator（不伪装成模型输出）；
 *   B. 提示词投影：权威层措辞 + 注记正文；
 *   C. 预算保护：只带最新 3 条、超长注记截断并标注、合计不超 6000；
 *   D. 空注记拒绝；clear 清空。
 *
 * 运行：node test/admin-note.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { BindingStore } from '../lib/qq-im/binding.js'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-adminnote', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../lib/index.js')

const PRESET_ID = 'preset-hds-note'
const SESSION = 'session-note-1'
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

function makeState(entries = []) {
  const dir = path.join(TEST_HOME, 'hds-interlude')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(dir, `${SESSION}.json`), JSON.stringify({
    version: 1, sessionId: SESSION, canonInjected: true, canonInjectedIm: 'im', roleplay: false,
    turns: 2, lastUserAt: now - 120_000, lastAssistantAt: now - 60_000,
    intents: [], ledger: { cursor: 0, nextId: entries.length + 1, entries },
  }, null, 2), 'utf8')
}
const readState = () => JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hds-interlude', `${SESSION}.json`), 'utf8'))
const noteEntry = (id, text) => ({
  id, kind: 'admin-note', participantId: '', actor: 'system',
  content: text.startsWith('[管理员注记]') ? text : `[管理员注记] ${text}`,
  occurredAt: new Date().toISOString(), metadata: { source: 'administrator' },
})

async function boot() {
  const agent = {
    session: { id: SESSION, header: { id: SESSION, agentPreset: PRESET_ID, cwd: TEST_HOME } },
    followup() {},
  }
  const commands = new Map()
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, list: () => [], currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: (def) => { commands.set(def.name, def); return () => {} } })
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
  return { ctx, agent, commands }
}

async function injectOnce(ctx, agent) {
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  return (decision.messages ?? [])
    .map((m) => (m.content ?? []).map((b) => b.text ?? '').join(''))
    .join('\n')
}

console.log('管理员注记（rc3/rc4 移植）')

await check('命令写入：kind/actor/前缀/metadata 都对（不伪装成模型输出）', async () => {
  makeState([])
  const { commands } = await boot()
  const interlude = commands.get('interlude')
  assert.ok(interlude, '命令应已注册')
  const result = await interlude.handler({ agent: { session: { id: SESSION } }, rawInput: 'note 主角对花生过敏，绝不要写她吃花生' })
  assert.equal(result.kind, 'success', JSON.stringify(result))
  const state = readState()
  const notes = (state.ledger?.entries ?? []).filter((e) => e.kind === 'admin-note')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].actor, 'system')
  assert.ok(notes[0].content.startsWith('[管理员注记] '), notes[0].content.slice(0, 30))
  assert.ok(notes[0].content.includes('花生过敏'))
  assert.equal(notes[0].metadata?.source, 'administrator')
})

await check('提示词投影：权威层措辞 + 注记正文 + 「不要提看过注记」', async () => {
  makeState([noteEntry(1, '她住在城西，通勤要四十分钟')])
  const { ctx, agent } = await boot()
  const text = await injectOnce(ctx, agent)
  assert.ok(text.includes('【管理员注记】'), `应注入注记段：${text.slice(-300)}`)
  assert.ok(text.includes('故事管理员注入的权威事实或指令'))
  assert.ok(text.includes('直到被后来的注记否定之前一直有效'))
  assert.ok(text.includes('永远不要让她提到'), '必须带上「不要提到看过注记」这条')
  assert.ok(text.includes('她住在城西，通勤要四十分钟'))
})

await check('预算保护：只带最新 3 条；超长注记截断并标注；合计不超 6000', async () => {
  // 5 条注记，第 4、5 条是最新的两条；第 5 条超长
  const entries = [
    noteEntry(1, '旧注记一'),
    noteEntry(2, '旧注记二'),
    noteEntry(3, '中间注记'),
    noteEntry(4, '较新注记'),
    noteEntry(5, 'x'.repeat(3000)),
  ]
  makeState(entries)
  const { ctx, agent } = await boot()
  const text = await injectOnce(ctx, agent)
  assert.ok(!text.includes('旧注记一'), '只应带最新 3 条（最旧的应被排除）')
  assert.ok(!text.includes('旧注记二'), '只应带最新 3 条')
  assert.ok(text.includes('中间注记'), '第 3 新应保留')
  assert.ok(text.includes('较新注记'), '第 2 新应保留')
  assert.ok(text.includes('…[注记截断]'), '超长注记应截断并标注')
  // 合计不超预算：注记正文（含前缀）总长应 ≤ 6000 + 少量固定措辞
  const noteLines = text.split('\n').filter((line) => line.startsWith('- [管理员注记]'))
  const total = noteLines.reduce((sum, line) => sum + line.length, 0)
  assert.ok(total <= 6100, `注记总长应受预算约束，实际 ${total}`)
})

await check('无参数 → 列出注记（不会误写空注记）；clear 清空且提示词不再出现', async () => {
  makeState([noteEntry(1, '待清空的注记')])
  const { commands } = await boot()
  const interlude = commands.get('interlude')
  // 注意：`/interlude note` 与 `/interlude note   ` 经 trim 后都是「无参数」，
  // 因此走**列表**分支而不是写空注记——这正是空注记不会落库的原因。
  const listed = await interlude.handler({ agent: { session: { id: SESSION } }, rawInput: 'note    ' })
  assert.equal(listed.kind, 'success')
  assert.ok(listed.text.includes('管理员注记：1 条'), listed.text)
  assert.equal((readState().ledger?.entries ?? []).filter((e) => e.kind === 'admin-note').length, 1, '不应写入新条目')

  const cleared = await interlude.handler({ agent: { session: { id: SESSION } }, rawInput: 'note clear' })
  assert.equal(cleared.kind, 'success')
  assert.equal((readState().ledger?.entries ?? []).filter((e) => e.kind === 'admin-note').length, 0)
  // 清空后提示词里不再出现注记段
  const { ctx, agent } = await boot()
  const text = await injectOnce(ctx, agent)
  assert.ok(!text.includes('【管理员注记】'))
})

console.log(`\n管理员注记：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
