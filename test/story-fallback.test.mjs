/**
 * per-bot 人设回退到预设 story 的测试（走真实 pre-step 注入链）。
 *
 * 背景（线上症状：角色只写故事不发言）：
 * 人设的权威副本存在预设 story.json（设置页「保存预设」写入），而配置里的
 * story 字段可能是 schema 默认空壳（Unnamed character + 空字段）——例如扫码
 * 落地/配置写入时用空 story 覆盖过。此时 storyForBot 只读配置 story → pre-step
 * 注入空壳人设 → 模型不知道角色是谁、不知道调 interlude_say → 只写故事不发言。
 *
 * 修复：配置 story 是空壳时，回退到 bot 的 agentPreset 预设里的 story.json。
 *
 * 本测试通过**真实 pre-step 注入链**验证：配置 story 空壳 + 预设完整 → 注入的
 * canon 文本含「江柚」等真实人设，而非 Unnamed character。
 *
 * 运行：node test/story-fallback.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { BindingStore } from '../lib/qq-im/binding.js'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-storyfallback', import.meta.url))
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

/** 造一个带完整 story.json 的预设目录。 */
function makePresetWithStory(id, story) {
  const dir = path.join(TEST_HOME, '.agent-presets', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), `name: "江柚"\ndescription: "🎭"\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'story.json'), JSON.stringify(story, null, 2), 'utf8')
  const presetsFile = path.join(TEST_HOME, '.agent-presets', 'presets.json')
  let presets = []
  try { presets = JSON.parse(fs.readFileSync(presetsFile, 'utf8')).presets ?? [] } catch { /* 首建 */ }
  presets.push({ mode: 'roleplay', id, name: '江柚', dir: id, createdAt: Date.now() })
  fs.writeFileSync(presetsFile, JSON.stringify({ presets }, null, 2), 'utf8')
}

const FULL_STORY = {
  character: { name: '江柚', profile: '22岁，广告设计专业，杭州运营。', speech: '短句，爱加语气词。' },
  perspective: '相信努力会有回报，但学会把辛苦说成还行。',
  world: { setting: '2020年代中国都市杭州。', location: '杭州——出租屋、公司、地铁、便利店', supportingCast: '室友小鹿；前辈王姐。' },
  counterpart: { profile: '青梅竹马的好朋友。', initial: '无话不说。' },
  plot: { startingPoint: '毕业后的第一个秋天。', style: '治愈日常向。', boundaries: '不写血腥。', keywords: ['杭州', '江柚'] },
}

const SHELL_STORY = {
  character: { name: 'Unnamed character', profile: '', speech: '' },
  perspective: '',
  world: { setting: '', location: '', supportingCast: '' },
  counterpart: { profile: '', initial: '' },
  plot: { startingPoint: '', style: '现实主义日常叙事，情绪克制，关系变化缓慢而具体。', boundaries: '', keywords: [] },
}

makePresetWithStory('preset-hds-jiangyou-test', FULL_STORY)

/** 造一个 fake agent：header.agentPreset 指向完整预设，触发 pre-step 注入。 */
function fakeAgent(id, presetId) {
  return {
    id,
    session: {
      id,
      header: { id, agentPreset: presetId, cwd: TEST_HOME },
    },
    followup() {},
  }
}

/** 起插件实例并跑一次 pre-step，返回注入文本。 */
async function injectOnce({ configStory = SHELL_STORY, sessionId = 'session-story-test' } = {}) {
  const captured = { tools: [] }
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: (def) => { captured.tools.push(def); return () => {} } })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', { describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} })
  ctx.provide('configEditor', { entries: () => [], edit: async () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('agentPresets', { async register() { return async () => {} }, async resolve(id) { throw new Error(`Unknown agent preset: ${id}`) } })

  const cfg = plugin.Config({
    timeZone: 'Asia/Shanghai',
    runtime: { autoAdvanceEnabled: false },
    story: configStory,
    im: { enabled: false, bots: [{ botId: 'qq_test', appId: '1', alias: '江柚', agentPreset: 'preset-hds-jiangyou-test', story: configStory }] },
  })

  // 预置绑定：让 storyForSession 经 bySessionId 找到江柚 bot（线上场景会话已绑定）。
  const store = new BindingStore({ home: TEST_HOME })
  store.set({ conversationKey: 'c2c:USER1', sessionId, botId: 'qq_test', name: '江柚' })

  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(100)

  // 触发 pre-step：agent 带着 preset header 进入回合。
  const agent = fakeAgent(sessionId, 'preset-hds-jiangyou-test')
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  const joined = decision.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n')
  return { joined, captured }
}

await check('配置 story 空壳 + 预设完整 → pre-step 注入真实人设（江柚）', async () => {
  const { joined } = await injectOnce()
  assert.ok(joined.includes('江柚'), `注入应含主角名「江柚」，实际：${joined.slice(0, 120)}`)
  assert.ok(joined.includes('广告设计'), '注入应含 profile 内容')
  assert.ok(joined.includes('治愈日常'), '注入应含 plot.style 或文风')
  assert.ok(!joined.includes('Unnamed character'), '不应注入空壳占位名')
})

await check('配置 story 完整 → 直接用配置 story（不回退预设）', async () => {
  const custom = { ...SHELL_STORY, character: { name: '自定义角色', profile: '自设 profile。', speech: '自设风格。' } }
  const { joined } = await injectOnce({ configStory: custom, sessionId: 'session-story-test-2' })
  assert.ok(joined.includes('自定义角色'), '应使用配置里的完整 story')
})

console.log(`\nstory 回退：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)