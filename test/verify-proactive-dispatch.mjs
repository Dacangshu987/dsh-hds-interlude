/**
 * 主动发消息机制验证：到期待办 → 唤起角色 → 取回文本 → 直投。
 *
 * 这是「角色在用户没说话时自己发消息」的主路径。本脚本用真插件实例 +
 * 假 QQ 传输层跑一遍，逐环节打印实际发生了什么，便于人工核对机制是否正常。
 *
 * 运行：node test/verify-proactive-dispatch.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-proactive-'))
process.env.DSH_HOME = TEST_HOME

const plugin = await import('../lib/index.js')
const { saveState, loadState, emptyState, addIntent } = await import('../lib/state.js')
const { clearImBindingCache } = await import('../lib/im-binding.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PRESET = 'preset-proactive'
fs.mkdirSync(path.join(TEST_HOME, '.agent-presets', PRESET), { recursive: true })
fs.writeFileSync(path.join(TEST_HOME, '.agent-presets', PRESET, 'preset.yml'), 'name: proactive\n')

const SESSION = 'session-proactive-verify'
const TARGET = 'c2c:USER_OPENID'
let failures = 0
function step(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `\n      ${detail}` : ''}`)
}

/** 写绑定表：把这个会话绑到假 QQ 目标。 */
function bind() {
  const dir = path.join(TEST_HOME, 'integrations', 'dsh-qq')
  fs.mkdirSync(path.join(dir, 'bots', 'qq_bot'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({
    deliveryTargets: { qq_bot: { me: { name: '我', sessionSync: { conversationKey: TARGET } } } },
  }), 'utf8')
  fs.writeFileSync(path.join(dir, 'bots', 'qq_bot', 'state.json'), JSON.stringify({
    sessions: { [TARGET]: SESSION },
  }), 'utf8')
  clearImBindingCache()
}

console.log('主动发消息机制验证\n')

/* ---------------------------------------------- 场景：到期待办到期 → 主动开口 */

bind()

const sent = []
const ctx = new Context()
let currentAgent
ctx.provide('agents', { get: () => currentAgent, currentInitiator: () => undefined })
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
// 假凭据服务：让通道真正「启动」，从而走到真实的分条 + 投递路径。
// （不提供的话通道停在「未启动」，投递会以 qq-not-started 失败——
//   那是测试环境限制，不是机制问题。）
ctx.provide('credentials', { resolve: async () => ({ value: 'fake-app-secret' }) })
// 假 QQ 传输层：把实际发出的文本收集起来。这是「真的发出了什么」的唯一证据。
ctx.__qqImTransport = async (target, text) => {
  sent.push({ target, text, at: new Date().toISOString() })
  return { sent: true }
}

const agent = {
  id: SESSION,
  session: { id: SESSION, header: { id: SESSION, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
  followup() {
    // 模拟模型被唤起后写下的话（含 interlude_say 工具调用）。
    setTimeout(() => {
      ctx.emit('session/event', agent.session, {
        type: 'tool/call',
        data: { name: 'interlude_say', arguments: JSON.stringify({ text: '刚想起来，你让我提醒你喝水' }) },
      })
      ctx.emit('session/event', agent.session, {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '（看了眼时间，顺手拿起杯子。）' }] } },
      })
      ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    }, 5)
  },
}
currentAgent = agent
ctx.provide('sessionController', { async resolveAgent(id) { return id === SESSION ? agent : undefined } })

// 造一条**已经到期**的待办（角色之前答应过的提醒）。
const state = emptyState()
state.canonInjected = true
state.roleplay = true
state.lastAssistantAt = Date.now() - 3 * 3600_000
state.reachedOut = 0
const intent = addIntent(state, { kind: 'reminder', summary: '提醒用户喝水', dueAt: Date.now() - 60_000 }, Date.now())
saveState(SESSION, state)
step('前置：到期提醒已写入状态', Boolean(intent?.id), `intent id=${intent?.id} summary=提醒用户喝水 dueAt=1 分钟前`)

const config = plugin.Config({
  timeZone: 'Asia/Shanghai',
  proactive: { enabled: true, checkIntervalMinutes: 1, graceMinutes: 0, maxPerDay: 6, wakeIdleSessions: true },
  runtime: { restWindows: [], autoAdvanceEnabled: false },
  // 用**配置型绑定**（botId + targetId）：比绑定表更直接，且是生产可用的形态。
  // waitForTurnMs 的 schema 下限是 5000ms；等待时间必须大于它，
  // 否则脚本会在「唤起 → 捕获 → 投递」跑完之前就退出（会误判成"没发出去"）。
  im: {
    enabled: true, appId: 'test-app', messageIntervalMinutes: 0, waitForTurnMs: 5000,
    botId: 'qq_bot', targetId: TARGET,
  },
  agency: { enabled: true },
})

const fiber = ctx.plugin(plugin, config)
if (fiber && typeof fiber.then === 'function') await fiber
step('插件已加载（含 IM 通道与后台扫描）', true)

// 扫描是被动触发的：启动时会立刻扫一次；留足「唤起 + 捕获 + 投递」的时间。
await sleep(7000)

const after = loadState(SESSION)
console.log('\n--- 实际结果 ---')
console.log(`  成功投递条数：${sent.length}`)
sent.forEach((m, i) => console.log(`    [${i + 1}] → ${m.target}：${m.text}`))
const settled = after.intents?.find(i => i.id === intent.id)
console.log(`  意图状态：${settled?.status ?? '(未找到)'}`)
console.log(`  意图诊断字段：${JSON.stringify({
  skippedReason: settled?.skippedReason,
  failure: settled?.failure,
  attempts: settled?.attempts,
  pendingText: settled?.pendingText ? '(有草稿)' : undefined,
})}`)
console.log(`  今日已主动联系：${after.reachedOut ?? 0}`)
console.log(`  上次投递回执：${JSON.stringify(after.lastImDelivery ?? null)}`)
console.log(`  推进模式：${after.advanceMode ?? '(无)'}`)
console.log(`  上次推进投递：${JSON.stringify(after.lastAdvanceDelivery ?? null)}`)

console.log('')
step('角色主动发出的消息到达了传输层', sent.length > 0, sent.length ? `发出 ${sent.length} 条` : '一条都没发出')
step('发出的内容来自 interlude_say（而非正文旁白）', sent.some(m => m.text.includes('喝水')),
  sent.map(m => m.text).join(' | ') || '(空)')
step('正文旁白没有被发出去', !sent.some(m => m.text.includes('看了眼时间')),
  sent.some(m => m.text.includes('看了眼时间')) ? '❌ 旁白泄漏' : '只发了工具里的内容')
step('待办已结算（不再重复投递）', after.intents?.find(i => i.id === intent.id)?.status === 'delivered',
  `status=${after.intents?.find(i => i.id === intent.id)?.status}`)
step('主动联系计数已累加', (after.reachedOut ?? 0) >= 1, `reachedOut=${after.reachedOut}`)
step('投递回执已落盘（可在 /interlude im 自检）', after.lastImDelivery?.ok === true,
  JSON.stringify(after.lastImDelivery?.sentCount) + '/' + JSON.stringify(after.lastImDelivery?.total))

await ctx.stop?.()

/* ---------------------------------------------- 场景：未绑定 → 不应外发 */

console.log('\n--- 反例：没有绑定目标时不该外发 ---')
fs.rmSync(path.join(TEST_HOME, 'integrations'), { recursive: true, force: true })
clearImBindingCache()
const sent2 = []
const ctx2 = new Context()
let agent2
ctx2.provide('agents', { get: () => agent2, currentInitiator: () => undefined })
ctx2.provide('systemPrompt', { section: () => () => {} })
ctx2.provide('tools', { register: () => () => {} })
ctx2.provide('commands', { register: () => () => {} })
ctx2.provide('settings', { register: (ns, schema, o) => ({ get: () => schema(o?.base ?? {}), watch: () => () => {}, update: async () => {}, replace: async () => {} }) })
ctx2.provide('webServer', { register: () => {} })
ctx2.provide('credentials', { resolve: async () => undefined })
ctx2.__qqImTransport = async (t, text) => { sent2.push({ t, text }); return { sent: true } }
agent2 = {
  id: SESSION,
  session: { id: SESSION, header: { id: SESSION, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
  followup() {},
}
ctx2.provide('sessionController', { async resolveAgent() { return undefined } })

const state2 = emptyState()
state2.canonInjected = true
state2.roleplay = true
state2.lastAssistantAt = Date.now() - 3 * 3600_000
addIntent(state2, { kind: 'reminder', summary: '提醒用户喝水', dueAt: Date.now() - 60_000 }, Date.now())
saveState(SESSION, state2)

const fiber2 = ctx2.plugin(plugin, plugin.Config({
  timeZone: 'Asia/Shanghai',
  proactive: { enabled: true, checkIntervalMinutes: 1, graceMinutes: 0 },
  runtime: { restWindows: [], autoAdvanceEnabled: false },
  im: { enabled: true, appId: 'test-app' },
}))
if (fiber2 && typeof fiber2.then === 'function') await fiber2
await sleep(2500)
step('无绑定时一条都不外发', sent2.length === 0, `传输层收到 ${sent2.length} 条`)
await ctx2.stop?.()

/* ---------------------------------------------- 收尾 */

console.log(failures === 0 ? '\n✅ 主动发消息机制验证通过' : `\n❌ ${failures} 项不符合预期`)
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
