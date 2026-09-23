/**
 * 端到端形态测试：改版后的各条路径在**真插件实例**上跑起来是什么样。
 *
 * 单测（story.test.mjs）验证的是判定规则本身；这一层验证「插件有没有按规则做」——
 * 真状态、真扫描、真捕获窗口、真投递服务替身、真 pre-step 注入。
 *
 * 覆盖三种会话形态（提示词分叉与投递判定的依据都是它）：
 *   1. 绑定了 QQ 的角色会话：说话 → 发；只有旁白 → 不发
 *   2. 未绑定的 Web 角色会话：永不发，且**不能被告知「可能发消息」**
 *   3. 首轮注入：故事写作规则与 IM 规则互斥，只能给一个
 *
 * 运行：node test/story-e2e.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../.tmp-smoke', import.meta.url))
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

const plugin = await import('../lib/index.js')
const { saveState, loadState, emptyState } = await import('../lib/state.js')
const { clearImBindingCache } = await import('../lib/im-binding.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PRESET = 'preset-smoke'
fs.mkdirSync(path.join(TEST_HOME, '.agent-presets', PRESET), { recursive: true })
fs.writeFileSync(path.join(TEST_HOME, '.agent-presets', PRESET, 'preset.yml'), 'name: smoke\n')

function bindIm(sessionId, channel = 'qq') {
  const dir = path.join(TEST_HOME, 'integrations', `dsh-${channel}`)
  fs.mkdirSync(path.join(dir, 'bots', 'qq_bot'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({
    deliveryTargets: { qq_bot: { jiangyou: { name: '江柚', sessionSync: { conversationKey: 'c2c:U' } } } },
  }), 'utf8')
  fs.writeFileSync(path.join(dir, 'bots', 'qq_bot', 'state.json'), JSON.stringify({
    sessions: { 'c2c:U': sessionId },
  }), 'utf8')
}

/**
 * 每个场景必须换一个独立的 DSH_HOME（或至少换掉集成目录），并且**清掉发现缓存**。
 *
 * 踩过的坑：缓存按 home 缓存 10 秒，而各场景共用同一个 home。上一个场景写的
 * dsh-qq 会在缓存里留下「session-smoke-speak → qq_bot/jiangyou」这条，
 * 于是「未绑定会话」的场景其实仍然被判定为有绑定——测试假绿/假红都由此而来。
 */
function resetFixtures() {
  fs.rmSync(path.join(TEST_HOME, 'hds-interlude'), { recursive: true, force: true })
  fs.rmSync(path.join(TEST_HOME, 'integrations'), { recursive: true, force: true })
  clearImBindingCache()
}

function makeHost() {
  const sent = []
  // 自建通道之后投递走本插件内置通道的出口（分条与记账仍是真实代码路径）。
  const dshIm = { async send(_bot, target, text) { sent.push({ target, text }); return { sent: true } } }
  const ctx = new Context()
  // agents 用可变引用登记一次即可：后面每个场景换的是它返回的那个 agent。
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
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.__qqImTransport = async (target, text) => dshIm.send('qq_bot', target, text)
  return {
    ctx, sent, dshIm,
    setAgent(agent) { currentAgent = agent },
  }
}

/** 造一个会写出指定文本的实时 agent，并在 attach 后把 pre-step 的注入截下来。 */
async function scenario({ sessionId, reply, binding, canonInjected = true }) {
  // 每个场景都从零开始：状态目录与集成目录一起清掉（见 resetFixtures 的说明）。
  resetFixtures()
  if (binding) bindIm(sessionId)

  const host = makeHost()
  const agent = {
    id: sessionId,
    session: { id: sessionId, header: { id: sessionId, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
    followup() {
      setTimeout(() => {
        host.ctx.emit('session/event', agent.session, {
          type: 'assistant/message',
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: reply }] } },
        })
        host.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      }, 5)
    },
  }
  host.setAgent(agent)
  host.ctx.provide('sessionController', { async resolveAgent(id) { return id === sessionId ? agent : undefined } })

  const state = emptyState()
  // canonInjected=false 时让插件自己走「首轮注入人设+规则+故事规则」那条路。
  state.canonInjected = canonInjected
  state.roleplay = true
  state.lastAssistantAt = Date.now() - 60 * 60_000
  saveState(sessionId, state)

  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    runtime: { restWindows: [], autoAdvanceIntervalMinutes: 5, autoAdvanceJitterMinutes: 0 },
    proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
    im: { enabled: true, appId: 'test-app', messageIntervalMinutes: 0 },
  })
  const fiber = host.ctx.plugin(plugin, config)
  if (fiber && typeof fiber.then === 'function') await fiber

  // 触发一次 pre-step，看这一回注入什么（幕间块里该有「本轮模式」那一行）。
  const decision = await host.ctx.waterfall?.('agent/pre-step',
    { agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }))
  const injected = decision
    ? decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n')
    : ''

  await sleep(1500)
  const after = loadState(sessionId)
  await host.ctx.stop?.()
  return { sent: host.sent, injected, after }
}

let ok = true
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok  ${label}`) }
  catch (e) { ok = false; console.log(`  FAIL ${label}\n       ${e?.message ?? e}`) }
}

console.log('端到端形态')

await check('绑定会话 + 续写里有台词 → 只发那句，旁白留在故事里', async () => {
  const r = await scenario({
    sessionId: 'session-smoke-speak',
    binding: true,
    reply: '（下班回来，把包往沙发上一扔，先去看了眼绿萝。）\n\n先浇了水。\n\n“在忙吗”',
  })
  const texts = r.sent.map(m => m.text)
  assert.ok(texts.some(t => t.includes('在忙吗')), JSON.stringify(texts))
  assert.equal(texts.some(t => /绿萝|沙发|浇水/.test(t)), false, `旁白漏出去了：${JSON.stringify(texts)}`)
  assert.equal(r.after.lastAdvanceDelivery?.mode, 'speak')
  assert.ok(r.after.lastAutoMessageAt > 0)
})

await check('绑定会话 + 续写里只有旁白 → 一条都不发', async () => {
  const r = await scenario({
    sessionId: 'session-smoke-silent',
    binding: true,
    reply: '（洗完澡把头发擦到半干，坐在床沿刷了会儿手机。）\n\n明天又要早起，先睡了。',
  })
  assert.equal(r.sent.length, 0, JSON.stringify(r.sent))
  assert.equal(r.after.lastAdvanceDelivery?.reason, 'no-speech')
  assert.equal(r.after.lastAutoMessageAt ?? null, null)
})

await check('未绑定会话 → 续写有台词也不发（没有收件人）', async () => {
  const r = await scenario({ sessionId: 'session-smoke-web', binding: false, reply: '“在忙吗”' })
  assert.equal(r.sent.length, 0, JSON.stringify(r.sent))
  assert.equal(r.after.lastAdvanceDelivery?.reason, 'no-binding')
})

await check('幕间块带上「本轮模式」，让模型知道这一轮发不发', async () => {
  const r = await scenario({ sessionId: 'session-smoke-mode', binding: false, reply: '（安静的一天。）' })
  assert.match(r.injected, /本轮模式/, `注入里应有模式行，实际：\n${r.injected}`)
  assert.match(r.injected, /只写故事/, '未绑定会话应是只写故事')
})

await check('绑定会话的幕间块给的是「可能发消息」', async () => {
  const r = await scenario({ sessionId: 'session-smoke-mode-speak', binding: true, reply: '“在忙吗”' })
  assert.match(r.injected, /本轮模式/, `注入里应有模式行，实际：\n${r.injected}`)
  assert.match(r.injected, /可能发消息/, '绑定会话才会说可能发消息')
})

await check('未绑定会话首轮注入的是「故事写作规则」，不是 IM 规则', async () => {
  // 首轮才注入人设+规则：所以这里必须让 canonInjected=false，否则插件会跳过那一步。
  const r = await scenario({
    sessionId: 'session-smoke-rules',
    binding: false,
    canonInjected: false,
    reply: '（安静的一天。）',
  })
  assert.match(r.injected, /故事续写不是在发消息/, '应给故事规则（要求写旁白）')
  assert.doesNotMatch(r.injected, /不要写旁白、动作、神态/, '不该同时给 IM 规则——两者口径互斥')
})

await check('未绑定会话不会被承诺「这一轮可能发消息」（提示词与实际行为必须一致）', async () => {
  // 回归：唤起前的预判（storyMessageGate）一度漏判了「有没有绑定」，
  // 于是未绑定的 Web 会话被告诉「这一轮可能发消息」。模型照着这个前提把该说的话
  // 写成引语行，而插件永远发不出去——用户什么都没收到，故事里却写着它已经问了。
  // 这类不一致不抛错、不写日志，只能靠用例钉住。
  const r = await scenario({ sessionId: 'session-smoke-unbound-mode', binding: false, reply: '“在忙吗”' })
  assert.doesNotMatch(r.injected, /可能发消息/, `未绑定会话不该被承诺可以发消息：\n${r.injected}`)
  assert.match(r.injected, /只写故事/, '它应该被告知这一轮只写故事')
  assert.equal(r.sent.length, 0, '而且确实一条都没发')
})

console.log(ok ? '\n✅ 端到端形态符合预期' : '\n❌ 有路径不对')
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
