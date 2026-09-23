/**
 * 阶段 5：`/interlude im new` / `im session` / `im sessions` 的语义测试。
 *
 * 对齐 dsh-im 的 /new / /session / /sessionlist：
 *   - `im new`：解绑当前聊天的绑定 → 新建一个会话并绑回同一聊天；
 *   - `im sessions`：列出可绑定的会话（序号从 0 开始）；
 *   - `im session <ID|序号>`：把当前聊天的绑定指到指定会话。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../../.tmp-dsh-home-sesscmd', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../../lib/index.js')

// 预写绑定表：im-cmd 会话 ↔ c2c:USER1（bot qq_bot）。绑定表先于插件加载存在。
const bindDir = path.join(TEST_HOME, 'integrations', 'dsh-qq-im')
fs.mkdirSync(bindDir, { recursive: true })
fs.writeFileSync(path.join(bindDir, 'bindings.json'), JSON.stringify({
  version: 2,
  bindings: {
    'qq_bot\u0000c2c:USER1': {
      conversationKey: 'c2c:USER1', sessionId: 'im-cmd', botId: 'qq_bot', name: '测试',
    },
  },
}, null, 2), 'utf8')

const captured = { sections: [], tools: [], commands: [] }
const followups = []
const ctx = new Context()
ctx.provide('agents', { currentInitiator: () => undefined, get: () => undefined })
ctx.provide('systemPrompt', { section: spec => (captured.sections.push(spec), () => {}) })
ctx.provide('tools', { register: def => (captured.tools.push(def), () => {}) })
ctx.provide('commands', { register: def => (captured.commands.push(def), () => {}) })
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
// sessionController：im new 需要「新建会话 + 恢复 agent 以注入首条消息」。
const created = []
ctx.provide('sessionController', {
  async create(request) { created.push(request); return { sessionId: 'session-fresh-1' } },
  async resolveAgent(sessionId) {
    return { agent: { id: sessionId, session: { id: sessionId, header: { id: sessionId } }, followup(message) { followups.push({ sessionId, message }) } } }
  },
})
ctx.__qqImTransport = async () => ({ sent: true })

// 刻意不给 targetId：让「绑定」只来自绑定表（discover 路径），而不是配置兜底。
const config = plugin.Config({
  timeZone: 'Asia/Shanghai',
  im: { enabled: true, appId: 'test-app', botId: 'qq_bot' },
})
const fiber = ctx.plugin(plugin, config)
if (fiber && typeof fiber.then === 'function') await fiber
await new Promise(r => setTimeout(r, 40))

const handler = captured.commands[0].handler
const command = (rawInput, agent = fakeAgent('im-cmd')) => handler({
  agent, rawInput, attachments: [], signal: new AbortController().signal,
})
function fakeAgent(id) {
  return { id, session: { id, seq: 0, eventAt: () => undefined }, followup: message => followups.push({ id, message }) }
}

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const eq = (actual, expected, label) => assert.deepEqual(actual, expected, label)

console.log('阶段 5：/interlude im new / session / sessions')

await check('im sessions 列出绑定表里的会话与序号', async () => {
  const result = await command(' im sessions')
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('[0]'), result.text)
  assert.ok(result.text.includes('c2c:USER1'), result.text)
})

await check('im session <序号> 把当前聊天绑到指定会话', async () => {
  // 用一个新的假会话（有 discover 绑定可查）作为「当前聊天」。
  const result = await command(' im session 0', fakeAgent('im-cmd'))
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('c2c:USER1'), result.text)
  // 绑定表里该聊天的目标仍是 im-cmd（序号 0 就是它自己，幂等重绑）。
  // 用 discover 查回来确认。
  const discover = await command(' im discover')
  assert.ok(discover.text.includes('im-cmd'), discover.text)
})

await check('im session 序号越界报错并提示范围', async () => {
  const result = await command(' im session 99')
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('序号'), result.text)
})

await check('im session <ID> 找不到时如实报错', async () => {
  const result = await command(' im session no-such-session-xyz')
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('找不到'), result.text)
})

await check('im new 解绑并新建会话，绑定指到新会话', async () => {
  const result = await command(' im new')
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('session-fresh-1'), result.text)
  // 旧绑定（im-cmd ↔ c2c:USER1）应被新会话接管。
  const discover = await command(' im discover')
  assert.ok(discover.text.includes('session-fresh-1'), discover.text)
  assert.ok(!discover.text.includes('im-cmd'), discover.text)
  // 新会话确实被创建过（sessionController.create 被调用）。
  assert.equal(created.length, 1, '应调用一次 create')
})

await check('im new 在没有绑定时报错', async () => {
  const result = await command(' im new', fakeAgent('im-unbound-xyz'))
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('没有绑定'), result.text)
})

await ctx.stop?.()
try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`\n会话指令：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
