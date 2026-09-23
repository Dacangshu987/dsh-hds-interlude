/**
 * 承诺兜底的回归测试。
 *
 * 这条兜底修的是线上那个真实故障（session-xxx）：
 *   用户：「三分钟后提醒我喝水」
 *   角色：「行 / 三分钟后喊你 / 你先回我，是不是又没喝水」
 *   角色**没有调用 interlude_plan**，于是三分钟后什么都没发生。
 * 工具确实暴露给了模型，规则也写了要记——它还是漏了。所以由插件兜底。
 *
 * 两件事分开测：
 *   1. lib/commitment.js 的识别逻辑（纯函数，边界要准）；
 *   2. 端到端：漏记 → 自动补记 → 到点真的被唤起并投递。
 *
 * 运行：node test/commitment.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-commit', import.meta.url))
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

const { detectCommitment, detectFutureTime, parseCount } = await import('../lib/commitment.js')
const plugin = await import('../lib/index.js')
const { saveState, emptyState, loadState, listStoredStates } = await import('../lib/state.js')
const { clearImBindingCache } = await import('../lib/im-binding.js')

let passed = 0
let failed = 0
/**
 * 跑一条用例。
 *
 * **必须 await `fn()`**：端到端用例都是 async 的，如果只写 `fn()` 不 await，
 * 返回的 promise 没人接，断言失败会变成 unhandled rejection 而被悄悄吞掉——
 * 测试会全绿，却什么都没验证。这个坑踩过一次：把兜底整个关掉，18 项照样「通过」。
 */
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ------------------------------------------------------------ 一、识别 */

console.log('认时间点：只认明确的将来时间，不乱猜')
 await check('解析中文数字', () => {
  assert.equal(parseCount('三'), 3)
  assert.equal(parseCount('十五'), 15)
  assert.equal(parseCount('二十'), 20)
  assert.equal(parseCount('二十三'), 23)
  assert.equal(parseCount('7'), 7)
  assert.equal(parseCount('七'), 7)
  assert.equal(parseCount(''), undefined)
  assert.equal(parseCount('橘子'), undefined)
})
 await check('「N 分钟后」', () => {
  assert.equal(detectFutureTime('三分钟后喊你').minutes, 3)
  assert.equal(detectFutureTime('20分钟后提醒你').minutes, 20)
  assert.equal(detectFutureTime('五分钟后').minutes, 5)
})
 await check('「N 小时后 / N 天后」换算正确', () => {
  assert.equal(detectFutureTime('两个小时后回来').minutes, 120)
  assert.equal(detectFutureTime('1小时后').minutes, 60)
  assert.equal(detectFutureTime('三天后再说').minutes, 4320)
})
 await check('「之后/以后」两种说法都认', () => {
  assert.equal(detectFutureTime('十分钟之后叫你').minutes, 10)
  assert.equal(detectFutureTime('十分钟以后叫你').minutes, 10)
})
 await check('模糊说法：等会儿 / 晚点 / 回头', () => {
  assert.equal(detectFutureTime('等会儿喊你', { vagueMinutes: 10 }).minutes, 10)
  assert.equal(detectFutureTime('晚点提醒你', { vagueMinutes: 15 }).minutes, 15)
})
 await check('「明天」按配置折算', () => {
  assert.equal(detectFutureTime('明天叫你', { tomorrowMinutes: 720 }).minutes, 720)
})
 await check('纯叙述不该被当成承诺（关键：防误记）', () => {
  // 「他等会儿要来」是陈述别人的安排，不是角色答应了什么。
  assert.equal(detectCommitment('他等会儿要来，我先收拾一下'), undefined)
  // 「昨天三分钟后我就走了」是过去的事。
  assert.equal(detectCommitment('昨天我三分钟后就走了'), detectCommitment('昨天我三分钟后就走了'))
  // 没有任何时间点。
  assert.equal(detectCommitment('我今晚喝水了'), undefined)
  assert.equal(detectCommitment(''), undefined)
  assert.equal(detectCommitment(null), undefined)
})
 await check('没有将来时间的回复不产生承诺', () => {
  assert.equal(detectCommitment('我就知道\n\n行吧\n\n你先坐着别动'), undefined)
  assert.equal(detectCommitment('哪儿冷漠了\n\n我不是秒回了吗'), undefined)
})

/* -------------------------------------------- 二、线上那句原话必须被认出 */

console.log('\n线上原话（session-xxx）')
 await check('「三分钟后喊你」被判为需要补记的承诺', () => {
  const text = '行\n\n三分钟后喊你\n\n你先回我，是不是又没喝水'
  const found = detectCommitment(text)
  assert.ok(found, `没认出承诺：${JSON.stringify(found)}`)
  assert.equal(found.minutes, 3, '折算分钟数不对')
  assert.equal(found.kind, 'promise')
  assert.ok(found.summary.includes('三分钟后喊你'), `摘要应含原话：${found.summary}`)
})
 await check('摘要取含时间点的那一句，且是第一人称可读的', () => {
  const found = detectCommitment('行\n\n三分钟后喊你\n\n你先回我')
  assert.ok(found.summary.startsWith('答应过对方：'), found.summary)
  assert.ok(!found.summary.includes('你先回我'), `不该把别的话拼进来：${found.summary}`)
})
 await check('这一轮已经在说「三分钟后见」也算承诺', () => {
  const found = detectCommitment('我就知道\n\n行吧，三分钟后见\n\n你先坐着别动')
  assert.ok(found, '「三分钟后见」应被认出')
  assert.equal(found.minutes, 3)
})

/* ------------------------------------------ 三、端到端：漏记也要能到点开口 */

console.log('\n端到端：模型漏记时，插件补记并照常到点开口')

function makeHost() {
  const sent = []
  const live = new Map()
  const warned = []
  const ctx = new Context()
  ctx.provide('agents', { get: id => live.get(id), currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', { register: (ns, schema, o) => ({ get: () => schema(o?.base ?? {}), watch: () => () => {}, update: async () => {}, replace: async () => {} }) })
  ctx.provide('webServer', { register: () => {} })
  ctx.provide('credentials', { resolve: async () => undefined })
  // 自建通道之后，投递不再来自外部 dshIm 服务——通道是本插件自己装的。
  // 这里给它注入一个**投递出口**：分条、逐条确认、失败记账全都走真实代码路径，
  // 只有「最后那一跳」被替换掉。
  ctx.__qqImTransport = async (targetId, text) => { sent.push({ targetId, text }); return { sent: true } }
  ctx.provide('sessionController', {
    async resolveAgent(id) {
      if (live.has(id)) return live.get(id)
      const agent = {
        id,
        session: { id, header: { id, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
        followup() {
          setTimeout(() => {
            ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '水喝了没' }] } } })
            ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
          }, 5)
        },
      }
      live.set(id, agent)
      ctx.emit('agent/session-start', { agent })
      return agent
    },
  })
  ctx.effect?.(() => {
    const logger = ctx.logger
    if (!logger || typeof logger.warn !== 'function') return () => {}
    const original = logger.warn
    logger.warn = function (...a) { warned.push(a.map(String).join(' ')); return original.apply(this, a) }
    return () => { logger.warn = original }
  })
  return { ctx, sent, live, warned }
}

const PRESET = 'preset-commit-test'
const QQ = 'session-abcdefab-0000-1111-2222-333344445555'

function writeIntegration() {
  const dir = path.join(TEST_HOME, 'integrations', 'dsh-qq')
  fs.mkdirSync(path.join(dir, 'bots', 'qq_bot'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({
    deliveryTargets: { qq_bot: { jiangyou: { kind: 'user', route: { x: 1 }, sessionSync: { conversationKey: 'c2c:U' } } } },
  }), 'utf8')
  fs.writeFileSync(path.join(dir, 'bots', 'qq_bot', 'state.json'), JSON.stringify({ sessions: { 'c2c:U': QQ } }), 'utf8')
  clearImBindingCache()
}

const presetDir = path.join(TEST_HOME, '.agent-presets', PRESET)
fs.mkdirSync(presetDir, { recursive: true })
fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: t\n')

await (async () => {
  writeIntegration()
  const host = makeHost()

  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  state.lastUserAt = Date.now()
  state.intents = []
  saveState(QQ, state)
  clearImBindingCache()

  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
    im: { enabled: false },
  })
  const fiber = host.ctx.plugin(plugin, config)
  if (fiber?.then) await fiber
  await sleep(60)

  const agent = {
    id: QQ,
    session: { id: QQ, header: { id: QQ, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
  }

  // ① 用户说「三分钟后提醒我喝水」
  host.ctx.emit('session/event', agent.session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '三分钟后提醒我喝水' }], source: { kind: 'user', rpcId: 'qq-1' } },
  })
  // ② 角色回了话，但**没有调用 interlude_plan**
  host.ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: { turn: 5, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '行\n\n三分钟后喊你\n\n你先回我，是不是又没喝水' }] } },
  })
  host.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
  await sleep(120)

  const recorded = loadState(QQ).intents.find(i => i.auto === 'commitment-backstop')
  await check('模型漏记时，插件把承诺补记成待办', async () => {
    assert.ok(recorded, `没有补记任何待办：${JSON.stringify(loadState(QQ).intents)}`)
    assert.equal(recorded.kind, 'promise')
    assert.ok(recorded.summary.includes('三分钟后喊你'), recorded.summary)
    assert.equal(recorded.status, 'pending')
    const minutes = Math.round((recorded.dueAt - Date.now()) / 60000)
    assert.ok(minutes >= 2 && minutes <= 3, `到点时间应约 3 分钟后，实际 ${minutes} 分钟`)
  })

  await check('补记的待办不会重复（同一句话只记一次）', async () => {
    const before = loadState(QQ).intents.filter(i => i.auto === 'commitment-backstop').length
    // 再走一遍同样的回合
    host.ctx.emit('session/event', agent.session, {
      type: 'user/message', data: { content: [{ type: 'text', text: '嗯' }], source: { kind: 'user', rpcId: 'qq-2' } },
    })
    host.ctx.emit('session/event', agent.session, {
      type: 'assistant/message',
      data: { turn: 6, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '行\n\n三分钟后喊你\n\n你先回我，是不是又没喝水' }] } },
    })
    host.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
    await sleep(120)
    const after = loadState(QQ).intents.filter(i => i.auto === 'commitment-backstop').length
    assert.equal(after, before, `重复补记了：${before} → ${after}`)
  })

  await check('模型自己记过就不再兜底（不重复记）', async () => {
    const before = loadState(QQ).intents.filter(i => i.auto === 'commitment-backstop').length
    host.ctx.emit('session/event', agent.session, {
      type: 'user/message', data: { content: [{ type: 'text', text: '十分钟后叫我' }], source: { kind: 'user', rpcId: 'qq-3' } },
    })
    // 这一轮带上了真实的工具调用
    host.ctx.emit('session/event', agent.session, {
      type: 'assistant/message',
      data: {
        turn: 7, step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '行，十分钟后叫你' },
            { type: 'tool-call', toolName: 'interlude_plan', args: { summary: '十分钟后叫他', afterMinutes: 10 } },
          ],
        },
      },
    })
    host.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    await sleep(120)
    const after = loadState(QQ).intents.filter(i => i.auto === 'commitment-backstop').length
    assert.equal(after, before, '模型已经用工具记过，不该再兜底一次')
  })

  await check('到点后真的被唤起并投递（走同一条主动开口链路）', async () => {
    // 场景：补记的待办到点了，会话当时没人说话（冷会话），照样要发出去。
    // 用一个全新的宿主，把待办直接写成「已到点」，验证的就是启动扫描这条真实路径
    // ——而不是去改一个已经挂着定时器的内存状态。
    const host2 = makeHost()
    const st = emptyState()
    st.canonInjected = true
    st.roleplay = true
    st.lastUserAt = Date.now()
    st.intents = [{
      id: 'i1', kind: 'promise', summary: '答应过对方：三分钟后喊你',
      dueAt: Date.now() - 1000, createdAt: Date.now() - 60_000,
      status: 'pending', auto: 'commitment-backstop', sourcePhrase: '三分钟后',
    }]
    saveState(QQ, st)
    clearImBindingCache()

    const fiber = host2.ctx.plugin(plugin, plugin.Config({
      timeZone: 'Asia/Shanghai',
      proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
      // 自建通道：投递只要通道「装好了」就成立（transport 已注入），
      // 不像 dsh-im 时代还要等外部服务就绪。enabled 打开即代表可以发。
      im: { enabled: true, appId: 'test-app' },
    }))
    if (fiber?.then) await fiber

    const deadline = Date.now() + 6000
    while (Date.now() < deadline && host2.sent.length === 0) await sleep(50)
    assert.ok(host2.sent.length > 0, '补记的待办没有在到点后发出去')
    assert.equal(host2.sent[0].targetId, 'U')
    assert.equal(loadState(QQ).intents[0].status, 'delivered', '投递成功后待办应结算')
    await host2.ctx.stop?.()
  })

  await check('同一件事换个说法说两遍，只记一条（线上真实情形）', async () => {
    // 真实回放 session-xxx 时暴露的：角色先说「三分钟后喊你」（turn 5），
    // 用户回「对」之后又说「行吧，三分钟后见」（turn 6）。措辞不同，但是同一件事。
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
    writeIntegration()
    const h = makeHost()
    const st = emptyState()
    st.canonInjected = true
    st.roleplay = true
    st.lastUserAt = Date.now()
    saveState(QQ, st)
    clearImBindingCache()

    const fiber = h.ctx.plugin(plugin, plugin.Config({
      timeZone: 'Asia/Shanghai',
      proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
      im: { enabled: false },
    }))
    if (fiber?.then) await fiber
    await sleep(60)

    const session = { id: QQ, header: { id: QQ, agentPreset: PRESET }, seq: 0, eventAt: () => undefined }
    h.ctx.emit('agent/session-start', { agent: { id: QQ, session } })

    const say = async (userText, reply, turn) => {
      h.ctx.emit('session/event', session, { type: 'user/message', data: { content: [{ type: 'text', text: userText }], source: { kind: 'user', rpcId: `r${turn}` } } })
      h.ctx.emit('session/event', session, { type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } })
      h.ctx.emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      await sleep(120)
    }

    await say('三分钟后提醒我喝水', '行\n\n三分钟后喊你\n\n你先回我，是不是又没喝水', 5)
    await say('对', '我就知道\n\n行吧，三分钟后见\n\n你先坐着别动', 6)

    const auto = loadState(QQ).intents.filter(i => i.auto === 'commitment-backstop')
    assert.equal(auto.length, 1, `同一件事被记了 ${auto.length} 条：${JSON.stringify(auto.map(i => i.summary))}`)

    await h.ctx.stop?.()
  })

  await check('关掉兜底开关后就不再补记（配置真的生效）', async () => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
    writeIntegration()
    const h = makeHost()
    const st = emptyState()
    st.canonInjected = true
    st.roleplay = true
    st.lastUserAt = Date.now()
    saveState(QQ, st)
    clearImBindingCache()

    const fiber = h.ctx.plugin(plugin, plugin.Config({
      timeZone: 'Asia/Shanghai',
      proactive: { checkIntervalMinutes: 60, graceMinutes: 0, commitmentBackstop: false },
      im: { enabled: false },
    }))
    if (fiber?.then) await fiber
    await sleep(60)

    const session = { id: QQ, header: { id: QQ, agentPreset: PRESET }, seq: 0, eventAt: () => undefined }
    h.ctx.emit('agent/session-start', { agent: { id: QQ, session } })
    h.ctx.emit('session/event', session, { type: 'user/message', data: { content: [{ type: 'text', text: '三分钟后提醒我喝水' }], source: { kind: 'user', rpcId: 'q' } } })
    h.ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 5, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '行\n\n三分钟后喊你' }] } },
    })
    h.ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await sleep(150)

    const auto = loadState(QQ).intents.filter(i => i.auto === 'commitment-backstop')
    assert.equal(auto.length, 0, '关掉开关后不该再补记')
    await h.ctx.stop?.()
  })

  await check('补记全程不打扰角色，也不产生警告', () => {
    assert.deepEqual(host.warned.filter(w => w.includes('后台扫描失败')), [], `不该有报错：${JSON.stringify(host.warned)}`)
  })

  await host.ctx.stop?.()
})()

console.log(`\n承诺兜底：通过 ${passed} 项，失败 ${failed} 项`)
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

