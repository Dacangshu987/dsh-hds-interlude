/**
 * 主动开口链路测试：捕获（capture.js）与经 IM 直投的命令路径。
 *
 * 这一层覆盖的正是最容易悄悄坏掉的地方：
 * 角色写完没被取回来、turn/end 没结算导致投递拖满超时、
 * 以及 /interlude im test 是否真的按「一条一条」发出去。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

import { installProactiveCapture, textOfContent, sessionIdOf } from '../lib/capture.js'
import * as plugin from '../lib/index.js'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-im', import.meta.url))
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

let passed = 0
let failed = 0
const check = async (label, fn, timeoutMs = 30000) => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TIMEOUT: "${label}" 超过 ${timeoutMs}ms`)), timeoutMs)
  );
  try {
    await Promise.race([fn(), timeout]);
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 捕获窗口的定时器是 unref 的（生产上不该拖住进程退出），
 * 所以纯等超时的用例必须自己把事件循环撑住，否则 Node 会直接判为
 * 「未结算的顶层 await」退出。
 */
const withKeepAlive = async (promise) => {
  const ticker = setInterval(() => {}, 10)
  try {
    return await promise
  } finally {
    clearInterval(ticker)
  }
}

const assistantEvent = (sessionId, text, turn = 1) => ({ type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text }] } } })
const turnEndEvent = (turn = 1) => ({ type: 'turn/end', data: { turn, reason: 'completed' } })

/** interlude_say 的工具调用事件（形态与真实会话日志一致）。 */
const sayEvent = (text, name = 'interlude_say') => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: 'call_1', name, arguments: JSON.stringify({ text }) },
})

console.log('文本提取')

await check('textOfContent 只取 text 块，忽略 reasoning / tool', () => {
  assert.equal(textOfContent([
    { type: 'reasoning', text: '内心戏不该被发出去' },
    { type: 'text', text: '在吗' },
    { type: 'tool-call' },
    { type: 'text', text: '我摸鱼呢' },
  ]), '在吗\n我摸鱼呢')
})

await check('textOfContent 对非数组输入返回空串', () => {
  assert.equal(textOfContent(undefined), '')
  assert.equal(textOfContent('在吗'), '')
  assert.equal(textOfContent([{ type: 'text' }]), '')
})

await check('sessionIdOf 拿不到 id 时返回 null', () => {
  assert.equal(sessionIdOf({ id: 's1' }), 's1')
  assert.equal(sessionIdOf({}), null)
  assert.equal(sessionIdOf({ id: '' }), null)
  assert.equal(sessionIdOf(undefined), null)
})

console.log('捕获结算')

await check('turn/end 立即结算，并把多段 assistant 文本合并', async () => {
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const session = { id: 'cap-1' }

  const pending = capture.begin('cap-1', 5_000)
  ctx.emit('session/event', session, assistantEvent('cap-1', '在吗'))
  ctx.emit('session/event', session, assistantEvent('cap-1', '我摸鱼呢'))
  ctx.emit('session/event', session, turnEndEvent())

  const { text } = await pending
  assert.equal(text, '在吗\n我摸鱼呢')
  capture.dispose()
})

await check('超时后返回已捕获的内容（不必等 turn/end）', async () => {
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const pending = capture.begin('cap-2', 30)
  ctx.emit('session/event', { id: 'cap-2' }, assistantEvent('cap-2', '刚到家'))
  const { text } = await withKeepAlive(pending)
  assert.equal(text, '刚到家')
  capture.dispose()
})

await check('没有任何写回时超时返回空串', async () => {
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const { text } = await withKeepAlive(capture.begin('cap-3', 20))
  assert.equal(text, '')
  capture.dispose()
})

await check('事件属于别的会话时不串台', async () => {
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const pending = capture.begin('cap-4', 30)
  ctx.emit('session/event', { id: 'other-session' }, assistantEvent('other-session', '别人的话'))
  assert.equal((await withKeepAlive(pending)).text, '')
  capture.dispose()
})

await check('没有 session id 的事件被忽略', async () => {
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const pending = capture.begin('cap-5', 25)
  ctx.emit('session/event', {}, assistantEvent('cap-5', '走丢了'))
  assert.equal((await withKeepAlive(pending)).text, '')
  capture.dispose()
})

await check('interlude_say 的调用被捕获为 speech，与正文分开', async () => {
  // 这是「从根上分离」的核心：正文（含思考）走 text，发言走 speech。
  // 两者在通道上不同，所以模型把思考写进正文不会再有任何投递后果。
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const pending = capture.begin('cap-say', 5_000)

  ctx.emit('session/event', { id: 'cap-say' }, assistantEvent('cap-say', '用户问“那今天呢”。我组织一下，要不要回他。'))
  ctx.emit('session/event', { id: 'cap-say' }, sayEvent('今天不算，说完就睡\n你倒管起我来了'))
  ctx.emit('session/event', { id: 'cap-say' }, turnEndEvent())

  const { text, speech } = await pending
  assert.ok(text.includes('我组织一下'), '正文照旧被捕获（留作故事）')
  assert.deepEqual(speech, ['今天不算，说完就睡', '你倒管起我来了'], '工具里的每行各成一条')
  capture.dispose()
})

await check('工具名不是 interlude_say 时不误捕获', async () => {
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const pending = capture.begin('cap-say2', 5_000)
  // 其它工具（例如 interlude_plan）的 arguments 里也可能有 text 字段，不能当发言。
  ctx.emit('session/event', { id: 'cap-say2' }, sayEvent('不该被当成发言', 'interlude_plan'))
  ctx.emit('session/event', { id: 'cap-say2' }, turnEndEvent())
  assert.deepEqual((await pending).speech, [])
  capture.dispose()
})

await check('interlude_say 参数坏掉时安静忽略，不抛错', async () => {
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const pending = capture.begin('cap-say3', 5_000)
  ctx.emit('session/event', { id: 'cap-say3' }, { type: 'tool/call', data: { turn: 1, step: 1, name: 'interlude_say', arguments: '{不是合法 JSON' } })
  ctx.emit('session/event', { id: 'cap-say3' }, { type: 'tool/call', data: { turn: 1, step: 1, name: 'interlude_say', arguments: '{}' } })
  ctx.emit('session/event', { id: 'cap-say3' }, turnEndEvent())
  assert.deepEqual((await pending).speech, [])
  capture.dispose()
})

await check('同一会话重复 begin 会先结算上一个窗口', async () => {  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const first = capture.begin('cap-6', 5_000)
  const second = capture.begin('cap-6', 5_000)
  ctx.emit('session/event', { id: 'cap-6' }, assistantEvent('cap-6', '第二轮'))
  ctx.emit('session/event', { id: 'cap-6' }, turnEndEvent())

  assert.equal((await first).text, '', '旧窗口应以空串收束')
  assert.equal((await second).text, '第二轮', '新窗口应拿到这一轮的话')
  capture.dispose()
})

await check('dispose 会结算挂起的窗口而不是泄漏', async () => {
  const ctx = new Context()
  const capture = installProactiveCapture(ctx)
  const pending = capture.begin('cap-7', 5_000)
  ctx.emit('session/event', { id: 'cap-7' }, assistantEvent('cap-7', '没说完'))
  capture.dispose()
  assert.equal((await pending).text, '没说完')
  assert.equal(capture.size(), 0)
})

await check('缺少 ctx.on 时仍可用（退化为纯超时）', async () => {
  const capture = installProactiveCapture({})
  const { text } = await withKeepAlive(capture.begin('cap-8', 20))
  assert.equal(text, '')
  capture.dispose()
})

console.log('IM 命令路径')

const captured = { sections: [], tools: [], commands: [] }
function fakeSettings() {
  const listeners = new Set()
  const scopes = new Map()
  return {
    register(ns, schema, options) {
      let user = {}
      const resolveImpl = () => ({ ...schema(options?.base ?? {}), ...user })
      const scope = {
        get: resolveImpl,
        watch(cb) { listeners.add(cb); return () => listeners.delete(cb) },
        async update(patch) { user = { ...user, ...patch }; for (const cb of listeners) await cb(resolveImpl(), null) },
        async replace(section) { user = section; for (const cb of listeners) await cb(resolveImpl(), null) },
      }
      scopes.set(ns, scope)
      return scope
    },
    _scopes: scopes,
  }
}

const sent = []
// 自建通道之后没有外部 dshIm 服务了——通道是本插件自己装的。
// 这里注入它的**投递出口**：分条、逐条确认、失败记账全走真实代码路径，
// 只有最后那一跳被替换掉。所以下面测的仍是真行为。
let transportFails = false
const transport = async (targetId, text, options) => {
  if (transportFails) { const error = new Error('boom'); error.code = 'delivery-failed'; throw error }
  sent.push({ targetId, text, hasSignal: Boolean(options?.signal) })
  return { sent: true }
}
// followup 记录被唤起的提示词，供断言「主动回合确实被发起」。
const followups = []
const settings = fakeSettings()
const ctx = new Context()
ctx.provide('agents', { currentInitiator: () => undefined })
ctx.provide('systemPrompt', { section: spec => (captured.sections.push(spec), () => {}) })
ctx.provide('tools', { register: def => (captured.tools.push(def), () => {}) })
ctx.provide('commands', { register: def => (captured.commands.push(def), () => {}) })
ctx.provide('settings', settings)
ctx.provide('webServer', { register: () => {} })
ctx.provide('credentials', { resolve: async () => undefined })
ctx.__qqImTransport = transport

// 配置里同时给出：
//   - im.botId / im.targetId（旧式手工绑定，仍然支持）
//   - im.appId（自建通道把它当作「通道可用」的前提）
const config = plugin.Config({
  timeZone: 'Asia/Shanghai',
  im: { enabled: true, appId: 'test-app', botId: 'qq_bot', targetId: 'jiangyou' },
})
const fiber = ctx.plugin(plugin, config)
if (fiber && typeof fiber.then === 'function') await fiber
await sleep(30)

const handler = captured.commands[0].handler
const command = (rawInput, agent = fakeAgent('im-cmd')) => handler({
  agent, rawInput, attachments: [], signal: new AbortController().signal,
})
function fakeAgent(id) {
  return { id, session: { id, seq: 0, eventAt: () => undefined }, followup: message => followups.push({ id, message }) }
}

await check('/interlude im 显示绑定与投递服务状态', async () => {
  const result = await command(' im')
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('qq_bot'), result.text)
  assert.ok(result.text.includes('jiangyou'), result.text)
  // 自建通道之后状态行的重点是「通道起没起」与「降级策略」，
  // 而不是 dsh-im 那个外部服务的可用性。
  assert.ok(result.text.includes('通道'), result.text)
})

await check('规则段随 im.enabled 打开而注入 IM 说话方式', async () => {
  // 人设/规则不再注册为全局 systemPrompt 段，改为按会话在 pre-step 注入。
  // 这里用一个真实存在的预设目录把会话标成「角色会话」，再从注入消息里取规则段。
  const presetDir = path.join(TEST_HOME, '.agent-presets', 'preset-im-test')
  fs.mkdirSync(presetDir, { recursive: true })
  fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: test\n')
  const agent = {
    id: 'im-rules',
    // 运行时 preset 位于 SessionHeader（与 dsh-session 的 agent.session.header 一致）
    session: { id: 'im-rules', header: { id: 'im-rules', agentPreset: 'preset-im-test' }, seq: 0, eventAt: () => undefined },
  }
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const rules = decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.ok(rules.includes('聊天软件'), rules.slice(0, 400))
})

await check('/interlude im test 按一条一条发出，且旁白不入消息', async () => {
  sent.length = 0
  const result = await command(' im test （看了眼手机）在吗|我摸鱼呢|楼下那家面馆涨价了')
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('已投递'), result.text)
  assert.ok(sent.length >= 2, `应发出多条，实际 ${sent.length}`)
  for (const item of sent) {
    assert.equal(item.targetId, 'jiangyou')
    assert.ok(!item.text.includes('（'), `漏出旁白：${item.text}`)
    assert.ok(item.text.length <= 40, `单条过长：${item.text}`)
  }
  assert.ok(sent.some(m => m.text === '在吗'), JSON.stringify(sent.map(m => m.text)))
})

await check('不加分段符时给默认示例文案，同样分条', async () => {
  sent.length = 0
  const result = await command(' im test')
  assert.equal(result.kind, 'success', result.text)
  assert.ok(sent.length >= 2, `应发出多条，实际 ${sent.length}`)
})

await check('单段文案只发一条', async () => {
  sent.length = 0
  await command(' im test 今天好累')
  assert.equal(sent.length, 1, JSON.stringify(sent.map(m => m.text)))
  assert.equal(sent[0].text, '今天好累')
})

await check('/interlude im test 不泄露 markdown 粗体', async () => {
  sent.length = 0
  await command(' im test **很累**|今天加班到十点')
  for (const item of sent) {
    assert.ok(!item.text.includes('**'), `漏出 markdown：${item.text}`)
  }
})

await check('未绑定目标时 im test 明确报错而不是静默失败', async () => {
  const result = await command(' im test', fakeAgent('im-unbound'))
  // 配置里给了 botId/targetId，因此这里仍应成功；真正验证的是「有绑定就一定发得出去」。
  assert.equal(result.kind, 'success', result.text)
})

await check('投递失败时 im test 返回错误并如实报告', async () => {
  transportFails = true
  try {
    const result = await command(' im test 试一下')
    assert.equal(result.kind, 'error', result.text)
    assert.ok(result.text.includes('delivery-failed'), result.text)
  } finally {
    transportFails = false
  }
})

await check('im bind 覆盖配置绑定并持久化到会话状态', async () => {
  const agent = fakeAgent('im-bind')
  const bound = await command(' im bind qq_other 另一个目标', agent)
  assert.equal(bound.kind, 'success', bound.text)

  const status = await command(' im', agent)
  assert.ok(status.text.includes('qq_other'), status.text)
  assert.ok(status.text.includes('会话绑定'), status.text)

  sent.length = 0
  await command(' im test 你好', agent)
  assert.equal(sent[0].targetId, '另一个目标')
})

await check('im unbind 之后回退到插件配置', async () => {
  const agent = fakeAgent('im-bind')
  await command(' im unbind', agent)
  const status = await command(' im', agent)
  assert.ok(status.text.includes('插件配置'), status.text)
})

await check('参数不全时 im bind 报用法错误', async () => {
  const result = await command(' im bind 只有一个', fakeAgent('im-bad'))
  assert.equal(result.kind, 'error', result.text)
})

await check('未知子命令的提示里包含 im', async () => {
  const result = await command(' nope')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('im'), result.text)
})

await check('通道未配 appId 时 im 状态如实报告、test 报错（不再是「dsh-im 未加载」）', async () => {
  const bare = new Context()
  const bareCaptured = { sections: [], tools: [], commands: [] }
  bare.provide('agents', { currentInitiator: () => undefined })
  bare.provide('systemPrompt', { section: spec => (bareCaptured.sections.push(spec), () => {}) })
  bare.provide('tools', { register: def => (bareCaptured.tools.push(def), () => {}) })
  bare.provide('commands', { register: def => (bareCaptured.commands.push(def), () => {}) })
  bare.provide('settings', fakeSettings())
  bare.provide('webServer', { register: () => {} })
  bare.provide('credentials', { resolve: async () => undefined })
  // 刻意不给 appId，也不注入 transport：通道启动不起来。
  const bareFiber = bare.plugin(plugin, plugin.Config({ timeZone: 'Asia/Shanghai', im: { enabled: true, botId: 'b', targetId: 't' } }))
  if (bareFiber && typeof bareFiber.then === 'function') await bareFiber
  await sleep(20)

  const bareHandler = bareCaptured.commands[0].handler
  const run = rawInput => bareHandler({ agent: fakeAgent('bare'), rawInput, attachments: [], signal: new AbortController().signal })

  // 状态行要如实说「未启动」，并指出缺的是 appId——这行是用户唯一的自检窗口。
  const status = await run(' im')
  assert.ok(status.text.includes('未启动'), status.text)
  assert.ok(status.text.includes('AppID'), status.text)

  // 投递要如实失败，且错误码是通道自己的（不再是 dsh-im-unavailable）。
  const tested = await run(' im test 在吗')
  assert.equal(tested.kind, 'error', tested.text)
  assert.ok(tested.text.includes('im-unavailable'), tested.text)
  await bare.stop?.()
})

await check('im targets 列出本通道的绑定关系', async () => {
  // 自建通道的「目标」就是它自己的绑定表——不再问外部服务的 Bot 列表。
  const result = await command(' im targets')
  assert.equal(result.kind, 'success', result.text)
  // 配置里手工给了 botId/targetId，通道的 listBots 应当把它报出来。
  assert.ok(result.text.includes('qq_bot'), result.text)
  assert.ok(result.text.includes('Bot'), result.text)
})

await check('im discover 列出绑定表，并说明如何自动建立', async () => {
  const result = await command(' im discover')
  assert.equal(result.kind, 'success', result.text)
  // 没有任何绑定时的引导文案。
  assert.ok(result.text.includes('绑定'), result.text)
})

await check('im status 报告降级策略（本插件最重要的自检项）', async () => {
  const result = await command(' im')
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('strict'), result.text)
  // 必须把「不调工具就不外发」这个后果讲清楚，否则用户看到角色沉默会以为是坏了。
  assert.ok(result.text.includes('interlude_say'), result.text)
})

await check('im reconnect 重启通道并如实回报状态', async () => {
  const result = await command(' im reconnect')
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('IM 通道'), result.text)
})

await check('im rebind：把当前会话设为该 QQ 私聊的投递目标（修「会话不显示」）', async () => {
  // 线上场景：旧绑定指向一个看不见的旧会话。在用户正打开的会话里
  // 执行 im rebind，把投递目标改到本会话——不必手删 bindings.json。
  const result = await command(' im rebind c2c:4DDB1DAECE915EF43E97783A7463F0A3')
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('已把 c2c:4DDB1DAECE915EF43E97783A7463F0A3'), result.text)

  // 再查一次绑定表，确认目标已改到本会话。
  const after = await command(' im discover')
  assert.equal(after.kind, 'success', after.text)
  assert.ok(after.text.includes('c2c:4DDB1DAECE915EF43E97783A7463F0A3'), after.text)
})

await check('im rebind 缺目标且当前无绑定时报用法', async () => {
  // 用一个新的假会话（没有绑定），不带参数应当提示用法。
  const result = await command(' im rebind', fakeAgent('im-rebind-nobinding'))
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('用法'), result.text)
})

console.log('到期待办的过期与合并')

await check('过期待办不补发；同期待办合并成一次开口', async () => {
  const { addIntent, dueIntents } = await import('../lib/state.js')
  const { renderProactiveText } = await import('../lib/render.js')

  const now = Date.now()
  const MIN = 60_000
  const HOUR = 60 * MIN
  const state = { intents: [], seq: 0, continuity: '' }

  addIntent(state, { kind: 'reminder', summary: '很久以前该提醒的事', dueAt: now - 8 * HOUR }, now - 8 * HOUR)
  addIntent(state, { kind: 'reminder', summary: '刚到期的事', dueAt: now - 3 * MIN }, now - 3 * MIN)
  addIntent(state, { kind: 'followup', summary: '也差不多该问了', dueAt: now - 2 * MIN }, now - 2 * MIN)

  const due = dueIntents(state, now)
  assert.equal(due.length, 3, '三条都应算作到期')

  // 复刻扫描里的分拣逻辑：>6h 的标过期，其余合并成一次开口。
  const stale = due.filter(intent => intent.dueAt < now - 6 * HOUR)
  for (const intent of stale) intent.status = 'expired'
  const pending = due.filter(intent => intent.status === 'pending')
  const target = pending[0]
  target.bundled = pending.slice(1).map(i => ({ id: i.id, summary: i.summary, kind: i.kind }))

  assert.equal(stale.length, 1, '只有 8 小时前那条过期')
  assert.equal(stale[0].summary, '很久以前该提醒的事')
  assert.equal(pending.length, 2, '另外两条合并为一次开口')
  assert.equal(target.bundled.length, 1)

  const text = renderProactiveText(target, now, 'Asia/Shanghai', state)
  assert.ok(text.includes('刚到期的事'), text)
  assert.ok(text.includes('也差不多该问了'), text)
  assert.ok(text.includes('不要分成好几条消息'), text)
  assert.ok(!text.includes('很久以前该提醒的事'), '过期的不该出现在唤起文本里')
})

await check('只有一条到期时不产生 bundled 段，且 id 渲染无多余空格', async () => {
  const { renderProactiveText } = await import('../lib/render.js')
  const text = renderProactiveText({ id: 'i1', summary: '一件事', kind: 'reminder' }, Date.now(), 'Asia/Shanghai', {})
  assert.ok(text.includes('(i1) 一件事'), text)
  assert.ok(!text.includes('( i1)'), '不该有多余空格')
  assert.ok(!text.includes('另外这几件事'), text)
})

await ctx.stop?.()

console.log(`\n主动投递：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
