/**
 * 用**真实会话日志**回放那个失败案例，证明兜底确实接住了。
 *
 * 拿 session-xxx 的真实事件（用户说「三分钟后提醒我喝水」→ 角色回
 * 「行 / 三分钟后喊你 / …」且没有工具调用），逐条喂给修复后的插件，
 * 看它有没有把这条承诺补记下来。
 *
 * 运行：node test/verify-commitment-replay.mjs <decompressed.jsonl>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const source = process.argv[2]
if (!source || !fs.existsSync(source)) {
  console.error('用法: node test/verify-commitment-replay.mjs <decompressed.jsonl>')
  process.exit(2)
}

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-replay-commit', import.meta.url))
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

const { saveState, emptyState, loadState } = await import('../lib/state.js')
const { clearImBindingCache } = await import('../lib/im-binding.js')
const plugin = await import('../lib/index.js')

const events = fs.readFileSync(source, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const header = events[0]
const sessionId = header.sessionId ?? header.session?.id ?? 'session-replay'
console.log('回放会话:', sessionId)
console.log('预设:', header.agentPreset ?? header.session?.agentPreset ?? '-')

// 预设目录：让插件认得这是角色会话。
const preset = header.agentPreset ?? header.session?.agentPreset ?? 'preset-unknown'
const presetDir = path.join(TEST_HOME, '.agent-presets', preset)
fs.mkdirSync(presetDir, { recursive: true })
fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: replay\n')

clearImBindingCache()
saveState(sessionId, emptyState())

const host = new Context()
const live = new Map()
host.provide('agents', { get: id => live.get(id), currentInitiator: () => undefined })
host.provide('systemPrompt', { section: () => () => {} })
host.provide('tools', { register: () => () => {} })
host.provide('commands', { register: () => () => {} })
host.provide('settings', { register: (ns, schema, o) => ({ get: () => schema(o?.base ?? {}), watch: () => () => {}, update: async () => {}, replace: async () => {} }) })
host.provide('webServer', { register: () => {} })
host.provide('dshIm', { async send() { return { sent: true } } })

const config = plugin.Config({ timeZone: 'Asia/Shanghai', proactive: { checkIntervalMinutes: 60, graceMinutes: 0 } })
const fiber = host.plugin(plugin, config)
if (fiber?.then) await fiber

// 会话对象：session/event 的第一个参数
const session = { id: sessionId, header: { id: sessionId, agentPreset: preset }, seq: 0, eventAt: () => undefined }
// 登记为角色会话
host.emit('agent/session-start', { agent: { id: sessionId, session } })
await new Promise(r => setTimeout(r, 40))

let fed = 0
for (const event of events) {
  if (!event.type) continue
  if (!['user/message', 'assistant/message', 'turn/end'].includes(event.type)) continue
  fed += 1
  host.emit('session/event', session, event)
}
console.log('喂入事件:', fed)
await new Promise(r => setTimeout(r, 300))

const state = loadState(sessionId)
console.log('\n=== 回放结果 ===')
console.log('待办数:', (state.intents ?? []).length)
for (const i of state.intents ?? []) {
  const mins = Math.round((i.dueAt - Date.now()) / 60000)
  console.log(`  ${i.id} kind=${i.kind} status=${i.status} auto=${i.auto ?? '-'} dueIn=${mins}分`)
  console.log(`     summary: ${i.summary}`)
  if (i.sourcePhrase) console.log(`     触发短语: 「${i.sourcePhrase}」`)
}

const caught = (state.intents ?? []).some(i => i.auto === 'commitment-backstop' && /喊你|三分钟/.test(i.summary))
console.log(`\n结论：${caught
  ? '✅ 兜底接住了线上漏记的那条承诺（「三分钟后喊你」）'
  : '❌ 仍未捕获该承诺'}`)

fs.rmSync(TEST_HOME, { recursive: true, force: true })
await host.stop?.()
process.exit(caught ? 0 : 1)

