/**
 * 角色预设注册进宿主 agentPresets 的测试。
 *
 * 背景（线上症状：QQ 收得到消息却永远不回复）：
 * DSH 升级后 `sessionController.create({ agentPreset })` 强校验预设必须注册在
 * 宿主 `agentPresets` registry（dsh-agent-preset-registry）。本插件把预设只写在
 * `~/.dsh/.agent-presets/<id>/`（宿主从不扫描该目录），从未注册 → create 抛
 * `Unknown agent preset` → 降级建出无预设会话 → 不是角色会话 → 不注入人设 →
 * 模型不知道 interlude_say → 消息 delivered 却没有回复。
 *
 * 修复：apply 启动时把自建预设注册进宿主；createSessionFor 遇 Unknown 时
 * 注册后重试。本测试验证启动注册确实发生（fake agentPresets 服务收到 register）。
 *
 * 运行：node test/preset-registration.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-presetreg', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../lib/index.js')

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 造一个自建预设的完整目录（preset.yml + agent.cordis.yml + story.json）。 */
function makePreset(id, name, { plugins } = {}) {
  const dir = path.join(TEST_HOME, '.agent-presets', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), `name: ${JSON.stringify(name)}\ndescription: "🎭"\n`, 'utf8')
  const defaultPlugins = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { text: '角色卡', complete: true, includeRuntimeContext: false } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
    { id: 'ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  ]
  // agent.cordis.yml 用与插件一致的 YAML 形态（便于验证 yaml.load 解析）。
  const list = plugins ?? defaultPlugins
  const lines = ['# 幕间系统预设生成']
  for (const p of list) {
    lines.push(`- id: ${p.id}`, `  name: '${p.name}'`)
    if (p.config) {
      lines.push('  config:')
      for (const [k, v] of Object.entries(p.config)) lines.push(`    ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    }
    lines.push('')
  }
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), lines.join('\n'), 'utf8')
  fs.writeFileSync(path.join(dir, 'story.json'), '{"character":{"name":"测试"}}\n', 'utf8')

  // 登记进 presets.json（插件读取的清单）。
  const presetsFile = path.join(TEST_HOME, '.agent-presets', 'presets.json')
  let presets = []
  try { presets = JSON.parse(fs.readFileSync(presetsFile, 'utf8')).presets ?? [] } catch { /* 首建 */ }
  presets.push({ mode: 'roleplay', id, name, dir: id, createdAt: Date.now() })
  fs.writeFileSync(presetsFile, JSON.stringify({ presets }, null, 2), 'utf8')
}

/** 建宿主：fake agentPresets 服务（记录 register 调用）。 */
async function boot() {
  const registered = []
  const resolveCalls = []
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', { describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} })
  ctx.provide('configEditor', { entries: () => [], edit: async () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('agentPresets', {
    async register(definition) {
      registered.push(definition)
      return async () => {}
    },
    async resolve(id) {
      resolveCalls.push(id)
      // 模拟 registry：只有已注册的才返回。
      const found = registered.find((d) => d.id === id)
      if (!found) throw new Error(`Unknown agent preset: ${id}`)
      return { id }
    },
  })

  const cfg = plugin.Config({ timeZone: 'Asia/Shanghai', runtime: { autoAdvanceEnabled: false } })
  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(120) // 等 fire-and-forget 的注册扫描跑完
  return { ctx, registered, resolveCalls }
}

// 造两个自建预设（江柚、大傻鱼）。
makePreset('preset-hds-aaa111-test1', '测试一')
makePreset('preset-hds-bbb222-test2', '测试二')

await check('启动后自建预设全部注册进宿主 agentPresets', async () => {
  const { registered } = await boot()
  const ids = registered.map((d) => d.id).sort()
  assert.deepEqual(ids, ['preset-hds-aaa111-test1', 'preset-hds-bbb222-test2'].sort(), '应注册两个自建预设')
  const first = registered.find((d) => d.id === 'preset-hds-aaa111-test1')
  assert.equal(first.name, '测试一', '注册名应来自 preset.yml')
  assert.ok(Array.isArray(first.plugins), 'plugins 应为数组')
  assert.equal(first.plugins[0]?.name, '@deepseek-ai/dsh-persona', 'plugins 应含 persona')
  assert.ok(first.plugins.length >= 3, 'plugins 应含 persona/tool-web/ask-user')
})

await check('重复注册幂等：resolve 已存在则不再 register', async () => {
  // 重启场景：预设已在宿主 registry → resolve 命中 → 不应重复 register。
  const registered = []
  const seen = new Set(['preset-hds-aaa111-test1'])
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', { describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} })
  ctx.provide('configEditor', { entries: () => [], edit: async () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('agentPresets', {
    async register(d) { registered.push(d); seen.add(d.id); return async () => {} },
    async resolve(id) { if (seen.has(id)) return { id }; throw new Error(`Unknown agent preset: ${id}`) },
  })
  const cfg = plugin.Config({ timeZone: 'Asia/Shanghai', runtime: { autoAdvanceEnabled: false } })
  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(120)
  // 已存在的 preset-hds-aaa111-test1 不应被重复注册；preset-hds-bbb222-test2 应注册。
  assert.ok(!registered.some((d) => d.id === 'preset-hds-aaa111-test1'), '已注册的预设不应重复注册')
  assert.ok(registered.some((d) => d.id === 'preset-hds-bbb222-test2'), '未注册的预设应补注册')
})

console.log(`\n角色预设注册：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)