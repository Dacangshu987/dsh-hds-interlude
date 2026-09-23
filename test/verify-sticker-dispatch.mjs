/**
 * 角色「发表情」机制验证：三条路径各自的实际行为。
 *
 * 「表情」在本插件里是两个完全不同的东西，验证必须分开：
 *
 *   A. **QQ 原生表情**（`[face:14]` / `[微笑]`）——只是文本标记，混在正文里发。
 *      模型写中文名，收集时翻成 QQ 认的 `[face:N]`。
 *   B. **表情包图片**（`interlude_send_image`）——真的走图片通道（上传 + 发图）。
 *
 * 而「主动」与否又分成两条投递路径：
 *
 *   ① **交互式回复**：用户在会话里说话 → 角色回 → 走 `turnSpeech` 收集
 *      （**含**文字与图片的有序 items）。
 *   ② **主动发起**：到点提醒 / 自动生活推进 → 走 `proactiveCapture` 收集
 *      （**只有文本**：正文 + interlude_say 的话）。
 *
 * 本脚本逐条跑真实链路，把「哪条路径能发表情、哪条不能」用实证摆出来。
 *
 * 运行：node test/verify-sticker-dispatch.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { caseDir } from './helpers/tmp.mjs'

const SESSION = 'session-sticker-verify'
const TARGET = 'c2c:USER_OPENID'
const CONV = TARGET

let passed = 0
let failed = 0
function step(label, ok, detail = '') {
  if (!ok) failed += 1
  if (ok) passed += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `\n      ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 造一个最小可用的插件宿主 + 一张真实表情图。 */
async function boot({ withSticker = true, faceEnabled = true, imagesEnabled = true } = {}) {
  const home = caseDir('sticker-home')
  fs.mkdirSync(path.join(home, '.agent-presets', 'p'), { recursive: true })
  fs.writeFileSync(path.join(home, '.agent-presets', 'p', 'preset.yml'), 'name: p\n')
  process.env.DSH_HOME = home

  // 造一张 1×1 的合法 PNG 当表情素材（内容不重要，走的是真实文件读取路径）。
  const stickerDir = path.join(home, 'stickers')
  fs.mkdirSync(path.join(stickerDir, 'mine'), { recursive: true })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  if (withSticker) fs.writeFileSync(path.join(stickerDir, 'mine', '开心.png'), png)

  // 绑定表要在插件启动前写好。
  const { BindingStore } = await import('../lib/qq-im/binding.js')
  const store = new BindingStore({ home })
  store.set({ conversationKey: CONV, sessionId: SESSION, botId: 'qq_bot', name: '我' })

  const plugin = await import('../lib/index.js')
  const { saveState, emptyState, addIntent } = await import('../lib/state.js')

  const sent = []
  const ctx = new Context()
  let currentAgent
  ctx.provide('agents', { get: () => currentAgent, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', {
    register: (ns, schema, o) => ({
      get: () => schema(o?.base ?? {}), watch: () => () => {}, update: async () => {}, replace: async () => {},
    }),
  })
  ctx.provide('webServer', { register: () => {} })
  ctx.provide('credentials', { resolve: async () => undefined })

  /**
   * 假传输层：文本与图片分别记账。
   *
   * 注意签名 `(target, text, options)`：图片走的是 `transport(peer, {kind:'image', source})`，
   * 所以这里要能区分「发出去的是文字还是图片」——这正是本验证的核心证据。
   */
  ctx.__qqImTransport = async (target, payload, options) => {
    if (payload && typeof payload === 'object' && payload.kind === 'image') {
      sent.push({ type: 'image', target, source: payload.source })
    } else {
      sent.push({ type: 'text', target, text: String(payload) })
    }
    return { sent: true }
  }

  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  state.lastAssistantAt = Date.now() - 3 * 3600_000
  saveState(SESSION, state)

  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    proactive: { enabled: true, checkIntervalMinutes: 1, graceMinutes: 0 },
    runtime: { restWindows: [], autoAdvanceEnabled: false },
    im: {
      enabled: true, appId: 'test-app', messageIntervalMinutes: 0, waitForTurnMs: 5000,
      botId: 'qq_bot', targetId: TARGET,
      stickerDir, faceEnabled, imagesEnabled,
      // 交互式回复默认要求「该会话确实从 QQ 说过话」（requireInbound）——
      // 验证里我们要模拟的正是"从 QQ 来的消息"，所以关掉这层额外要求，
      // 把测点集中在「表情能不能发出去」上。
      interactive: { enabled: true, requireInbound: false },
    },
  })
  return { ctx, config, sent, home, stickerDir, saveState, emptyState, addIntent, plugin }
}

/* ============================================================ A. 原生表情 */

console.log('角色发表情机制验证\n')
console.log('【A】QQ 原生表情（文本标记）')

{
  const b = await boot()
  const { materializeFaces, humanizeFaces, FACE_NAMES } = await import('../lib/qq-im/face.js')

  // 注意「微笑」在 QQ 表里对应两个 id（0 与 14），NAME_TO_ID 取最小的那个——
  // 所以断言只钉「翻成了合法 face 标记」，不钉具体是 0 还是 14。
  const converted = materializeFaces('今天好累[微笑]')
  step('中文名 → QQ 标记（发出去的方向）',
    /^今天好累\[face:\d+\]$/.test(converted),
    `实际：${converted}`)
  step('翻出的 id 在表情表里有名字（不是乱翻）', (() => {
    const id = Number((/\[face:(\d+)\]/.exec(converted) ?? [])[1])
    return Number.isFinite(id) && typeof FACE_NAMES[id] === 'string'
  })(), `翻出的 id → ${FACE_NAMES[Number((/\[face:(\d+)\]/.exec(converted) ?? [])[1])]}`)
  step('QQ 标记 → 中文名（收进来的方向）',
    humanizeFaces('[face:14]').includes('微笑'),
    `实际：${humanizeFaces('[face:14]')}`)
  step('未知 id 不瞎猜（保留可读占位）',
    humanizeFaces('[face:99999]').includes('99999'),
    `实际：${humanizeFaces('[face:99999]')}`)
  step('已经是 face 标记的文本不被二次改写',
    materializeFaces('[face:14]') === '[face:14]',
    `实际：${materializeFaces('[face:14]')}`)
  await b.ctx.stop?.()
}

/* =========================================== B. 交互式回复发表情（应成功） */

console.log('\n【B】交互式回复：角色发表情包图片')
{
  const b = await boot()
  const agent = {
    id: SESSION,
    session: { id: SESSION, header: { id: SESSION, agentPreset: 'p' }, seq: 0, eventAt: () => undefined },
    followup() {},
  }
  b.ctx.provide('sessionController', { async resolveAgent() { return agent } })

  // 顺序很重要：先起插件（它要注册 session/event 监听），再让 agent 上线。
  const fiber = b.ctx.plugin(b.plugin, b.config)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(80)
  b.ctx.emit('agent/session-start', { agent })
  await sleep(50)

  // 模拟：用户在会话里说话 → 角色调用 interlude_say（文字）+ interlude_send_image（表情）。
  b.ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: '在忙吗' }] } })
  await sleep(30)
  b.ctx.emit('session/event', agent.session, {
    type: 'tool/call',
    data: { name: 'interlude_say', arguments: JSON.stringify({ text: '在的' }) },
  })
  b.ctx.emit('session/event', agent.session, {
    type: 'tool/call',
    data: { name: 'interlude_send_image', arguments: JSON.stringify({ name: '开心' }) },
  })
  b.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(900)

  const texts = b.sent.filter((m) => m.type === 'text')
  const images = b.sent.filter((m) => m.type === 'image')
  console.log(`      [现状] 文字 ${texts.length} 条：${JSON.stringify(texts.map((m) => m.text))}`)
  console.log(`      [现状] 图片 ${images.length} 张`)
  step('文字发出去了', texts.some((m) => m.text.includes('在的')), JSON.stringify(texts.map((m) => m.text)))
  step('图片发出去了（表情包走真实图片通道）', images.length > 0,
    images.length ? `图片目标：${JSON.stringify(images[0].source)}` : '一张图都没发出去')
  step('文字与图片都有（有序投放）', texts.length > 0 && images.length > 0,
    `文字 ${texts.length} 条 / 图片 ${images.length} 张`)

  await b.ctx.stop?.()
}

/* ============================= C. 主动发起时发表情（能力边界） */

console.log('\n【C】主动发起（到点提醒）：能否带表情')
{
  const b = await boot()
  const { loadState } = await import('../lib/state.js')

  // 造一条到期待办，并让"模型"在被唤起时同时说出话 + 发一张表情。
  const st = loadState(SESSION)
  b.addIntent(st, { kind: 'reminder', summary: '提醒喝水', dueAt: Date.now() - 60_000 }, Date.now())
  b.saveState(SESSION, st)

  const agent = {
    id: SESSION,
    session: { id: SESSION, header: { id: SESSION, agentPreset: 'p' }, seq: 0, eventAt: () => undefined },
    followup() {
      // 主动路径的"模型"：既调 say 也调 send_image。
      setTimeout(() => {
        b.ctx.emit('session/event', agent.session, {
          type: 'tool/call', data: { name: 'interlude_say', arguments: JSON.stringify({ text: '记得喝水' }) },
        })
        b.ctx.emit('session/event', agent.session, {
          type: 'tool/call', data: { name: 'interlude_send_image', arguments: JSON.stringify({ name: '开心' }) },
        })
        b.ctx.emit('session/event', agent.session, {
          type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '（顺手拿起杯子。）' }] } },
        })
        b.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      }, 5)
    },
  }
  b.ctx.provide('sessionController', { async resolveAgent() { return agent } })

  const fiber = b.ctx.plugin(b.plugin, b.config)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(80)
  b.ctx.emit('agent/session-start', { agent })
  await sleep(6500)

  const texts = b.sent.filter((m) => m.type === 'text')
  const images = b.sent.filter((m) => m.type === 'image')
  console.log(`      [现状] 文字 ${texts.length} 条：${JSON.stringify(texts.map((m) => m.text))}`)
  console.log(`      [现状] 图片 ${images.length} 张`)

  step('主动路径能发出文字（interlude_say）', texts.some((m) => m.text.includes('记得喝水')),
    texts.length ? '' : '一条文字都没发出')
  step('主动路径能带表情图片', images.length > 0,
    images.length ? `发出 ${images.length} 张` : '一张图都没发出去（capture 没收集图片？）')

  await b.ctx.stop?.()
}

/* ============================= D. 开关生效 */

console.log('\n【D】开关是否真的生效')
{
  // faceEnabled=false 时，收集阶段**不做**中文名→标记的翻译（保持模型原样文本）。
  // 这里验的是那条分支本身：同样的 say 文本，开/关两个实例发出的内容不同。
  const on = await boot({ faceEnabled: true })
  const off = await boot({ faceEnabled: false })

  /** 让一个实例按交互式路径发一句带原生表情的话，返回实际发出的文本。 */
  async function dispatchOnce(b) {
    const agent = {
      id: SESSION,
      session: { id: SESSION, header: { id: SESSION, agentPreset: 'p' }, seq: 0, eventAt: () => undefined },
      followup() {},
    }
    b.ctx.provide('sessionController', { async resolveAgent() { return agent } })
    const fiber = b.ctx.plugin(b.plugin, b.config)
    if (fiber && typeof fiber.then === 'function') await fiber
    await sleep(80)
    b.ctx.emit('agent/session-start', { agent })
    await sleep(40)
    b.ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } })
    await sleep(20)
    b.ctx.emit('session/event', agent.session, {
      type: 'tool/call', data: { name: 'interlude_say', arguments: JSON.stringify({ text: '好累[微笑]' }) },
    })
    b.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(900)
    await b.ctx.stop?.()
    return b.sent.filter((m) => m.type === 'text').map((m) => m.text).join(' | ')
  }

  const onText = await dispatchOnce(on)
  const offText = await dispatchOnce(off)
  console.log(`      [现状] faceEnabled=true  发出：${JSON.stringify(onText)}`)
  console.log(`      [现状] faceEnabled=false 发出：${JSON.stringify(offText)}`)
  step('faceEnabled=true 时翻成 QQ 认的标记', onText.includes('[face:'), onText)
  step('faceEnabled=false 时保持原样（不翻）', !offText.includes('[face:'), offText)
}

console.log(`\n验证结束：${passed} 项符合预期，${failed} 项不符合`)
process.exit(failed === 0 ? 0 : 1)
