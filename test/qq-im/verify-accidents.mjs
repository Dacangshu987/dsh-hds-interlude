/**
 * 对三次真实事故形态的**端到端**回归验证（合并后版本）。
 *
 * 前面各测试都在测模块。这个脚本走**合并后插件的完整链路**：
 * 会话事件 → hds-interlude 的 turn/end 消费者 → 发言判定 → 投递裁定，
 * 用三种真实事故的原始形态各跑一遍，确认 QQ 侧一个字都收不到（strict）。
 *
 * 与合并前的版本相比，这里驱动的是 hds-interlude 真实的事件消费路径
 * （`ctx.on('session/event')`），而不是那个独立插件的入口——
 * 因为合并之后，那条路径就是生产路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../../.tmp-dsh-home-accidents', import.meta.url))
process.env.DSH_HOME = TEST_HOME

const plugin = await import('../../lib/index.js')

fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const mode = process.argv[2] === 'loose' ? 'loose' : 'strict'

/* ------------------------------------------------------------------ 夹具 */

const SESSION = 'session-accidents'
const CONVERSATION = 'c2c:ACC'

function writeBinding() {
  const dir = path.join(TEST_HOME, 'integrations', 'dsh-qq-im')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'bindings.json'), JSON.stringify({
    version: 1,
    bindings: { [CONVERSATION]: { sessionId: SESSION, botId: 'qq', name: '测试' } },
  }, null, 2), 'utf8')
}

/** 记录「实际发到 QQ 的字」。 */
const delivered = []
const live = new Map()

function makeCtx() {
  const ctx = new Context()
  ctx.provide('agents', { get: id => live.get(id), currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('webServer', { register: () => {} })
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('settings', {
    register: (ns, schema, options) => ({
      get: () => schema(options?.base ?? {}),
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }),
  })
  // 投递出口：分条与记账走真实代码，只有最后那一跳被替换。
  ctx.__qqImTransport = async (targetId, text) => {
    delivered.push({ targetId, text })
    return { sent: true }
  }
  return ctx
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ------------------------------------------------------------------ 运行 */

writeBinding()
const ctx = makeCtx()

/**
 * `requireInbound: false` —— 本文件测的是**发言判定**，不是入站闸。
 *
 * 默认 `requireInbound: true` 要求该会话先从 QQ 说过话才回投（防止把 DSH
 * 界面里的私聊发到聊天软件）。这里没有 QQ 连接、也就没有入站消息，
 * 开着那道闸会让所有投递都被正确地拦下——那样测出来的「零投递」
 * 是闸挡的，不是 say.js 判的，结论就没有意义了。
 *
 * 所以这里显式关掉入站闸，让结论只反映「思考有没有进入投递链路」。
 */
const config = plugin.Config({
  timeZone: 'Asia/Shanghai',
  im: {
    enabled: true,
    appId: 'test-app',
    sayFallback: mode,
    interactive: { enabled: true, requireInbound: false },
  },
})
const fiber = ctx.plugin(plugin, config)
if (fiber && typeof fiber.then === 'function') await fiber
await sleep(40)

/** 一个实时角色会话（这样 turn/end 的消费者才会认它）。 */
const session = { id: SESSION, header: { id: SESSION, agentPreset: 'preset-accidents' }, seq: 0, eventAt: () => undefined }
const agent = { id: SESSION, session, inject() {}, followup() {} }
live.set(SESSION, agent)

/**
 * 跑一轮：把事件喂给真实的 session/event 监听器。
 *
 * 注意事件走 `ctx.emit('session/event', …)`——这正是宿主的分发路径，
 * 所以测的是真实消费者，而不是我们重写的一份模拟。
 */
async function runTurn(events) {
  delivered.length = 0
  for (const event of events) ctx.emit('session/event', session, event)
  await sleep(60)
  return delivered.map(item => item.text)
}

const assistant = text => ({
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
})
const toolCall = text => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: 'c1', name: 'interlude_say', arguments: JSON.stringify({ text }) },
})
const turnEnd = () => ({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

let failures = 0
function expect(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else { failures += 1; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`) }
}

console.log(`模式：${mode}\n`)

/* ---- 事故 ①：模型把思考写成正文 ---- */
console.log('事故 ①（09-14 01:07）模型把思考写成正文：')
{
  const sent = await runTurn([
    assistant('用户问我吃饭没有。我应该回一句关心的话，但不要太刻意。让我想想怎么写得自然一点，她今天心情好像不太好。'),
    turnEnd(),
  ])
  if (mode === 'strict') {
    expect('QQ 侧零投递', sent.length === 0, `实际发出：${JSON.stringify(sent)}`)
  } else {
    /**
     * 合并之后的 loose 语义与独立插件时期**不同**，这里如实记录：
     *
     * 独立插件里，`sayFallback: 'loose'` 让「主动唤起」路径从正文猜台词，
     * 于是三种事故形态都会复现泄漏。
     *
     * 合并进 hds-interlude 之后，**交互式回复这条路径根本不看正文**——
     * 它只消费 `interlude_say`（见 index.js 的 deliverInteractiveSpeech）。
     * 所以这里仍是零投递，与 strict 一致。
     *
     * 换句话说：loose 的泄漏风险现在只存在于 hds-interlude 原有的
     * 「主动唤起/故事续写」路径（那条路径有它自己的 decideAdvanceDelivery），
     * 而本文件驱动的是交互式路径，天然不受影响。
     */
    expect('合并后交互式路径不受 loose 影响（它只认 interlude_say）', sent.length === 0,
      `实际发出：${JSON.stringify(sent)}`)
    console.log('      ⚠ loose 的泄漏风险在「主动唤起」路径上，那条路径由 story.js 的判据把关')
  }
}

/* ---- 事故 ②：思考里用引号列候选台词 ---- */
console.log('\n事故 ②（09-15 23:00）思考里用引号列候选台词：')
{
  const sent = await runTurn([
    assistant('她这句话可能是在撒娇。候选回复：\n"吃了吗"\n"记得吃饭"\n选哪个更自然呢……'),
    turnEnd(),
  ])
  if (mode === 'strict') {
    expect('QQ 侧零投递（候选没被当成台词）', sent.length === 0, `实际发出：${JSON.stringify(sent)}`)
  } else {
    expect('合并后交互式路径不受 loose 影响（候选台词依然不发）', sent.length === 0,
      `实际发出 ${JSON.stringify(sent)}`)
    console.log('      ⚠ 但若走「主动唤起」路径，loose 会把这两行候选当成真台词（见 story.js 的 extractSpeech）')
  }
}

/* ---- 事故 ③：同一形态经镜像通道（本插件没有镜像） ---- */
console.log('\n事故 ③（09-15 23:13）同名形态：')
{
  const sent = await runTurn([
    assistant('内心戏：她大概是想我了。我不能直接说出来。'),
    turnEnd(),
  ])
  if (mode === 'strict') {
    expect('QQ 侧零投递（本插件没有镜像通道）', sent.length === 0, `实际发出：${JSON.stringify(sent)}`)
  } else {
    expect('合并后交互式路径不受 loose 影响', sent.length === 0, `实际发出 ${JSON.stringify(sent)}`)
  }
}

/* ---- 正向：真说了话就必须发出 ---- */
console.log('\n正向对照：模型调了 interlude_say：')
{
  const sent = await runTurn([
    assistant('（她低头看着手机）\n想了想还是别写太长了。'),
    toolCall('刚吃完\n你呢'),
    turnEnd(),
  ])
  expect('工具里的内容被投递', sent.length > 0, `实际发出：${JSON.stringify(sent)}`)
  expect('正文的旁白没有被带出去', !sent.join('').includes('低头'), `实际发出：${JSON.stringify(sent)}`)
}

/* ---- 事故 ② 的近亲：旁白塞进工具参数 ---- */
console.log('\n加强：模型把旁白塞进 interlude_say 的参数里：')
{
  const sent = await runTurn([
    toolCall('（她犹豫了一下）\n在吗'),
    turnEnd(),
  ])
  expect('旁白行被清洗掉，只发台词', sent.length > 0 && !sent.join('').includes('犹豫'),
    `实际发出：${JSON.stringify(sent)}`)
}

await ctx.stop?.()
try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log()
if (failures > 0) {
  console.error(`事故回归验证失败：${failures} 项不符合预期。`)
  process.exit(1)
}
console.log('三次事故形态在 QQ 侧全部零投递；工具调用路径正常。')
