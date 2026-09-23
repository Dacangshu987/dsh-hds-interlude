/**
 * 端到端核验：真插件跑一轮对话后，条目账本里**确实**攒下了东西，
 * 而且逐字校验能拿来当证据用。
 *
 * 为什么单独一个文件：`script-entry.test.mjs` 验的是纯算法，
 * 而这一层要回答的是「接线接对了没有」——`entryFor` 里的 `recordLedger`
 * 真的被调用了吗？日志真的被折叠成条目了吗？读回来之后引用还成立吗？
 *
 * 运行：node test/script-entry-e2e.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../.tmp-ledger-e2e', import.meta.url))
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

const plugin = await import('../lib/index.js')
const { saveState, loadState, emptyState } = await import('../lib/state.js')
const { verifyQuote, recentEntries, isDeliveredKind } = await import('../lib/script-entry.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PRESET = 'preset-ledger'
fs.mkdirSync(path.join(TEST_HOME, '.agent-presets', PRESET), { recursive: true })
fs.writeFileSync(path.join(TEST_HOME, '.agent-presets', PRESET, 'preset.yml'), 'name: ledger\n')

let ok = true
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok  ${label}`) }
  catch (e) { ok = false; console.log(`  FAIL ${label}\n       ${e?.message ?? e}`) }
}

console.log('条目账本接线')

/** 造一个带真实事件日志的 agent（eventAt 逐条返回，模拟宿主会话）。 */
function makeAgent(sessionId, events) {
  return {
    id: sessionId,
    session: {
      id: sessionId,
      header: { id: sessionId, agentPreset: PRESET },
      seq: events.length,
      eventAt: index => events[index],
    },
    followup() {},
  }
}

function makeHost(agent) {
  const ctx = new Context()
  ctx.provide('agents', { get: () => agent, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', {
    register: (ns, schema, options) => ({
      get: () => schema(options?.base ?? {}),
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }),
  })
  ctx.provide('webServer', { register: () => {} })
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('sessionController', { async resolveAgent() { return agent } })
  return ctx
}

const SESSION = 'session-ledger-e2e'

await check('跑一轮 pre-step 后，账本里攒下了这轮对话的条目', async () => {
  fs.rmSync(path.join(TEST_HOME, 'hds-interlude'), { recursive: true, force: true })

  const events = [
    { type: 'user/message', time: 1_700_000_000_000, data: { content: [{ type: 'text', text: '明天下午三点在楼下等你。' }] } },
    { type: 'assistant/message', time: 1_700_000_010_000, data: { message: { content: [{ type: 'text', text: '（她把手机扣在枕边。）\n\n“好，我记着了”' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
  ]
  const agent = makeAgent(SESSION, events)

  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  saveState(SESSION, state)

  const ctx = makeHost(agent)
  const fiber = ctx.plugin(plugin, plugin.Config({ timeZone: 'Asia/Shanghai', runtime: { restWindows: [] } }))
  if (fiber && typeof fiber.then === 'function') await fiber

  // 触发一次 pre-step，让 entryFor 跑起来（那里才会记账）。
  await ctx.waterfall?.('agent/pre-step',
    { agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }))
  await sleep(200)

  const after = loadState(SESSION)
  const entries = after.ledger?.entries ?? []
  assert.equal(entries.length, 2, `应攒下 2 条条目，实际 ${entries.length}：${JSON.stringify(entries.map(e => e.kind))}`)
  assert.equal(entries[0].kind, 'user-message', '第一条是用户消息')
  assert.equal(entries[1].kind, 'script', '第二条是角色正文')
  // 正文要完整进来（逐字校验的前提）。
  assert.ok(entries[0].content.includes('明天下午三点'), entries[0].content)
  assert.ok(entries[1].content.includes('好，我记着了'), entries[1].content)

  // 关掉插件后再看：读回来依然成立。
  await ctx.stop?.()
})

await check('读回来之后逐字校验仍然可用（这才是账本的用途）', async () => {
  const after = loadState(SESSION)
  const hit = verifyQuote(after.ledger, 1, '明天下午三点')
  assert.equal(hit.ok, true, JSON.stringify(hit))
  const miss = verifyQuote(after.ledger, 1, '明天下午四点')
  assert.equal(miss.ok, false, '改一个字就不该通过')
})

await check('重复触发 pre-step 不会重复记账（幂等）', async () => {
  const events = [
    { type: 'user/message', time: 1_700_000_000_000, data: { content: [{ type: 'text', text: '明天下午三点在楼下等你。' }] } },
    { type: 'assistant/message', time: 1_700_000_010_000, data: { message: { content: [{ type: 'text', text: '“好，我记着了”' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
  ]
  const agent = makeAgent(SESSION, events)
  const ctx = makeHost(agent)
  const before = loadState(SESSION).ledger.entries.length

  const fiber = ctx.plugin(plugin, plugin.Config({ timeZone: 'Asia/Shanghai', runtime: { restWindows: [] } }))
  if (fiber && typeof fiber.then === 'function') await fiber
  for (let i = 0; i < 4; i++) {
    await ctx.waterfall?.('agent/pre-step',
      { agent, messages: [], turn: 3 + i, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }))
    await sleep(60)
  }
  const after = loadState(SESSION).ledger.entries.length
  assert.equal(after, before, `重复折叠不该新增条目（${before} → ${after}）`)
  await ctx.stop?.()
})

await check('kind 分类正确：散文不是「投递」，用户消息才是', async () => {
  // 这个区分是认知证据的地基：叙述里的一句引号**不能**确认另一个人的行为。
  const after = loadState(SESSION)
  const byKind = Object.fromEntries(recentEntries(after.ledger, 10).map(e => [e.id, e.kind]))
  assert.equal(isDeliveredKind(byKind[1]), true, '用户消息算投递')
  assert.equal(isDeliveredKind(byKind[2]), false, '角色写的散文不算投递')
})

console.log(ok ? '\n✅ 账本接线正确' : '\n❌ 接线有问题')
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
