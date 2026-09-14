/**
 * 用**真实的** ~/.dsh 数据（QQ 会话状态 + dsh-im 集成目录）跑一次完整链路，
 * 但把投递服务换成记录器——证明修复后那条「一分钟后提醒他喝水」真的会被发出去，
 * 同时不往 QQ 发任何东西。
 *
 * 这是不重启 DSH 能拿到的最强证据：真实状态、真实绑定发现、真实扫描与判定，
 * 只有最后一步的 send 被换成记录。
 *
 * 运行：node test/verify-live-replay.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const LIVE_HOME = 'C:/Users/31559/.dsh'
const REPLAY_HOME = fileURLToPath(new URL('../.tmp-dsh-home-replay', import.meta.url))

// 把真实数据复制进沙箱：只读真实文件，所有写入都落在沙箱里。
fs.rmSync(REPLAY_HOME, { recursive: true, force: true })
fs.mkdirSync(REPLAY_HOME, { recursive: true })
fs.cpSync(path.join(LIVE_HOME, 'integrations'), path.join(REPLAY_HOME, 'integrations'), { recursive: true })
fs.cpSync(path.join(LIVE_HOME, 'hds-interlude'), path.join(REPLAY_HOME, 'hds-interlude'), { recursive: true })
fs.cpSync(path.join(LIVE_HOME, '.agent-presets'), path.join(REPLAY_HOME, '.agent-presets'), { recursive: true })

// 把「一分钟后提醒他喝水」的到点时间挪到刚刚过去，模拟它会话结束后的真实处境。
const QQ = 'session-6d44e762-a260-4e9b-8696-81cff42c9c6e'
const qqFile = path.join(REPLAY_HOME, 'hds-interlude', `${QQ}.json`)
const qqState = JSON.parse(fs.readFileSync(qqFile, 'utf8'))
const reminder = qqState.intents.find(i => i.kind === 'reminder')
const originalDue = reminder.dueAt
reminder.dueAt = Date.now() - 90_000
// 只留这一条待办，避免其它历史待办干扰观察。
qqState.intents = [reminder]
fs.writeFileSync(qqFile, JSON.stringify(qqState), 'utf8')
console.log(`真实待办: 「${reminder.summary}」原到点 ${new Date(originalDue + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)}（本次改为 90 秒前）`)

process.env.DSH_HOME = REPLAY_HOME
const { loadState } = await import('../lib/state.js')
const { clearImBindingCache } = await import('../lib/im-binding.js')
const plugin = await import('../lib/index.js')
clearImBindingCache()

const sent = []
const followups = []
const ctx = new Context()
const live = new Map()
ctx.provide('agents', { get: id => live.get(id), currentInitiator: () => undefined })
ctx.provide('systemPrompt', { section: () => () => {} })
ctx.provide('tools', { register: () => () => {} })
ctx.provide('commands', { register: () => () => {} })
ctx.provide('settings', {
  register(ns, schema, options) {
    return { get: () => schema(options?.base ?? {}), watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})
ctx.provide('webServer', { register: () => {} })
ctx.provide('dshIm', {
  async send(botId, targetId, text) { sent.push({ botId, targetId, text }); return { sent: true } },
})
ctx.provide('sessionController', {
  async resolveAgent(id) {
    if (id !== QQ) throw new Error('本回放只唤醒 QQ 会话')
    if (live.has(id)) return live.get(id)
    const agent = {
      id,
      session: { id, header: { id, agentPreset: 'preset-hds-mtw3wjj3-fzeywv' }, seq: 82, eventAt: () => undefined },
      followup() {
        followups.push(id)
        setTimeout(() => {
          ctx.emit('session/event', agent.session, {
            type: 'assistant/message',
            data: { turn: 6, step: 1, message: { content: [{ type: 'text', text: '水喝了没\n就知道你没喝' }] } },
          })
          ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
        }, 5)
      },
    }
    live.set(id, agent)
    ctx.emit('agent/session-start', { agent })
    return agent
  },
})

const config = plugin.Config({ timeZone: 'Asia/Shanghai' })
const fiber = ctx.plugin(plugin, config)
if (fiber?.then) await fiber

// 等到待办真正结算为止——只看「发出了几条」会在第一段投递完成时就返回，
// 那时最后一段和状态写回都还没发生。
const deadline = Date.now() + 12_000
let settled = null
while (Date.now() < deadline) {
  settled = loadState(QQ).intents.find(i => i.id === reminder.id)
  if (settled?.status === 'delivered' || settled?.status === 'failed') break
  await new Promise(r => setTimeout(r, 50))
}

console.log(`\n唤起的回合数 : ${followups.length}`)
console.log(`实际发出的消息（共 ${sent.length} 条）:`)
for (const m of sent) console.log(`  → ${m.botId} / ${m.targetId}: ${JSON.stringify(m.text)}`)

const after = loadState(QQ)
console.log(`\n待办结算     : ${settled?.status}${settled?.deliveredAt ? ` @ ${new Date(settled.deliveredAt + 8 * 3600e3).toISOString().slice(11, 19)}` : ''}`)
console.log(`今日主动计数 : ${after.reachedOut}`)
console.log(`上次 IM 投递 : ${JSON.stringify(after.lastImDelivery?.binding ?? null)} ok=${after.lastImDelivery?.ok} ${after.lastImDelivery?.sentCount}/${after.lastImDelivery?.total}`)

const ok = sent.length >= 2 && settled?.status === 'delivered'
console.log(`\n结论：${ok ? '✅ 修复后这条提醒会真的发到 QQ（且按真人习惯分成多条）' : '❌ 仍未发出'}`)
fs.rmSync(REPLAY_HOME, { recursive: true, force: true })
await ctx.stop?.()
process.exit(ok ? 0 : 1)
