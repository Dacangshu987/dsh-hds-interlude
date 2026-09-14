/**
 * 加载与挂载自检：在真实的 @deepseek-ai/cordis 上下文里挂载插件，
 * 用真实的 schemastery 归一化配置、真实的 defineTool 编译工具 schema，
 * 并让 agent/pre-step 的 waterfall 真的派发一次。
 *
 * 这一层能抓到 import 名写错、Config schema 用法不对、工具 spec 不合规、
 * 注入消息 source 形状不对等问题。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

// 数据目录指向仓库内临时目录，避免污染 ~/.dsh；每轮开头清空保证幂等。
const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home', import.meta.url))
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

let passed = 0
let failed = 0
const check = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function fakeAgent({ id = 'test-session', events = [], preset = 'preset-test', presetAt = 'header' } = {}) {
  // 造一个真实的角色预设目录：门控以「预设目录是否存在」区分角色预设与内置默认预设（standard 等）。
  if (preset && preset !== 'standard') {
    const dir = path.join(TEST_HOME, '.agent-presets', preset)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: test\n')
  }
  const session = { id, seq: events.length, eventAt: index => events[index] }
  // 运行时权威位置是 SessionHeader（agent.session.header.agentPreset）；其余为兼容兜底路径。
  if (presetAt === 'header') session.header = { id, agentPreset: preset }
  else if (presetAt === 'top') session.agentPreset = preset
  else if (presetAt === 'meta') session.meta = { agentPreset: preset }
  return { id, session }
}

const HOUR = 3_600_000

console.log('模块契约')

await check('导出 name / inject / Config / apply', () => {
  assert.equal(plugin.name, 'hds-interlude')
  assert.deepEqual(plugin.inject, ['agents', 'systemPrompt', 'tools', 'commands', 'settings', 'webServer'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
})

await check('Config 用真实 schemastery 归一化，嵌套默认值被填充', () => {
  const c = plugin.Config({ timeZone: 'Asia/Shanghai' })
  assert.equal(c.timeZone, 'Asia/Shanghai')
  assert.equal(c.enabled, true)
  assert.equal(c.gapNoticeMinutes, 30)
  assert.equal(c.story.character.name, 'Unnamed character')
  assert.equal(c.runtime.autoAdvanceIntervalMinutes, 40)
  assert.equal(c.alterSystem.baseThreshold, 10)
  assert.equal(c.agency.maxWindowMinutes, 240)
  assert.equal(c.schedulePreplan.horizonDays, 14)
  assert.equal(c.proactive.maxPerDay, 6)
})

await check('非法时区在启动时抛出', () => {
  const ctx = new Context()
  assert.throws(() => plugin.apply(ctx, plugin.Config({ timeZone: 'Nope/Nowhere' })), /无法解析时区/)
})

console.log('挂载到真实 Cordis 上下文')

const captured = { sections: [], tools: [], commands: [] }
function fakeSettings() {
  const listeners = new Set()
  const scopes = new Map()
  return {
    register(ns, schema, options) {
      let user = {}
      const resolve = () => ({ ...schema(options?.base ?? {}), ...user })
      const scope = {
        get: resolve,
        watch(cb) { listeners.add(cb); return () => listeners.delete(cb) },
        async update(patch) { user = { ...user, ...patch }; for (const cb of listeners) await cb(resolve(), null) },
        async replace(section) { user = section; for (const cb of listeners) await cb(resolve(), null) },
      }
      scopes.set(ns, scope)
      return scope
    },
    _scopes: scopes,
  }
}

const settings = fakeSettings()
const ctx = new Context()
ctx.provide('agents', { currentInitiator: () => undefined })
ctx.provide('systemPrompt', { section: spec => (captured.sections.push(spec), () => {}) })
ctx.provide('tools', { register: def => (captured.tools.push(def), () => {}) })
ctx.provide('commands', { register: def => (captured.commands.push(def), () => {}) })
ctx.provide('settings', settings)
ctx.provide('webServer', { register: () => {} })

const config = plugin.Config({ timeZone: 'Asia/Shanghai' })
const fiber = ctx.plugin(plugin, config)
if (fiber && typeof fiber.then === 'function') await fiber
await sleep(30)

await check('不再注册全局系统提示词段（人设改为按会话注入）', () => {
  assert.equal(captured.sections.length, 0)
})

await check('设置命名空间已注册', () => {
  assert.ok(settings._scopes.has('hds-interlude'))
})

await check('角色会话首轮 pre-step 注入人设（含填写的 story）', async () => {
  await settings._scopes.get('hds-interlude').update({
    story: {
      character: { name: '水濑', profile: '在便利店打工的青年。', speech: '短句。' },
      perspective: '觉得人与人之间保持一点距离更自在。',
      world: { setting: '沿海小城。', location: '便利店', supportingCast: '店长佐藤' },
      counterpart: { profile: '第一次来的客人。', initial: '陌生而好奇' },
      plot: { startingPoint: '某个雨夜。', style: '日常治愈。', boundaries: '不写血腥。', keywords: [] },
    },
  })
  const agent = fakeAgent({ id: 'canon-session', events: [] })
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  const joined = decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.ok(joined.includes('水濑'), joined)
  assert.ok(joined.includes('沿海小城'), joined)
  assert.ok(joined.includes('主角的价值观'), joined)
})

await check('六个工具经真实 defineTool 编译通过', () => {
  const names = captured.tools.map(t => t.name).sort()
  assert.deepEqual(names, [
    'interlude_agency', 'interlude_alter', 'interlude_memory',
    'interlude_plan', 'interlude_preplan', 'interlude_state',
  ])
  for (const t of captured.tools) {
    assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`)
    assert.equal(typeof t.output?.render, 'function', `${t.name} 缺 output.render`)
  }
})

await check('管理命令注册成功', () => {
  assert.equal(captured.commands.length, 1)
  assert.equal(captured.commands[0].name, 'interlude')
  assert.equal(typeof captured.commands[0].handler, 'function')
})

console.log('运行时行为')

await check('interlude_plan 落库并返回回执', async () => {
  const tool = captured.tools.find(t => t.name === 'interlude_plan')
  const text = await tool.execute({ summary: '问问他面试结果', afterMinutes: 30, kind: 'followup' }, { agent: fakeAgent() })
  assert.ok(text.includes('问问他面试结果'), text)
  assert.ok(text.includes('i1'), text)
  assert.ok(text.includes('30 分钟'), text)
})

await check('interlude_alter 累积后按阈值触发底色', async () => {
  const tool = captured.tools.find(t => t.name === 'interlude_alter')
  const agent = fakeAgent({ id: 'alter-session' })
  const first = await tool.execute({ shift: 6 }, { agent })
  assert.ok(first.includes('尚未触发'), first)
  const second = await tool.execute({ shift: 5, note: '两人都有点绷着。' }, { agent })
  assert.ok(second.includes('已触发'), second)
  assert.ok(second.includes('两人都有点绷着'), second)
})

await check('interlude_memory 写入与关闭长期事实', async () => {
  const tool = captured.tools.find(t => t.name === 'interlude_memory')
  const agent = fakeAgent({ id: 'mem-session' })
  const added = await tool.execute({ action: 'add', content: '他下周要去面试', scope: 'promise' }, { agent })
  assert.ok(added.includes('f1'), added)
  const closed = await tool.execute({ action: 'close', id: 'f1' }, { agent })
  assert.ok(closed.includes('已关闭'), closed)
})

await check('interlude_agency 更新行动窗口', async () => {
  const tool = captured.tools.find(t => t.name === 'interlude_agency')
  const agent = fakeAgent({ id: 'agency-session' })
  const text = await tool.execute({ activityLoad: 'free', privacy: 'private', deviceAccess: 'available' }, { agent })
  assert.ok(text.includes('Agency Window 已更新'), text)
})

await check('/interlude status 返回完整状态摘要', async () => {
  const handler = captured.commands[0].handler
  const result = await handler({ agent: fakeAgent(), rawInput: ' status', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('Asia/Shanghai'), result.text)
})

await check('长时间沉默后 agent/pre-step 注入幕间块（角色会话首轮=人设+规则+故事规则+幕间）', async () => {
  const now = Date.now()
  const agent = fakeAgent({
    id: 'gap-session',
    events: [
      { type: 'user/message', time: now - 2 * HOUR - 13 * 60_000, data: { source: { kind: 'user' } } },
      { type: 'assistant/message', time: now - 2 * HOUR, data: {} },
      { type: 'turn/end', time: now - 2 * HOUR, data: {} },
    ],
  })
  const payload = { agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  // 首轮角色会话：人设 + 规则 + 故事写作规则 + 幕间，共 4 条。
  // 故事规则只在**没有聊天软件绑定**的会话里注入（见 lib/render.js 的 storyRules）：
  // IM 规则要求「不要旁白」，故事续写正好相反，两条规则不能同时给。
  assert.equal(decision.messages.length, 4) 
  const text = decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.ok(text.startsWith('你正在扮演的世界与故事'), text)
  assert.ok(text.includes('<幕间>'), text)
  assert.ok(text.includes('2 小时 13 分钟'), text)
  assert.ok(text.includes('故事续写不是在发消息'), text)
})

await check('刚说完话时不注入「距上一条用户消息已过」这类废话', async () => {
  // 省 token 的直接来源（线上 session-58be9b68 实测）：40 次注入里 17 次写着
  // 「距上一条用户消息已过 不到 1 分钟」——用户刚说完话，模型当然知道「刚刚」。
  // 这行没有信息量，却要永久进上下文、并被之后每一次请求重发。
  //
  // 用独立会话 id：状态是按会话缓存/落盘的，复用别的用例的 id 会读到它的 canonInjected。
  const now = Date.now()
  const agent = fakeAgent({
    id: 'fresh-session',
    events: [
      { type: 'user/message', time: now - 30_000, data: { source: { kind: 'user' } } },
      { type: 'assistant/message', time: now - 20_000, data: {} },
      { type: 'turn/end', time: now - 20_000, data: {} },
    ],
  })
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  // 打开 alwaysReportTime：线上那位用户就是这么配的（settings.yaml 里它是 true），
  // 也正是「每回合都注入」把没信息量的间隔行累积成 20% 上下文的前提。
  await settings._scopes.get('hds-interlude').update({ alwaysReportTime: true })
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  const text = decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
  const start = text.indexOf('<幕间>')
  assert.ok(start >= 0, `应当注入幕间块（alwaysReportTime 开着）：\n${text}`)
  const interlude = text.slice(start, text.indexOf('</幕间>', start) + 5)
  assert.doesNotMatch(interlude, /已过/, `刚说完话不该念叨间隔：\n${interlude}`)
  // 但时间本身仍要在（模型需要知道现在几点）。
  assert.match(interlude, /现在是 20\d\d-/, interlude)
})

await check('隔了很久时，间隔照常注入（有信息量就不能省）', async () => {
  const now = Date.now()
  const agent = fakeAgent({
    id: 'long-gap-session',
    events: [
      { type: 'user/message', time: now - 5 * HOUR, data: { source: { kind: 'user' } } },
      { type: 'assistant/message', time: now - 5 * HOUR, data: {} },
      { type: 'turn/end', time: now - 5 * HOUR, data: {} },
    ],
  })
  const payload = { agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  const text = decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.match(text, /5 小时/, `隔了 5 小时必须说：\n${text}`)
})

await check('同一回合的 step 2 不再重复注入幕间块（多 step 回合）', async () => {
  // 线上真实情形：模型调用 interlude_plan 会产生第二个 step，pre-step 随之再触发一次。
  // 修复前同一回合里会注入两条几乎一样的幕间块（相隔 3 秒），纯浪费上下文。
  // 修复后：只有 step 1 注入，step 2 的 pre-step 不再追加。
  const now = Date.now()
  const agent = fakeAgent({
    id: 'multi-step-session',
    events: [
      // 距上次互动 2 小时以上 → 幕间块会渲染（超过 gapNoticeMinutes=30）
      { type: 'user/message', time: now - 2 * HOUR - 13 * 60_000, data: { source: { kind: 'user' } } },
      { type: 'assistant/message', time: now - 2 * HOUR, data: {} },
      { type: 'turn/end', time: now - 2 * HOUR, data: {} },
    ],
  })
  const signal = new AbortController().signal

  // step 1：首轮角色会话，注入人设 + 规则 + 故事规则 + 幕间（共 4 条）
  const first = await ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 7, step: 1, signal },
    async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.messages.length, 4, 'step 1 应注入人设+规则+故事规则+幕间')
  const firstText = first.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.ok(firstText.includes('<幕间>'), 'step 1 的幕间块应包含 <幕间> 标记')

  // step 2：模型调完工具后的第二个 step，不应再注入任何东西
  const second = await ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 7, step: 2, signal },
    async () => ({ kind: 'enter', messages: [] }))
  assert.equal(second.messages.length, 0, 'step 2 不应再注入任何东西')

  // 新回合（turn 8）的 step 1 又恢复注入（仅幕间，人设规则已注入过）
  const nextTurn = await ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 8, step: 1, signal },
    async () => ({ kind: 'enter', messages: [] }))
  assert.equal(nextTurn.messages.length, 1, '下一回合的 step 1 应注入幕间块')
})

await check('session.header.agentPreset（DSH 运行时真实位置）识别为角色会话', async () => {
  // 回归用例：运行时 preset 在 SessionHeader 上（dsh-session 由创建 meta 构造 header）。
  // 早期实现读 session.meta.agentPreset 恒为 undefined，导致该门控永远关闭。
  const agent = fakeAgent({ id: 'header-preset', presetAt: 'header' })
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  const joined = decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.ok(decision.messages.length >= 1, `expected injected messages, got ${decision.messages.length}`)
  assert.ok(joined.includes('水濑'), joined)
})

await check('顶层 session.agentPreset（兼容路径）同样识别为角色会话', async () => {
  const agent = fakeAgent({ id: 'top-level-preset', presetAt: 'top' })
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  const joined = decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.ok(decision.messages.length >= 1, `expected injected messages, got ${decision.messages.length}`)
  assert.ok(joined.includes('水濑'), joined)
})

await check('内置默认预设 standard 不是角色预设，首轮不注入', async () => {
  const agent = fakeAgent({ id: 'standard-session', preset: 'standard', presetAt: 'header' })
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 0)
})

await check('非角色会话首轮不注入任何内容（roleplayOnly 门控）', async () => {
  const agent = { id: 'non-rp-session', session: { id: 'non-rp-session', meta: {}, seq: 0, eventAt: () => undefined } }
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 0)
})

await check('已取消回合不注入', async () => {
  const controller = new AbortController()
  controller.abort()
  const agent = fakeAgent({ id: 'aborted-session', events: [{ type: 'turn/end', time: Date.now(), data: {} }] })
  const payload = { agent, messages: [], turn: 1, step: 1, signal: controller.signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 0)
})

await check('会话拿不到 id 时整层静默关闭', async () => {
  const agent = { session: { seq: 3, eventAt: () => ({ type: 'turn/end', time: Date.now(), data: {} }) } }
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 0)
})

await check('卸载后监听随 effect 回收', async () => {
  await ctx.stop?.()
  await sleep(10)
  const agent = { id: 'after-stop', session: { id: 'after-stop', meta: {}, seq: 0, eventAt: () => undefined } }
  const decision = await ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 0)
})

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
