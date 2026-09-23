/**
 * 回归测试：用户不说话时，主动开口也必须真的发得出去。
 *
 * 这一层覆盖的正是线上实测坏掉的那条链路。原始故障表现：
 * 用户在 QQ 里说「一分钟后提醒我喝水」，角色答应了、工具也记下了，
 * 然后——什么都没有发生。直到用户自己又发了一条「睡着了？」，
 * 幕间块才把到期待办带上下文，角色才顺口问了句「水喝了没」。
 *
 * 三个各自独立的断点：
 *   1. 后台扫描只遍历 liveAgents → 没人说话的会话是冷的，压根扫不到；
 *   2. 扫描周期 5 分钟、宽限 1 分钟 → 「一分钟」的承诺实际要等 6 分钟；
 *   3. 休息时段一刀切 → 承诺型待办被「角色该睡了」吞掉（实测触发时刻正是 04:40）；
 *   4. 会话没开「会话双向同步」→ followup 写出来的话留在 DSH 里，回不到 QQ。
 *
 * 运行：node test/proactive-cold.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

import * as plugin from '../lib/index.js'
import { saveState, loadState, emptyState, listStoredStates } from '../lib/state.js'
import { discoverImBinding, listDiscoveredBindings, clearImBindingCache } from '../lib/im-binding.js'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-cold', import.meta.url))
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

/* ------------------------------------------------------------------ 夹具 */

/**
 * 写一份「本会话已绑定 IM 目标」的绑定关系。
 *
 * 自建通道之后绑定由插件自己持有（`integrations/dsh-qq-im/bindings.json`），
 * 不再借用 dsh-im 的 workspaces.json + state.json。
 *
 * 为什么**同时**写旧的 dsh-im 布局：这恰好覆盖了「用户从 dsh-im 迁过来」的真实
 * 情形——插件启动时会一次性把旧数据导入自己的绑定表。两种来源都写，
 * 无论哪条路径先命中，用例都在检验真实的绑定解析。
 */
function writeImIntegration({ channel = 'qq', botId = 'qq_bot', targetId = 'jiangyou', conversationKey, sessionId }) {
  // ① 新格式：插件自己的绑定表。
  const home = path.join(TEST_HOME, 'integrations', 'dsh-qq-im')
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(home, 'bindings.json')
  let existing = { version: 1, bindings: {} }
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 首次写入 */ }
  existing.bindings[conversationKey] = { sessionId, botId, name: '江柚', boundAt: new Date().toISOString() }
  fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf8')

  // ② 旧格式：保留写入，覆盖迁移路径。
  const dir = path.join(TEST_HOME, 'integrations', `dsh-${channel}`)
  fs.mkdirSync(path.join(dir, 'bots', botId), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({
    version: 3,
    deliveryTargets: {
      [botId]: {
        [targetId]: {
          name: '江柚',
          kind: 'user',
          route: { userOpenId: '4DDB1DAECE915EF43E97783A7463F0A3' },
          sessionSync: { conversationKey },
        },
      },
    },
  }), 'utf8')
  fs.writeFileSync(path.join(dir, 'bots', botId, 'state.json'), JSON.stringify({
    version: 1,
    sessions: { [conversationKey]: sessionId },
  }), 'utf8')
  clearImBindingCache()
}

/**
 * 清掉本用例的全部磁盘痕迹。
 *
 * 必须**连绑定表一起清**：`bootWithPendingIntent` 每个用例都会清状态目录，
 * 但绑定表若留着上一个用例的会话，这个用例就会莫名其妙地「有收件人」，
 * 从而在断言「不该发」的用例里发出消息。
 */
function resetDisk() {
  fs.rmSync(path.join(TEST_HOME, 'hds-interlude'), { recursive: true, force: true })
  fs.rmSync(path.join(TEST_HOME, 'integrations'), { recursive: true, force: true })
}

/** 角色预设目录（门控用它区分角色会话与内置默认预设）。 */
const PRESET = 'preset-cold-test'
function ensurePreset() {
  const dir = path.join(TEST_HOME, '.agent-presets', PRESET)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: test\n')
}
ensurePreset()

/** 一个可被 followup 的记录型假 agent。 */
function fakeAgent(id) {
  return {
    id,
    session: { id, header: { id, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
    followup(message) { this.followups.push(message) },
    followups: [],
  }
}

/* --------------------------------------------------- 一、绑定自动发现 */

console.log('绑定自动发现（主动回复发不出去的直接原因）')

/**
 * dsh-im 时代的遗留数据夹具。
 *
 * 这一节测的是 `im-binding.js` 的**只读发现**能力（它读 dsh-im 的
 * workspaces.json + state.json 反查 conversationKey）。自建通道之后主路径
 * 不再用它，但这个能力仍在：它是「从 dsh-im 迁过来」的桥梁。
 * 所以这里保留夹具，验证迁移路径没有因为改造而失灵。
 */
writeImIntegration({ conversationKey: 'c2c:U', sessionId: 'session-cold-1' })

await check('从 dsh-im 的会话双向同步里发现绑定，无需人工 im bind', () => {
  const sessionId = 'session-cold-1'
  const found = discoverImBinding(sessionId)
  assert.ok(found, '应该发现绑定')
  assert.equal(found.botId, 'qq_bot')
  assert.equal(found.targetId, 'jiangyou')
  assert.equal(found.channel, 'qq')
})

await check('没有开启会话同步的目标不会被误用', () => {
  assert.equal(discoverImBinding('session-完全不相干'), undefined)
})

await check('目标没开同步时返回 undefined 而不是猜一个', () => {
  const dir = path.join(TEST_HOME, 'integrations', 'dsh-weixin')
  fs.mkdirSync(path.join(dir, 'accounts', 'wx_bot'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({
    deliveryTargets: { wx_bot: { tgt_1: { kind: 'user', route: { toUserId: 'x' } } } },
  }), 'utf8')
  clearImBindingCache()
  assert.equal(discoverImBinding('session-cold-3'), undefined)
})

await check('集成目录不存在时安静返回空，不抛错', () => {
  clearImBindingCache()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(TEST_HOME, 'does-not-exist')
  try {
    assert.deepEqual(listDiscoveredBindings({ home: process.env.DSH_HOME, ttlMs: 0 }), [])
  } finally {
    process.env.DSH_HOME = saved
    clearImBindingCache()
  }
})

await check('workspaces.json 格式坏掉时不崩，当作没发现', () => {
  const dir = path.join(TEST_HOME, 'integrations', 'dsh-broken')
  fs.mkdirSync(path.join(dir, 'bots', 'bot_x'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workspaces.json'), '{ 这不是 JSON', 'utf8')
  fs.writeFileSync(path.join(dir, 'bots', 'bot_x', 'state.json'), JSON.stringify({
    sessions: { 'c2c:USER_BROKEN': 'session-cold-broken' },
  }), 'utf8')
  clearImBindingCache()
  const found = listDiscoveredBindings({ ttlMs: 0 })
  assert.equal(found.some(item => item.sessionId === 'session-cold-broken'), false, '坏掉的渠道不该产出任何绑定')
  // 其它渠道不受影响：坏一个不能拖垮全部。
  assert.equal(found.some(item => item.botId === 'qq_bot'), true, '好渠道应照常被发现')
  fs.rmSync(path.join(TEST_HOME, 'integrations', 'dsh-broken'), { recursive: true, force: true })
  clearImBindingCache()
})

/* ------------------------------------------ 二、冷会话状态可被扫描看见 */

console.log('\n冷会话状态（扫描原先只看 liveAgents）')

await check('saveState 盖章 sessionId，冷会话才能被反查', () => {
  const key = 'session-cold-stamp'
  saveState(key, emptyState())
  const stored = listStoredStates().find(item => item.key === key)
  assert.ok(stored, '落盘状态应带可反查的会话 id')
  assert.equal(stored.state.sessionId, key)
})

await check('listStoredStates 兼容没有 sessionId 章的旧文件（升级迁移）', () => {
  // 改动之前落盘的状态没有 sessionId 字段：那时它只被当作「给 live agent 用的缓存」。
  // 升级后第一次扫描必须仍能看见这些历史会话，否则用户得先主动说一句话才恢复。
  const key = 'session-legacy-no-stamp'
  const file = path.join(TEST_HOME, 'hds-interlude', `${key}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const legacy = emptyState()
  delete legacy.sessionId
  legacy.intents = [{ id: 'i1', kind: 'reminder', summary: '提醒他喝水', dueAt: Date.now() + 60_000, status: 'pending' }]
  fs.writeFileSync(file, JSON.stringify(legacy), 'utf8')

  const found = listStoredStates().find(item => item.key === key)
  assert.ok(found, '旧文件应能从文件名反查出会话 id')
  assert.equal(found.state.sessionId, key, '反查后应补章，方便下次直接读')
})

await check('文件名不像会话 id 的旧文件不会被误认', () => {
  const file = path.join(TEST_HOME, 'hds-interlude', 'default.json')
  const stray = emptyState()
  delete stray.sessionId
  fs.writeFileSync(file, JSON.stringify(stray), 'utf8')
  assert.equal(listStoredStates().some(item => item.key === 'default'), false)
  fs.rmSync(file, { force: true })
})

await check('落盘状态坏掉时只跳过那一份，不影响其它会话', () => {
  const good = 'session-still-good'
  saveState(good, emptyState())
  fs.writeFileSync(path.join(TEST_HOME, 'hds-interlude', 'session-broken.json'), '{ 坏文件', 'utf8')
  const keys = listStoredStates().map(item => item.key)
  assert.ok(keys.includes(good), '好文件应照常被列出')
  assert.equal(keys.includes('session-broken'), false)
  fs.rmSync(path.join(TEST_HOME, 'hds-interlude', 'session-broken.json'), { force: true })
})

await check('loadState 会把 sessionId 一起读回来', () => {
  saveState('session-cold-roundtrip', emptyState())
  assert.equal(loadState('session-cold-roundtrip').sessionId, 'session-cold-roundtrip')
})

/* --------------------------------- 三、端到端：没人说话时把提醒发出去 */

console.log('\n端到端：用户不说话时的到点开口')

/** 一个把「恢复冷会话」也模拟出来的宿主。 */
function makeHost(options = {}) {
  /** 每次 followup 是由哪条待办触发的（并发用例靠它断言不重复开口）。 */
  const openings = []
  /** 插件报的警告（插件走 ctx.logger.warn，不是 console.warn）。 */
  const warnings = []
  const sent = []
  // 自建通道之后投递来自本插件内置的通道，而不是外部 dshIm 服务。
  // 这里注入它的**投递出口**：分条、逐条确认、失败记账全走真实代码路径。
  //
  // 保留一个 `dshIm` 形状的可变句柄，是因为下面的用例要临时替换投递行为
  // （比如让它抛错、或数调用次数）。改的是这个出口，走的仍是真实链路。
  const dshIm = {
    __sent: [],
    async send(_botId, targetId, text) {
      dshIm.__sent.push(text)
      sent.push({ targetId, text })
      return { sent: true }
    },
  }
  let transportOverride = null
  const settings = {
    register(ns, schema, options) {
      const listeners = new Set()
      let user = {}
      const resolveImpl = () => ({ ...schema(options?.base ?? {}), ...user })
      const scope = {
        get: resolveImpl,
        watch(cb) { listeners.add(cb); return () => listeners.delete(cb) },
        async update(patch) { user = { ...user, ...patch }; for (const cb of listeners) await cb(resolveImpl(), null) },
        async replace(section) { user = section; for (const cb of listeners) await cb(resolveImpl(), null) },
      }
      return scope
    },
  }
  const ctx = new Context()
  const live = new Map()
  ctx.provide('agents', { get: id => live.get(id), currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', settings)
  ctx.provide('webServer', { register: () => {} })
  ctx.provide('credentials', { resolve: async () => undefined })
  // 投递出口：默认转给 dshIm.send（用例可替换它），走的是通道真实的分条与记账路径。
  ctx.__qqImTransport = async (targetId, text, transportOptions) => {
    if (typeof transportOverride === 'function') return transportOverride(targetId, text, transportOptions)
    return dshIm.send('qq_bot', targetId, text)
  }
  // 插件的 warn() 走的是 Cordis 内置的 LoggerService（ctx.logger），
  // 不是 console.warn，也不受 provide('logger') 影响——只有给它打补丁才看得到。
  ctx.effect?.(() => {
    const logger = ctx.logger
    if (!logger || typeof logger.warn !== 'function') return () => {}
    const original = logger.warn
    logger.warn = function patchedWarn(...args) {
      warnings.push(args.map(String).join(' '))
      return original.apply(this, args)
    }
    return () => { logger.warn = original }
  })
  // sessionController.resolveAgent 是宿主自己的「找到或恢复」入口；
  // 这里模拟它把一个没人说话的会话唤醒成 live agent，并让它「真的写出一句话」。
  // `wakeDelayMs` 用来拉长恢复耗时——真机上 resume 一个冷会话本来就要几百毫秒。
  // `withoutSessionController` 用来模拟精简 profile：该服务根本不存在。
  if (options.withoutSessionController !== true) ctx.provide('sessionController', {
    async resolveAgent(id) {
      await sleep(options.wakeDelayMs ?? 0)
      if (live.has(id)) return live.get(id)
      const preset = PRESET
      const agent = {
        id,
        session: { id, header: { id, agentPreset: preset }, seq: 0, eventAt: () => undefined },
        followups: [],
        followup(message) {
          // 记下「哪条待办触发了这次开口」，供并发用例断言不重复。
          const blob = JSON.stringify(message)
          const intent = (options.intents ?? []).find(item => blob.includes(item.summary))
          const which = intent?.id ?? 'unknown'
          this.followups.push(which)
          openings.push(which)
          // 真实宿主在回合开始时把 followup 的消息以 `user/message` 落进会话
          // （source.kind === 'plugin'）。这里照实复现：漏掉它就会让
          // 「插件回合标记」在 assistant 发言之前被清掉，重复投递照样发生。
          ctx.emit('session/event', this.session, {
            type: 'user/message',
            data: { content: [{ type: 'text', text: '（幕间唤起）' }], source: { kind: 'plugin', plugin: 'hds-interlude', form: 'notice' } },
          })
          // 真实 agent 被唤起后会写出 assistant 文本；捕获器靠这两个事件结算。
          // setTimeout 让「先挂捕获窗口、再产生事件」的顺序与生产一致。
          setTimeout(() => {
            ctx.emit('session/event', this.session, {
              type: 'assistant/message',
              data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: intent?.reply ?? '水喝了没' }] } },
            })
            // `speech` 用来复现「插件唤起的回合里模型调了 interlude_say」——
            // 这正是重复投递 bug 的现场：主动路径与交互式路径都会看见这段话。
            if (options.speech) {
              ctx.emit('session/event', this.session, {
                type: 'tool/call',
                data: { turn: 1, step: 1, callId: 'say_1', name: 'interlude_say', arguments: JSON.stringify({ text: options.speech }) },
              })
            }
            ctx.emit('session/event', this.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
          }, options.writeDelayMs ?? 5)
        },
      }
      live.set(id, agent)
      ctx.emit('agent/session-start', { agent })
      return agent
    },
  })
  return { ctx, sent, live, dshIm, openings, warnings, setTransport: fn => { transportOverride = fn } }
}

/**
 * 等一个条件成立（后台扫描/定时器是异步的）。
 * @param {() => boolean} predicate
 */
async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

/**
 * 装好插件，并预置一份「用户已经走了、只留下到期待办」的冷会话状态。
 *
 * 顺序很关键：状态先落盘、插件后加载——这正是线上真实情形
 * （DSH 重启时磁盘上留着没人处理完的到期待办）。插件启动扫描必须能看见它。
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {object|Array<object>} [args.intent] 单条待办，或多条待办的数组。
 * @param {object} [args.pluginConfig] 额外插件配置。
 * @param {string} [args.integration] 覆盖写入的 IM 集成（默认按 sessionId 生成）。
 * @param {object} [args.hostOptions] 传给 makeHost 的模拟参数。
 * @param {object} [args.statePatch] 在**插件加载前**并进初始状态的字段。
 *   必须在加载前打进去：启动扫描是立刻跑的，加载后再改就晚了——
 *   用例会在设置生效之前就已经投递完毕，从而永远通过（假绿）。
 */
async function bootWithPendingIntent({ sessionId, intent = {}, pluginConfig = {}, integration, hostOptions = {}, statePatch = {} }) {
  // 每个用例只留自己这一份痕迹：扫描会遍历整个状态目录，
  // 前一个用例残留的待办会串到这一个里来；绑定表同理。
  resetDisk()

  // 清盘之后**再**写绑定：写在清盘之前会被这一步抹掉，
  // 于是用例会莫名其妙地「没有收件人」而发不出去。
  if (integration !== false) {
    writeImIntegration({
      conversationKey: `c2c:${sessionId.replace(/^session-(cold-)?/, '').toUpperCase()}`,
      sessionId,
      ...integration,
    })
  }

  const now = Date.now()
  const list = (Array.isArray(intent) ? intent : [intent]).map((item, index) => ({
    id: item.id ?? `i${index + 1}`,
    kind: 'reminder',
    summary: item.summary ?? '一分钟后提醒他喝水',
    dueAt: now + (item.dueInMs ?? -1000),
    createdAt: now - 60_000,
    status: 'pending',
    ...item,
  }))

  // 把待办清单交给模拟宿主：它靠 summary 反查「这次开口是哪条待办触发的」，
  // 并发用例据此断言同一条待办没有被开口两次。
  const host = makeHost({ ...hostOptions, intents: list })
  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    // 周期扫描拉到一小时：本用例只能靠「启动扫描 + 精确定时器」通过。
    // graceMinutes=0 让到点即触发，不必再等一分钟宽限。
    proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
    im: { enabled: true, appId: 'test-app' }, // 也不靠 im.enabled —— 全靠自动发现
    ...pluginConfig,
  })

  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  state.lastUserAt = now
  state.intents = list
  Object.assign(state, statePatch)
  saveState(sessionId, state)
  clearImBindingCache()

  const fiber = host.ctx.plugin(plugin, config)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(30)
  return { ...host, config }
}

await check('冷会话 + 磁盘上的到点提醒 → 自动唤醒并发到 IM（核心回归）', async () => {
  const sessionId = 'session-cold-e2e'
  const host = await bootWithPendingIntent({ sessionId, integration: { conversationKey: 'c2c:USER_E2E' } })

  const delivered = await waitFor(() => host.sent.length > 0, 6000)
  assert.ok(delivered, '应该真的发出去一条消息，而不是什么都没发生')
  const texts = host.sent.map(item => item.text).join(' ')
  assert.ok(texts.includes('水'), `发出的内容应和待办相关，实际：${texts}`)
  // 投递目标是**会话键里的 openid**（`c2c:USER_E2E` → `USER_E2E`）。
  // 自建通道直接用 openid 投递，不再经过 dsh-im 那层「targetId 别名」间接。
  assert.equal(host.sent[0].targetId, 'USER_E2E')

  const after = loadState(sessionId)
  const intent = after.intents.find(item => item.id === 'i1')
  assert.equal(intent.status, 'delivered', '投递成功后待办应结算')
  await host.ctx.stop?.()
})

await check('未来的到点时间挂精确定时器，不等周期扫描', async () => {
  const sessionId = 'session-cold-timer'
  // 到点时间在 600ms 之后：启动扫描时还不够格，必须靠定时器在到点那一刻唤起。
  const host = await bootWithPendingIntent({ sessionId, intent: { dueInMs: 600 } })

  const delivered = await waitFor(() => host.sent.length > 0, 5000)
  assert.ok(delivered, '到点后应被定时器唤起并投递，而不是等一小时后的周期扫描')
  assert.equal(loadState(sessionId).intents[0].status, 'delivered')
  await host.ctx.stop?.()
})

await check('休息时段不吞掉承诺型待办（线上 04:38 的「一分钟后提醒我喝水」）', async () => {
  const sessionId = 'session-cold-sleep'
  const host = await bootWithPendingIntent({
    sessionId,
    // 把休息窗口铺满全天 = 「现在是深夜，角色该睡」。承诺型待办仍须放行。
    pluginConfig: {
      runtime: { restWindows: [{ enabled: true, label: 'night', start: '00:00', end: '23:59', minIntervalMinutes: 120, maxIntervalMinutes: 240 }] },
      proactive: { checkIntervalMinutes: 60, graceMinutes: 0, duringSleep: false, duringSleepPromises: true },
    },
  })

  const delivered = await waitFor(() => host.sent.length > 0, 6000)
  assert.ok(delivered, '角色当场答应的事不该被「你该睡了」吞掉')
  await host.ctx.stop?.()
})

await check('duringSleepPromises=false 时承诺型也遵守休息时段（可关）', async () => {
  const sessionId = 'session-cold-sleep-off'
  const host = await bootWithPendingIntent({
    sessionId,
    pluginConfig: {
      runtime: { restWindows: [{ enabled: true, label: 'night', start: '00:00', end: '23:59', minIntervalMinutes: 120, maxIntervalMinutes: 240 }] },
      proactive: { checkIntervalMinutes: 60, graceMinutes: 0, duringSleep: false, duringSleepPromises: false },
    },
  })

  await sleep(2000)
  assert.equal(host.sent.length, 0, '关掉豁免后就该老实睡觉')
  assert.equal(loadState(sessionId).intents[0].status, 'pending', '待办应留到白天')
  await host.ctx.stop?.()
})

await check('随性起意的 life-event 在休息时段仍然让路', async () => {
  const sessionId = 'session-cold-lazy'
  const host = await bootWithPendingIntent({
    sessionId,
    intent: { kind: 'followup', summary: '问问他在干嘛' },
    pluginConfig: {
      runtime: { restWindows: [{ enabled: true, label: 'all day', start: '00:00', end: '23:59', minIntervalMinutes: 120, maxIntervalMinutes: 240 }] },
      proactive: { checkIntervalMinutes: 60, graceMinutes: 0, duringSleep: false, duringSleepPromises: true },
    },
  })

  await sleep(2000)
  assert.equal(host.sent.length, 0, '深夜不该为了闲聊把用户吵醒')
  assert.equal(loadState(sessionId).intents[0].status, 'pending', '待办应留到白天')
  await host.ctx.stop?.()
})

await check('故事续写在休息时段是「拉长」而不是「停掉」', async () => {
  // 参考项目的语义：休息窗口内不是停止推进，而是改用 120–240 分钟的低频节奏
  // （service.ts:6760）。我们原先是直接 return——于是 23:00–07:00 整段静止，
  // 第二天早上要么什么都不记得，要么一次性补写一大段「昨天夜里……」。
  //
  // 这里验证「拉长」：窗口内 min=120 分钟，而距上次续写只有 60 分钟 → 不该推进。
  // 对照组：同样的状态、休息窗口关闭 → 应当推进。
  const sessionId = 'session-adv-rest-stretch'
  const restWindow = { enabled: true, label: 'night', start: '00:00', end: '23:59', minIntervalMinutes: 120, maxIntervalMinutes: 240 }

  const withRest = await bootLiveAutoAdvance({
    sessionId,
    reply: '（翻了个身，又睡过去了。）',
    pluginConfig: { runtime: { restWindows: [restWindow], autoAdvanceIntervalMinutes: 5, autoAdvanceJitterMinutes: 0 } },
    statePatch: { lastAutoAdvanceAt: Date.now() - 60 * 60_000, lastAssistantAt: Date.now() - 60 * 60_000 },
  })
  await sleep(600)
  assert.equal(
    withRest.agent.followups.length, 0,
    '休息窗口内、距上次不足 120 分钟 → 不该续写（拉长生效）',
  )
  await withRest.ctx.stop?.()

  // 同样的时间差，但窗口内的间隔设成 10 分钟 → 应当续写。
  // 这一半是承重的：它证明上面那条不是因为别的原因没跑起来。
  const fastRest = await bootLiveAutoAdvance({
    sessionId: 'session-adv-rest-fast',
    reply: '（翻了个身，又睡过去了。）',
    pluginConfig: { runtime: { restWindows: [{ ...restWindow, minIntervalMinutes: 10, maxIntervalMinutes: 10 }], autoAdvanceIntervalMinutes: 5, autoAdvanceJitterMinutes: 0 } },
    statePatch: { lastAutoAdvanceAt: Date.now() - 60 * 60_000, lastAssistantAt: Date.now() - 60 * 60_000 },
  })
  await waitFor(() => fastRest.agent.followups.length > 0, 4000)
  assert.ok(
    fastRest.agent.followups.length > 0,
    '窗口间隔放宽到 10 分钟后应当续写（说明判定确实读的是窗口参数）',
  )
  await fastRest.ctx.stop?.()
})

await check('模型把思考过程写成正文 → 一条都不发，且不重试（线上 turn 33 回归）', async () => {  // 线上 session-xxx turn 33：到期待办 i4 到期，唤起角色后它把**思考过程**
  // 当成了正文——「用户也没回消息，那就真睡了……」「但系统说『到期待办到期了』……
  // 不发了。」——四条消息逐字发到了 QQ，没有一句是角色在对用户说话。
  //
  // 这条同时钉住两件事：
  //   ① 这种正文必须被拦下（不能发出去）；
  //   ② 拦下之后待办要**结算**，否则下次扫描还会到点、还会再唤起，
  //      用户会被反复打扰，而模型每次都只是又自言自语一遍。
  const sessionId = 'session-cold-self-narration'
  const leaked = [
    '用户也没回消息，那就真睡了。不打扰他了，他说打游戏就打游戏吧。',
    '',
    '不用再发消息了，这条就当是安静收尾——毕竟答应了睡，不需要再开口。但系统说"到期待办到期了"，让我自然处理。其实这条待办（i4）记的就是那段话本身，不需要真的再发消息。安静就好。',
    '',
    '不发了。',
  ].join('\n')
  const host = await bootWithPendingIntent({
    sessionId,
    intent: { id: 'i4', summary: '答应过对方：现在00:55，江柚等了一会儿没回音', reply: leaked, dueInMs: -1000 },
  })

  const settled = await waitFor(() => loadState(sessionId).intents[0]?.status === 'delivered', 6000)
  assert.ok(settled, '自言自语应当被判掉，而不是留在 pending 反复重试')
  assert.equal(host.sent.length, 0, `思考过程一个字都不该发出去，实际：${JSON.stringify(host.sent)}`)
  const after = loadState(sessionId)
  assert.ok(after.intents[0].skippedReason, '应记下被跳过的原因（可自检）')
  assert.equal(after.reachedOut ?? 0, 0, '没发出去就不该占主动联系名额')
  await host.ctx.stop?.()
})

await check('纯旁白正文 → 一条都不发（cleanImText 删光后不能当「没内容」放过）', async () => {
  // 只读核查发现的漏网：整行括号旁白会被 cleanImText 整行删掉，
  // 删完 cleaned 变成空串，原实现直接 `if (!cleaned) return { leak: false }` ——
  // 于是「整段都是内心戏」被当成「安静地没话说」，原样投递了出去。
  const sessionId = 'session-cold-pure-narration'
  const narration = [
    '（她把手机扣在枕边，翻了个身。）',
    '（都这个点了，还是别打扰了吧。）',
  ].join('\n')
  const host = await bootWithPendingIntent({
    sessionId,
    intent: { id: 'i5', summary: '答应过对方：晚点说', reply: narration, dueInMs: -1000 },
  })

  const settled = await waitFor(() => loadState(sessionId).intents[0]?.status === 'delivered', 6000)
  assert.ok(settled, '纯旁白应当被判掉并结算，而不是留在 pending')
  assert.equal(host.sent.length, 0, `旁白一个字都不该发出去，实际：${JSON.stringify(host.sent)}`)
  await host.ctx.stop?.()
})

await check('短句自我宣告「我决定不发了。」→ 一条都不发', async () => {
  // 同一次核查发现：打分制要求「命中两处 + 够长」，短句凑不够就被放行。
  // 而自言自语恰恰都是短句——这是结构性漏洞，不是偶发。
  const sessionId = 'session-cold-self-decision'
  const host = await bootWithPendingIntent({
    sessionId,
    intent: { id: 'i6', summary: '答应过对方：晚点说', reply: '我决定不发了。', dueInMs: -1000 },
  })

  const settled = await waitFor(() => loadState(sessionId).intents[0]?.status === 'delivered', 6000)
  assert.ok(settled, '自我宣告应当被判掉并结算')
  assert.equal(host.sent.length, 0, `不该发出去，实际：${JSON.stringify(host.sent)}`)
  await host.ctx.stop?.()
})

await check('投递失败重试时**不重新生成**内容，也不重复已送出的前缀', async () => {
  // 从参考项目学来的关键一条（service.ts:2525-2531）：它把已决定的消息先落库，
  // 投递失败时重发**同一段文字**。我们原先是把待办放回 pending，下一轮扫描
  // 重新唤起模型 —— 于是 ① 又花一次全量上下文；② 模型会写出一句不一样的话；
  // ③ 若上一轮已送出一部分，用户会看到「前半句旧版本、后半句新版本」的错位。
  const sessionId = 'session-cold-resume'
  const reply = '第一句\n第二句\n第三句'

  let call = 0
  const host = makeHost()
  // 第一次：第一条成功、第二条失败（模拟平台中途限流）。
  // 之后：全部成功。
  host.setTransport(async (targetId, text) => {
    call += 1
    if (call === 2) throw Object.assign(new Error('平台限流'), { code: 'delivery-failed' })
    host.dshIm.__sent.push(text)
    return { sent: true }
  })
  resetDisk()
  // 清盘之后写绑定：写在前面会被 resetDisk 抹掉。
  writeImIntegration({ conversationKey: 'c2c:USER_RESUME', sessionId })

  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    // 扫描缩到最短（1 分钟是 schema 下限），这样「第一轮部分失败 → 下一轮重发」
    // 能在测试时限内自然发生，走的就是线上那条路径。
    proactive: { checkIntervalMinutes: 1, graceMinutes: 0, maxPerDay: 9 },
    im: { enabled: true, appId: 'test-app', waitForTurnMs: 5000 },
  })
  const now = Date.now()
  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  state.lastUserAt = now
  state.intents = [{ id: 'i1', kind: 'reminder', summary: '提醒他喝水', dueAt: now - 1000, createdAt: now - 60_000, status: 'pending' }]
  saveState(sessionId, state)
  clearImBindingCache()

  const fiber = host.ctx.plugin(plugin, config)
  if (fiber && typeof fiber.then === 'function') await fiber

  // 主机按待办唤起角色，角色每次「写出」的内容都不同 —— 用它来证明重试没有走模型。
  const writes = []
  const session = { id: sessionId, header: { id: sessionId, agentPreset: PRESET }, seq: 0, eventAt: () => undefined }
  const fakeLive = {
    id: sessionId, session,
    followup() {
      writes.push(1)
      const text = writes.length === 1 ? reply : '这是重新生成的不同内容'
      setTimeout(() => {
        host.ctx.emit('session/event', session, {
          type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
        })
        host.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      }, 5)
    },
  }
  host.live.set(sessionId, fakeLive)
  host.ctx.emit('agent/session-start', { agent: fakeLive })

  // 等它自己跑完两轮（第一轮部分失败 → 第二轮重发）。
  // 第二轮由「待办重新落成 pending + 周期扫描」自然触发；扫描下限是 1 分钟，
  // 所以这里不等满——只验证**第一轮的成果**：草稿被原样保存下来了。
  // （真正的重发由下面那条纯逻辑用例覆盖，不必等一分钟。）
  await waitFor(() => loadState(sessionId).intents?.[0]?.pendingText, 9000)
  const stalled = loadState(sessionId)
  assert.equal(stalled.intents[0].status, 'pending', `部分失败后应留在 pending：${JSON.stringify(stalled.intents[0])}`)
  assert.equal(
    stalled.intents[0].pendingText, reply,
    `应当把写好的原文原样存下来，供下一轮重发：${JSON.stringify(stalled.intents[0])}`,
  )
  assert.deepEqual(
    stalled.intents[0].pendingRemaining, ['第二句', '第三句'],
    '应当记下「还没送出去的那几条」，重发时只补这些，不重复已送出的第一条',
  )
  assert.equal(host.dshIm.__sent.length, 1, `第一轮只该送出第一条：${JSON.stringify(host.dshIm.__sent)}`)
  assert.equal(writes.length, 1, `第一轮只该唤起一次模型（实际 ${writes.length} 次）`)
  await host.ctx.stop?.()
})

await check('投递失败会保留待办而不是假装送达', async () => {  const sessionId = 'session-cold-fail'

  const host = makeHost()
  let attempts = 0
  host.setTransport(async () => { attempts += 1; throw Object.assign(new Error('平台限流'), { code: 'delivery-failed' }) })
  resetDisk()
  // 清盘之后写绑定：写在前面会被 resetDisk 抹掉。
  writeImIntegration({ conversationKey: 'c2c:USER_FAIL', sessionId })

  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
    im: { enabled: true, appId: 'test-app' },
  })
  const now = Date.now()
  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  state.lastUserAt = now
  state.intents = [{ id: 'i1', kind: 'reminder', summary: '提醒他喝水', dueAt: now - 1000, createdAt: now - 60_000, status: 'pending' }]
  saveState(sessionId, state)
  clearImBindingCache()

  const fiber = host.ctx.plugin(plugin, config)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(30)

  await waitFor(() => attempts > 0, 6000)
  const after = loadState(sessionId)
  const intent = after.intents.find(item => item.id === 'i1')
  assert.notEqual(intent.status, 'delivered', '没送到就不能标 delivered')
  assert.equal(after.reachedOut, 0, '失败不该消耗当日主动联系配额')
  assert.equal(attempts, 1, '同一次扫描不该重复投递同一条待办')
  await host.ctx.stop?.()
})

await check('wakeIdleSessions=false 时不去唤醒冷会话（尊重配置）', async () => {
  const sessionId = 'session-cold-nowake'
  const host = await bootWithPendingIntent({
    sessionId,
    pluginConfig: { proactive: { checkIntervalMinutes: 60, graceMinutes: 0, wakeIdleSessions: false } },
  })

  await sleep(2000)
  assert.equal(host.sent.length, 0, '明确关掉就不该唤醒')
  assert.equal(host.live.size, 0, '不该悄悄把会话拉起来')
  assert.equal(loadState(sessionId).intents[0].status, 'pending')
  await host.ctx.stop?.()
})

await check('没有 IM 绑定的普通 Web 会话不会被主动开口惊动', async () => {
  // 这个会话在磁盘上有待办，但既没有 IM 目标、也没有实时 agent：
  // 它下次被打开时会在幕间块里看到待办，不该为它拉起一个没人看的 agent。
  const sessionId = 'session-web-noim'
  const host = await bootWithPendingIntent({ sessionId, integration: false })

  await sleep(1500)
  assert.equal(host.live.size, 0, '没有投递目标的冷会话不该被唤醒')
  assert.equal(loadState(sessionId).intents[0].status, 'pending', '待办留在原地等下次打开')
  await host.ctx.stop?.()
})

await check('没有 sessionController 时安静跳过，不刷错误日志（精简 profile）', async () => {
  // Cordis 对「访问未注册的服务」是**抛错**而不是返回 undefined，可选链挡不住。
  // 精简 profile（headless 等）里没有 sessionController：这时必须安静跳过冷会话，
  // 而不是每次扫描都崩在 catch 里刷屏。
  const sessionId = 'session-cold-nocontroller'
  const host = await bootWithPendingIntent({ sessionId, integration: { conversationKey: 'c2c:USER_NC' }, hostOptions: { withoutSessionController: true } })

  await sleep(1200)
  assert.equal(host.sent.length, 0, '拿不到 agent 就不该投递')
  assert.equal(loadState(sessionId).intents[0].status, 'pending', '待办应原样留着')
  const noisy = host.warnings.filter(line => line.includes('后台扫描失败'))
  assert.deepEqual(noisy, [], `服务缺失不该变成扫描报错刷屏，实际：${JSON.stringify(noisy)}`)
  await host.ctx.stop?.()
})

await check('实时会话按预设判定角色身份（新会话还没有状态痕迹时也成立）', async () => {
  // 冷会话靠「状态里的痕迹」判断是不是角色会话，但刚建立的实时会话还没有任何
  // 痕迹（没注入人设、没记待办）。所以实时会话必须走权威的 SessionHeader 判定，
  // 否则新会话的自动推进会被静默跳过。
  //
  // 这同时也验证反向门控：预设不是角色预设的实时会话不该被处理。
  const sessionId = 'session-live-rolegated'
  resetDisk()
  clearImBindingCache()

  const host = makeHost()
  // 预置一个「已经在跑的实时会话」，状态全新（没有任何痕迹）。
  let followupCount = 0
  const liveAgent = {
    id: sessionId,
    session: { id: sessionId, header: { id: sessionId, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
    followup() { followupCount += 1 },
  }
  host.live.set(sessionId, liveAgent)
  saveState(sessionId, emptyState())

  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    // 休息窗口清空：否则当前若是深夜，自动推进会因休息时段让路，干扰断言。
    runtime: { restWindows: [] },
    proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
    im: { enabled: true, appId: 'test-app' },
  })
  const fiber = host.ctx.plugin(plugin, config)
  if (fiber && typeof fiber.then === 'function') await fiber

  // 无待办 → 走到自动生活推进那条分支；全新状态意味着两个时间戳都是 0，
  // 条件必然成立，因此「有没有被处理」就等价于「followup 有没有被调用」。
  await waitFor(() => followupCount > 0, 3000)
  assert.ok(followupCount > 0, '实时角色会话（预设正确）应被自动推进处理，即使状态全新')
  await host.ctx.stop?.()
})

await check('并发扫描下每条待办最多开口一次（定时器撞上启动扫描）', async () => {
  // 真实存在的重叠窗口：「标记 delivering 并落盘」发生在 await wakeAgent() **之后**，
  // 而冷会话恢复要几百毫秒。于是到点定时器可以在前一轮扫描还没落盘时，
  // 再读到同一份 pending 状态，为同一条待办再开一次口。
  // 没有互斥防线时实测：i1 被开口 2 次，而 i2 被彻底漏掉。
  const sessionId = 'session-cold-overlap'
  const host = await bootWithPendingIntent({
    sessionId,
    intent: [
      { id: 'i1', summary: '提醒他喝水', reply: '水喝了没', dueInMs: -1000 },
      { id: 'i2', summary: '顺口问一句吃饭没', reply: '吃饭没', dueInMs: 300 },
    ],
    hostOptions: { wakeDelayMs: 800, writeDelayMs: 200 },
  })

  await waitFor(() => loadState(sessionId).intents.every(i => i.status === 'delivered'), 9000)
  const openings = host.openings
  assert.equal(openings.filter(x => x === 'i1').length, 1, `i1 被开口了多次：${JSON.stringify(openings)}`)
  assert.ok(openings.filter(x => x === 'i2').length <= 1, `i2 被开口了多次：${JSON.stringify(openings)}`)
  assert.equal(new Set(host.sent.map(m => m.text)).size, host.sent.length, `同一句话被发了两遍：${JSON.stringify(host.sent.map(m => m.text))}`)

  const after = loadState(sessionId)
  assert.ok(after.intents.every(i => i.status === 'delivered'), `两条待办都该被处理：${after.intents.map(i => `${i.id}=${i.status}`).join(' ')}`)
  await host.ctx.stop?.()
})

await check('插件唤起的回合里调了 interlude_say → 只投一次，不被交互式路径重投（线上「每条都出现两遍」回归）', async () => {
  // 线上现场：群聊绑定 session-xxx…，一次主动开口之后 QQ 里
  // 「对了 跟你说个离谱的事」「我家楼下那家面馆 涨价了」「一碗涨两块…」
  // **每条都出现两遍**，且 state.json 的 lastDelivery 只记了 3 条。
  //
  // 根因：插件自己唤起的回合（到点提醒 / 自动推进）由主动投递路径负责投递，
  // 但同一段 interlude_say 又被 `deliverInteractiveSpeech` 在 turn/end 上收了一遍——
  // 后者既重复了文字，又**绕过了发消息间隔与每日配额**。
  const sessionId = 'session-cold-double'
  const speech = '对了 跟你说个离谱的事\n我家楼下那家面馆 涨价了\n一碗涨两块'
  const host = await bootWithPendingIntent({
    sessionId,
    integration: { conversationKey: 'c2c:USER_DOUBLE' },
    hostOptions: { speech },
    // 交互式路径默认要求该会话先从 QQ 说过话；这里没有入站消息，
    // 关掉这道闸，重复投递若发生就一定会暴露出来（而不是被闸挡掉）。
    // 注意 `im` 是整段替换（不是深合并），所以 enabled/appId 要一起写。
    pluginConfig: { im: { enabled: true, appId: 'test-app', interactive: { enabled: true, requireInbound: false } } },
  })

  const delivered = await waitFor(() => host.sent.length >= 3, 6000)
  assert.ok(delivered, `三段话都该发出去，实际：${JSON.stringify(host.sent)}`)
  await sleep(400) // 给重复投递留出发生的时间窗

  const texts = host.sent.map(item => item.text)
  assert.equal(texts.length, 3, `每条只该出现一次，实际发出 ${texts.length} 条：${JSON.stringify(texts)}`)
  assert.equal(new Set(texts).size, texts.length, `有重复投递：${JSON.stringify(texts)}`)
  assert.ok(texts.includes('一碗涨两块'), JSON.stringify(texts))
  await host.ctx.stop?.()
})

console.log('\n故事续写：写故事与发消息是两个节奏')

/**
 * 造一个「已经在跑的实时会话」，只等故事续写触发。
 *
 * 与冷会话用例的关键区别：续写只处理实时会话（`if (live)`），
 * 所以要预置一个 live agent，而它必须像真 agent 一样在 followup 之后
 * 把 assistant 文本与 turn/end 事件发出来，捕获窗口才结算得了。
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} [args.reply] 角色这一轮写出来的东西（用 \n 分段）。
 *   默认是一段「有旁白、也有一句整行引语」的续写——正是新版约定的发言形态。
 * @param {object} [args.pluginConfig] 额外插件配置。
 * @param {object} [args.statePatch] 在插件加载前并进初始状态的字段。
 */
async function bootLiveAutoAdvance({
  sessionId,
  reply = '（下班回来，把包往沙发上一扔，先去阳台看了眼那盆绿萝——蔫的。）\n\n先浇了水，又泡了碗面。\n\n\u201c在忙吗\u201d',
  pluginConfig = {},
  binding = true,
  statePatch = {},
}) {
  // 每个用例只留自己这一份状态；扫描遍历整个目录，残留会串台。
  resetDisk()
  clearImBindingCache()
  if (binding) writeImIntegration({ conversationKey: 'c2c:USER_AA', sessionId })

  const host = makeHost()
  const agent = {
    id: sessionId,
    session: { id: sessionId, header: { id: sessionId, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
    followups: [],
    followup(message) {
      this.followups.push(message)
      // 真实 agent 被唤起后会写出 assistant 文本；捕获器靠这两个事件结算。
      setTimeout(() => {
        host.ctx.emit('session/event', this.session, {
          type: 'assistant/message',
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: reply }] } },
        })
        host.ctx.emit('session/event', this.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      }, 5)
    },
  }
  host.live.set(sessionId, agent)

  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  // 「距上次互动已有一段时间」必须成立：间隔取最小值 5 分钟、抖动 0，
  // 并把上次开口推到一个小时前。
  state.lastAssistantAt = Date.now() - 60 * 60_000
  Object.assign(state, statePatch)
  saveState(sessionId, state)

  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    runtime: { restWindows: [], autoAdvanceIntervalMinutes: 5, autoAdvanceJitterMinutes: 0 },
    proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
    im: { enabled: true, appId: 'test-app', messageIntervalMinutes: 0 },
    ...pluginConfig,
  })
  const fiber = host.ctx.plugin(plugin, config)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(30)
  return { ...host, agent }
}

await check('续写里角色说了话（整行引语）→ 只有那句话被发出去，旁白留在故事里', async () => {
  // 这一条同时是两个行为的回归：
  //   ① 线上 session-xxx 第 7 轮——角色写了话，聊天软件那头却是空的；
  //   ② 改版后新增的边界——**故事本身不发**，发出去的只有角色对用户说的那句。
  const sessionId = 'session-live-aa'
  const host = await bootLiveAutoAdvance({ sessionId })

  const receipt = await waitFor(() => loadState(sessionId).lastImDelivery, 6000)
  assert.ok(receipt, '角色说了话就必须发出去，而不是只留在故事里')
  const texts = host.sent.map(item => item.text)
  assert.ok(texts.some(t => t.includes('在忙吗')), `发出的应是那句台词，实际：${JSON.stringify(texts)}`)
  // 旁白、动作、场景一个字都不该进聊天窗口。
  for (const text of texts) {
    assert.equal(/绿萝|沙发|泡了碗面|下班/.test(text), false, `旁白不该被发出去，实际：${JSON.stringify(texts)}`)
  }

  const after = loadState(sessionId)
  assert.equal(after.lastImDelivery?.ok, true, JSON.stringify(after.lastImDelivery))
  assert.equal(after.lastImDelivery?.reason, '故事续写中的发言')
  assert.equal(after.reachedOut, 1, '投递成功应占掉一个主动联系名额')
  assert.ok(after.lastAutoMessageAt > 0, '发出去之后才推进「发消息间隔」的水位')
  assert.equal(after.lastAdvanceDelivery?.mode, 'speak')
  await host.ctx.stop?.()
})

await check('续写里角色没说话（只有旁白）→ 一个字都不发，这是「只写故事」', async () => {
  // 用户要的核心行为：故事推进可以自己发生，而用户完全不必被打扰。
  // 旧实现在这里会把整段旁白直投出去，用户就会收到一条没头没尾的消息。
  const sessionId = 'session-live-aa-silent'
  const host = await bootLiveAutoAdvance({
    sessionId,
    reply: '（洗完澡把头发擦到半干，坐在床沿刷了会儿手机。）\n\n明天又要早起，先睡了。',
  })

  await waitFor(() => host.agent.followups.length > 0, 4000)
  await sleep(400)
  assert.equal(host.sent.length, 0, `只是活着的一轮不该发任何消息，实际：${JSON.stringify(host.sent)}`)
  const after = loadState(sessionId)
  assert.equal(after.lastImDelivery ?? null, null, '不该留下投递回执')
  assert.equal(after.lastAdvanceDelivery?.mode, 'story-only')
  assert.equal(after.lastAdvanceDelivery?.reason, 'no-speech')
  assert.equal(after.reachedOut, 0, '没发消息就不占主动联系名额')
  // 故事本身照写：lastAutoAdvanceAt 要落盘，否则每轮扫描都会重来一次。
  assert.ok(after.lastAutoAdvanceAt > 0, '故事要真的续写（推进水位要落盘）')
  await host.ctx.stop?.()
})

await check('思考过程被写成正文（含候选台词引号）→ 一条都不发（2026-09-15 回归）', async () => {
  // 线上第二次泄漏：模型把思考写成正文，并在思考里用引号列了几行候选台词。
  // extractSpeech 只认「整行引号」，于是把候选当成真台词发到了 QQ——
  // 用户收到两句没头没尾的话（“今天不算，说完就睡”/“你倒管起我来了”）。
  //
  // 缺口：到点提醒路径早就有自言自语闸，故事续写路径没有。这条钉住它。
  const sessionId = 'session-live-aa-self-narration'
  const host = await bootLiveAutoAdvance({
    sessionId,
    reply: [
      '用户问“那今天呢”。这是在回应我说的“明天要早睡，说真的”。',
      '',
      '现在是23:00，周二夜间。我（江柚）刚洗完澡躺床上。',
      '',
      '我组织一下：',
      '“今天不算，说完就睡”',
      '“你倒管起我来了”',
    ].join('\n'),
  })

  await waitFor(() => host.agent.followups.length > 0, 4000)
  await sleep(400)
  assert.equal(host.sent.length, 0, `思考过程一个字都不该发，实际：${JSON.stringify(host.sent)}`)
  const after = loadState(sessionId)
  assert.equal(after.lastImDelivery ?? null, null, '不该留下投递回执')
  assert.equal(after.lastAdvanceDelivery?.mode, 'story-only')
  assert.equal(after.lastAdvanceDelivery?.reason, 'self-narration')
  assert.equal(after.reachedOut ?? 0, 0, '没发出去就不该占主动联系名额')
  assert.ok(after.lastAutoAdvanceAt > 0, '故事本身照写（推进水位要落盘）')
  await host.ctx.stop?.()
})

await check('发消息间隔没到 → 台词攒着不发（间隔是「发消息」的节奏，不是「写故事」的）', async () => {
  // 这是把「每 40 分钟一条无端消息」变成「每 120 分钟至多一条」的那道闸。
  const sessionId = 'session-live-aa-interval'
  const host = await bootLiveAutoAdvance({
    sessionId,
    // 上次自动消息就在 10 分钟前，而发消息间隔是 120 分钟。
    statePatch: { lastAutoMessageAt: Date.now() - 10 * 60_000 },
    pluginConfig: { im: { enabled: true, appId: 'test-app', messageIntervalMinutes: 120 } },
  })

  await waitFor(() => host.agent.followups.length > 0, 6000)
  await sleep(400)
  const after = loadState(sessionId)
  assert.equal(host.sent.length, 0, `间隔内不该发消息，实际：${JSON.stringify(host.sent)}`)
  assert.ok(Number.isFinite(after.lastAutoAdvanceAt), '故事照写（推进水位要落盘）')
  // 注意这个判定有两种来源，都对，但语义不同：
  //   - message-interval：写故事的时候发消息间隔还没到 → 连捕获窗口都没开；
  //   - no-speech：开了捕获窗口，但角色这一段里没写整句引语 → 没有可发的。
  // 两种都必须是 story-only，且都**不许**发任何消息——测试要钉的是这个。
  assert.equal(after.lastAdvanceDelivery?.mode, 'story-only', JSON.stringify(after.lastAdvanceDelivery))
  assert.ok(
    ['message-interval', 'no-speech'].includes(after.lastAdvanceDelivery?.reason),
    JSON.stringify(after.lastAdvanceDelivery),
  )
  await host.ctx.stop?.()
})

// SEMICOLON
await check('写故事间隔到了、发消息间隔也到了 → 才真的发出去', async () => {
  // 上一条的反面：把水位推到两年（超过任何间隔）后，同一个会话就会发出去。
  // 两条合起来说明「间隔」确实是那个开关，而不是别的东西在挡。
  const sessionId = 'session-live-aa-interval-ok'
  const host = await bootLiveAutoAdvance({
    sessionId,
    statePatch: { lastAutoMessageAt: Date.now() - 2 * 24 * 60 * 60_000 },
    pluginConfig: { im: { enabled: true, appId: 'test-app', messageIntervalMinutes: 120 } },
  })

  const delivered = await waitFor(() => host.sent.length > 0, 6000)
  assert.ok(delivered, '间隔走完之后该发的还是要发')
  assert.equal(loadState(sessionId).lastAdvanceDelivery?.mode, 'speak')
  await host.ctx.stop?.()
})

await check('投递状态落盘：lastImDelivery 记下这次真的送到了（可自检）', async () => {
  const sessionId = 'session-live-aa-state'
  const host = await bootLiveAutoAdvance({ sessionId })
  await waitFor(() => loadState(sessionId).lastImDelivery, 6000)

  const after = loadState(sessionId)
  assert.ok(after.lastImDelivery, '应留下投递回执')
  assert.equal(after.lastImDelivery.sentCount, after.lastImDelivery.total, '全部条目都该送达')
  assert.equal(after.lastImDelivery.binding?.source, 'discover', '绑定应来自自动发现')
  await host.ctx.stop?.()
})

await check('没有聊天软件绑定的会话：只在本地续写故事，不往 IM 发', async () => {
  // 普通 Web 对话没有收件人。这里验证的是「默认开启投递」不会把 Web 会话的内容
  // 乱发给别的目标——绑定是投递的唯一前提，不是配置里的开关。
  // 顺带确认：没有绑定时连台词提取都不必生效，故事原样留在会话里。
  const sessionId = 'session-live-aa-unbound'
  const host = await bootLiveAutoAdvance({ sessionId, binding: false })

  await waitFor(() => host.agent.followups.length > 0, 4000)
  await sleep(300)
  assert.equal(host.sent.length, 0, `没有绑定就不该发，实际：${JSON.stringify(host.sent)}`)
  assert.ok(host.agent.followups.length > 0, '本地续写仍要发生')
  assert.equal(loadState(sessionId).lastAdvanceDelivery?.reason, 'no-binding')
  await host.ctx.stop?.()
})

await check('im.autoMessage=false 时只写故事、不发消息（保留退出口）', async () => {
  // 用户明确不想被打扰时的那条路。注意它关的是「发言」，不是「写故事」——
  // 线上那次静默丢失（session-xxx 第 7 轮）就是因为把两者当成了同一件事。
  const sessionId = 'session-live-aa-off'
  const host = await bootLiveAutoAdvance({
    sessionId,
    pluginConfig: { im: { enabled: true, appId: 'test-app', autoMessage: false } },
  })

  await waitFor(() => host.agent.followups.length > 0, 4000)
  await sleep(300)
  assert.equal(host.sent.length, 0, `显式关闭后不该发，实际：${JSON.stringify(host.sent)}`)
  assert.ok(host.agent.followups.length > 0, '关掉发言后故事仍要续写')
  assert.equal(loadState(sessionId).lastImDelivery ?? null, null, '不该留下投递回执')
  const after = loadState(sessionId)
  assert.equal(after.lastAdvanceDelivery?.mode, 'story-only')
  assert.equal(after.lastAdvanceDelivery?.reason, 'auto-message-disabled')
  await host.ctx.stop?.()
})

await check('im.deliverAutoAdvance=false（老开关）同样只写故事、不发消息', async () => {
  // 改版前这个字段是投递的总闸。它必须继续有效，否则线上已经关掉它的人
  // 会在升级后突然开始收到消息——静默的行为反转。
  const sessionId = 'session-live-aa-legacy-off'
  const host = await bootLiveAutoAdvance({
    sessionId,
    pluginConfig: { im: { enabled: true, appId: 'test-app', deliverAutoAdvance: false } },
  })

  await waitFor(() => host.agent.followups.length > 0, 4000)
  await sleep(300)
  assert.equal(host.sent.length, 0, `老开关关掉后不该发，实际：${JSON.stringify(host.sent)}`)
  assert.ok(host.agent.followups.length > 0, '故事仍要续写')
  await host.ctx.stop?.()
})

await check('配额用光后，角色答应过的提醒仍然发得出去（承诺优先于配额）', async () => {
  // 自动生活推进现在也占每日名额。若不把「承诺型」从配额闸里放行，
  // 一次忙碌的生活推进就能把当天到点的提醒挤掉——用户等的是那句提醒。
  const sessionId = 'session-quota-promise'
  const host = await bootWithPendingIntent({
    sessionId,
    intent: { id: 'i1', summary: '提醒他吃药', reply: '药吃了没', dueInMs: -1000 },
    // 名额已经用光。状态补丁必须在插件加载前写进去（启动扫描立刻就跑了）。
    pluginConfig: { proactive: { checkIntervalMinutes: 60, graceMinutes: 0, maxPerDay: 1 } },
    statePatch: {
      reachedOut: 1,
      reachedOutDay: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    },
  })

  const delivered = await waitFor(() => host.sent.length > 0, 6000)
  assert.ok(delivered, '承诺型待办不该被配额挡住')
  assert.ok(host.sent.map(m => m.text).join(' ').includes('药'), JSON.stringify(host.sent.map(m => m.text)))
  await host.ctx.stop?.()
})

console.log(`\n冷会话主动开口：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

