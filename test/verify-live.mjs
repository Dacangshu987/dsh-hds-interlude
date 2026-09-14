/**
 * 对真实 ~/.dsh 做只读核验：
 *  1. 自动发现能不能认出 QQ/微信 两个真实会话的投递目标；
 *  2. 那两个会话的幕间状态里，待办是否还挂着（修复后应当被认领）；
 *  3. 冷会话判定是否成立。
 * 绝不写任何文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { listDiscoveredBindings, discoverImBinding, clearImBindingCache } from '../lib/im-binding.js'
import { loadState } from '../lib/state.js'

const QQ = 'session-6d44e762-a260-4e9b-8696-81cff42c9c6e'
const WX = 'session-0936ed94-b6eb-494f-8766-e4704f0236d7'

clearImBindingCache()
const all = listDiscoveredBindings({ ttlMs: 0 })
console.log('=== 自动发现的投递目标 ===')
for (const b of all) console.log(`  ${b.channel.padEnd(8)} ${b.botId} / ${b.targetId}  →  ${b.sessionId}`)

console.log('\n=== 线上会话 ===')
for (const [label, id] of [['QQ', QQ], ['微信', WX]]) {
  const found = discoverImBinding(id)
  const state = loadState(id)
  const pending = (state.intents ?? []).filter(i => i.status === 'pending')
  console.log(`\n[${label}] ${id}`)
  console.log(`  自动发现绑定 : ${found ? `${found.botId} / ${found.targetId}（${found.channel}）` : '（无）'}`)
  console.log(`  角色会话痕迹 : canonInjected=${state.canonInjected} roleplay=${state.roleplay} lastUserAt=${state.lastUserAt ? new Date(state.lastUserAt).toISOString() : '-'}`)
  console.log(`  待处理待办   : ${pending.length}`)
  for (const i of pending) {
    const late = Date.now() - i.dueAt
    console.log(`    - (${i.id}) ${i.kind} 「${i.summary}」到点 ${new Date(i.dueAt + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)}（${late > 0 ? `已过 ${Math.round(late / 60000)} 分钟` : '未到'}）`)
  }
  console.log(`  今日已主动   : ${state.reachedOut ?? 0} / 6`)
}

console.log('\n=== 状态文件是否已带 sessionId 章（冷会话可反查）===')
const dir = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh'), 'hds-interlude')
let stamped = 0
let total = 0
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue
  total += 1
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  if (typeof parsed.sessionId === 'string' && parsed.sessionId) stamped += 1
}
console.log(`  ${stamped} / ${total} 份带章（其余是本次改动之前写下的旧文件；下次任何一次落盘都会补上）`)
