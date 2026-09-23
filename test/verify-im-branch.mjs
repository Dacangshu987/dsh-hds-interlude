/**
 * 用真实数据复核：修复后，那条「三分钟后提醒对方喝水」会走 IM 直投而不是被动分支。
 *
 * 关键差异（对照线上那次失败）：
 *   - 旧实现：resolveImService 用 ctx.dshIm → 跨作用域抛错 → service=undefined
 *             → 走被动分支 → attempts++、lastImDelivery 缺失（与线上痕迹一致）
 *   - 新实现：ctx.get('dshIm') → 拿到服务 → 走 IM 直投 → 写 lastImDelivery
 *
 * 这里复刻「dsh-im 在自己的子 ctx 上 provide」的注册方式，
 * 验证新实现的判定分支。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const HOME = fileURLToPath(new URL('../.tmp-verify-im-branch', import.meta.url))
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME

const SESSION = 'session-00000000-0000-4000-8000-000000000000'
const dir = path.join(HOME, 'integrations', 'dsh-qq')
fs.mkdirSync(path.join(dir, 'bots', 'qq_bot'), { recursive: true })
fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({
  deliveryTargets: { qq_bot: { jiangyou: { kind: 'user', route: { x: 1 }, sessionSync: { conversationKey: 'c2c:U' } } } },
}), 'utf8')
fs.writeFileSync(path.join(dir, 'bots', 'qq_bot', 'state.json'), JSON.stringify({ sessions: { 'c2c:U': SESSION } }), 'utf8')
const pd = path.join(HOME, '.agent-presets', 'preset-v')
fs.mkdirSync(pd, { recursive: true })
fs.writeFileSync(path.join(pd, 'preset.yml'), 'name: t\n')

const { saveState, emptyState, loadState } = await import('../lib/state.js')
const { clearImBindingCache } = await import('../lib/im-binding.js')
const { resolveImService } = await import('../lib/im.js')
const plugin = await import('../lib/index.js')

const sent = []
const live = new Map()
const root = new Context()
root.provide('agents', { get: id => live.get(id), currentInitiator: () => undefined })
root.provide('systemPrompt', { section: () => () => {} })
root.provide('tools', { register: () => () => {} })
root.provide('commands', { register: () => () => {} })
root.provide('settings', { register: (ns, s, o) => ({ get: () => s(o?.base ?? {}), watch: () => () => {}, update: async () => {}, replace: async () => {} }) })
root.provide('webServer', { register: () => {} })

// 模拟 dsh-im：在**自己的子 ctx** 上 provide（与真实包一致）
root.plugin({
  name: 'xmanrui-dsh-im',
  inject: [],
  apply(c) { c.provide('dshIm', { async send(botId, targetId, text) { sent.push({ botId, targetId, text }); return { sent: true } } }) },
})

const st = emptyState()
st.canonInjected = true
st.roleplay = true
st.lastUserAt = Date.now() - 200_000
st.intents = [{
  id: 'i1', kind: 'reminder', summary: '三分钟后提醒对方喝水',
  dueAt: Date.now() - 1000, createdAt: Date.now() - 240_000, status: 'pending',
}]
saveState(SESSION, st)
clearImBindingCache()

root.provide('sessionController', {
  async resolveAgent(id) {
    if (live.has(id)) return live.get(id)
    const agent = {
      id,
      session: { id, header: { id, agentPreset: 'preset-v' }, seq: 0, eventAt: () => undefined },
      followup() {
        setTimeout(() => {
          root.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '三分钟到了。' }, { type: 'text', text: '喝水。' }] } } })
          root.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
        }, 5)
      },
    }
    live.set(id, agent)
    root.emit('agent/session-start', { agent })
    return agent
  },
})

console.log('投递前先确认服务可见：', typeof resolveImService(root)?.send)

const fiber = root.plugin(plugin, plugin.Config({
  timeZone: 'Asia/Shanghai',
  proactive: { checkIntervalMinutes: 60, graceMinutes: 0 },
}))
if (fiber?.then) await fiber

const deadline = Date.now() + 7000
while (Date.now() < deadline && sent.length === 0) await new Promise(r => setTimeout(r, 50))
// 投递是多条的：等到待办真正结算，否则会在第一段发出时就断言，
// 那时状态还是 delivering、lastImDelivery 尚未写回。
while (Date.now() < deadline) {
  const s = (loadState(SESSION).intents ?? []).find(i => i.id === 'i1')
  if (s?.status === 'delivered' || s?.status === 'failed') break
  await new Promise(r => setTimeout(r, 50))
}

const after = loadState(SESSION)
console.log('\n=== 结果 ===')
console.log('发到 QQ 的消息:', JSON.stringify(sent.map(s => s.text)))
console.log('待办状态      :', (after.intents ?? []).map(i => `${i.id}=${i.status}`).join(' '))
console.log('lastImDelivery:', after.lastImDelivery ? `ok=${after.lastImDelivery.ok} ${after.lastImDelivery.sentCount}/${after.lastImDelivery.total} 来源=${after.lastImDelivery.binding?.source}` : '(缺失 = 走了被动分支)')

const ok = sent.length > 0 && after.lastImDelivery?.ok === true
console.log(`\n结论：${ok ? '✅ 走的是 IM 直投分支，消息能到 QQ（旧实现会退成被动分支）' : '❌ 仍在走被动分支'}`)
fs.rmSync(HOME, { recursive: true, force: true })
await root.stop?.()
process.exit(ok ? 0 : 1)

