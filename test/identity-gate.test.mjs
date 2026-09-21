/**
 * 身份暴露 gate：interlude_state 只对「角色会话」暴露主角身份。
 *
 * 线上症状：新接入的 bot 自称江柚。根因是 interlude_state 工具全局可调，
 * 而它的输出第一行是 `- 主角：<全局配置角色名>`（与哪个 bot 无关）——
 * 普通会话（standard 预设）没有角色人设，却能从工具读到全局主角名并「冒充」。
 *
 * 修复：非角色会话调用 interlude_state 返回「未启用幕间层角色」，不暴露主角名。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../../.tmp-dsh-home-identity', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const mod = await import('../lib/index.js')

// 预写绑定表：sess-bot2 ↔ c2c:U1（bot qq_bot2，配了 per-bot story）。
const bindDir = path.join(TEST_HOME, 'integrations', 'dsh-qq-im')
fs.mkdirSync(bindDir, { recursive: true })
fs.writeFileSync(path.join(bindDir, 'bindings.json'), JSON.stringify({
  version: 2,
  bindings: {
    'qq_bot2\u0000c2c:U1': {
      conversationKey: 'c2c:U1', sessionId: 'sess-bot2', botId: 'qq_bot2',
    },
  },
}, null, 2), 'utf8')

const captured = { tools: [], commands: [] }
const ctx = new Context()
ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
ctx.provide('systemPrompt', { section: () => () => {} })
ctx.provide('tools', { register: def => (captured.tools.push(def), () => {}) })
ctx.provide('commands', { register: def => (captured.commands.push(def), () => {}) })
ctx.provide('settings', {
  register(ns, schema, options) {
    const resolveImpl = () => schema(options?.base ?? {})
    return { get: resolveImpl, watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})
ctx.provide('webServer', { register: () => {} })
ctx.provide('credentials', { resolve: async () => undefined })

const config = mod.Config({
  timeZone: 'Asia/Shanghai',
  story: { character: { name: '江柚', profile: '22 岁运营', speech: '短句' } },
  im: {
    enabled: true, appId: '1900000001', botId: 'qq_testbot',
    bots: [
      { botId: 'qq_testbot', appId: '1900000001', secretRef: 'DSH_QQBOT_APP_SECRET' },
      {
        botId: 'qq_bot2', appId: '1900000002', secretRef: 'DSH_QQBOT_APP_SECRET_2',
        agentPreset: 'preset-test-char',
        story: { character: { name: '阿澈', profile: '第二个人', speech: '直白' } },
      },
    ],
  },
})
const fiber = ctx.plugin(mod, config)
if (fiber && typeof fiber.then === 'function') await fiber
await new Promise((r) => setTimeout(r, 40))

const tool = captured.tools.find(t => t.name === 'interlude_state')
assert.ok(tool, '应注册 interlude_state 工具')

function fakeAgent(id, agentPreset) {
  return {
    id,
    session: {
      id,
      header: { id, ...(agentPreset ? { agentPreset } : {}) },
      seq: 0,
      eventAt: () => undefined,
    },
    followup() {},
  }
}

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('interlude_state 身份 gate')

await check('角色会话：interlude_state 返回主角名（正常路径）', async () => {
  // 建一个真实存在的角色预设目录（isRoleplayPresetId 要求目录存在）。
  const presetDir = path.join(TEST_HOME, '.agent-presets', 'preset-test-char')
  fs.mkdirSync(presetDir, { recursive: true })
  fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: 江柚\n', 'utf8')

  const out = tool.execute({}, { agent: fakeAgent('sess-role', 'preset-test-char') })
  assert.ok(String(out).includes('主角：江柚'), `应暴露主角名：${String(out).slice(0, 120)}`)
})

await check('普通会话（standard 预设）：不暴露主角名，提示未启用', async () => {
  const out = tool.execute({}, { agent: fakeAgent('sess-plain', 'standard') })
  const text = String(out)
  assert.ok(!text.includes('江柚'), `普通会话不应读到主角名：${text.slice(0, 200)}`)
  assert.ok(text.includes('未启用幕间层角色'), `应提示未启用：${text.slice(0, 200)}`)
})

await check('普通会话（无 agentPreset）：同样不暴露', async () => {
  const out = tool.execute({}, { agent: fakeAgent('sess-none') })
  const text = String(out)
  assert.ok(!text.includes('主角：'), `不应出现主角行：${text.slice(0, 200)}`)
})

await check('per-bot story：会话绑定到配了独立人设的 bot → 主角名用该 bot 的 story', async () => {
  // sess-bot2 在绑定表里归属 qq_bot2（配了 story: 阿澈）。
  const out = tool.execute({}, { agent: fakeAgent('sess-bot2', 'preset-test-char') })
  const text = String(out)
  assert.ok(text.includes('主角：阿澈'), `应显示 per-bot 主角名：${text.slice(0, 200)}`)
  assert.ok(!text.includes('江柚'), `不该再显示全局主角名：${text.slice(0, 200)}`)
})

await ctx.stop?.()
try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`\n身份 gate：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
