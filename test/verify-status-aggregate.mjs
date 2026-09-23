/**
 * 用隔离的 DSH_HOME 造几分带 pending/failed 待办的真实状态文件，
 * 核验「运行状态」的 pending / dueNow / upcoming 排序 / failed 聚合口径。
 *
 * 不碰真实的 ~/.dsh：全部写进临时目录。
 * 用法: node test/verify-status-aggregate.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-status-agg-'))
process.env.DSH_HOME = tmp
const dir = path.join(tmp, 'hds-interlude')
fs.mkdirSync(dir, { recursive: true })

const now = Date.now()

/** 造一份符合 STATE_VERSION 的状态文件。 */
function writeState(key, intents, extra = {}) {
  const state = {
    version: 1,
    sessionId: key,
    lastSeenSeq: 0, turns: 0,
    lastUserAt: null, previousUserAt: null, lastAssistantAt: null, lastInjectedAt: null,
    story: null, continuity: '', continuityUpdatedAt: null,
    facts: [], overlay: [], intents, seq: 100,
    agencyWindow: null, proactiveDrafts: [], proactiveFingerprints: [],
    roleplay: true, canonInjected: false,
    reachedOut: 0, reachedOutDay: '', lastAutoAdvanceAt: null,
    alter: { alterValue: 0, alterWeight: 0, lastTriggerDirection: 0, emotionalOffset: null },
    preplan: null,
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(state), 'utf8')
}

// 会话 A：2 条未来待办（其中一条更近）+ 1 条已到点
writeState('session-aaa', [
  { id: 'i1', kind: 'reminder', summary: '提醒喝水', dueAt: now + 30 * 60000, createdAt: now, status: 'pending' },
  { id: 'i2', kind: 'promise', summary: '承诺回访', dueAt: now + 5 * 60000, createdAt: now, status: 'pending' },
  { id: 'i3', kind: 'reply', summary: '已到点的延迟回复', dueAt: now - 60000, createdAt: now, status: 'pending' },
  { id: 'i4', kind: 'contact', summary: '已完成的', dueAt: now - 999, createdAt: now, status: 'delivered' },
])

// 会话 B：1 条失败 + 1 条未来，并且今日已主动联系 3 次
const todayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(now))

writeState('session-bbb', [
  { id: 'i1', kind: 'followup', summary: '失败的投递', dueAt: now - 5000, createdAt: now, status: 'failed', failure: 'timeout' },
  { id: 'i2', kind: 'contact', summary: '很久以后', dueAt: now + 3 * 3600000, createdAt: now, status: 'pending' },
], { reachedOut: 3, reachedOutDay: todayKey })

// 会话 C：今日已联系，但那是「昨天」记的（不该被计入今天）
writeState('session-ccc', [], { reachedOut: 5, reachedOutDay: '2000-01-01' })

const { Context } = await import('@deepseek-ai/cordis')
let handler = null
const ctx = new Context()
ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
ctx.provide('systemPrompt', { section: () => () => {} })
ctx.provide('tools', { register: () => () => {} })
ctx.provide('commands', { register: () => () => {} })
ctx.provide('settings', {
  register(ns, schema, options) {
    const get = () => schema(options?.base ?? {})
    return { get, watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})
ctx.provide('webServer', {
  register(r) { if (r.path === '/api/hds-interlude/status') handler = r.handler },
})

const mod = await import('../lib/index.js')
const fiber = ctx.plugin(mod.default ?? mod, {})
if (fiber && typeof fiber.then === 'function') await fiber
await new Promise((r) => setTimeout(r, 300))

const res = { status: null, body: null, writeHead(c) { this.status = c }, end(t) { this.body = t } }
await handler({ method: 'GET' }, res)
const v = JSON.parse(res.body).value

console.log(JSON.stringify(v, null, 2))

const up = v.intents.upcoming
const checks = [
  ['pending = 4（A 的 i1/i2/i3 + B 的 i2）', v.intents.pending === 4],
  ['dueNow = 1（只有 A 的 i3 已到点）', v.intents.dueNow === 1],
  ['failed = 1', v.intents.failed === 1],
  ['reachedOutToday = 3（昨天的 5 次不计）', v.proactive.reachedOutToday === 3],
  ['upcoming 至多 8 条', up.length <= 8],
  ['upcoming 全部是未来时间', up.every((u) => u.dueAt > now)],
  ['upcoming 升序', up.every((u, i) => i === 0 || u.dueAt >= up[i - 1].dueAt)],
  ['最近的未来待办是「承诺回访」', up[0]?.summary === '承诺回访'],
  ['已到点的不进 upcoming', !up.some((u) => u.dueAt <= now)],
  ['upcoming 带 sessionId', up.every((u) => typeof u.sessionId === 'string' && u.sessionId)],

  // 要求1：只统计真正在用幕间层的会话；不再有 cold。
  ['sessions 不再包含 cold 字段', !('cold' in v.sessions)],
  ['sessions 不再包含 stored 字段', !('stored' in v.sessions)],
  ['三个会话都是角色会话（roleplay/canonInjected），live 语义可用', typeof v.sessions.live === 'number'],

  // 要求3：下一次主动开口 + 幕间推进状态。
  ['有 proactive.next', v.proactive.next !== null && typeof v.proactive.next === 'object'],
  ['next 取最早的开口（A 的 i3 已到点，应为 overdue）', v.proactive.next?.overdue === true],
  ['next 带 pushToIm 布尔', typeof v.proactive.next?.pushToIm === 'boolean'],
  ['有 advance.sessions 数组', Array.isArray(v.advance?.sessions)],
  ['advance.enabled 是布尔', typeof v.advance?.enabled === 'boolean'],
  ['timing 带 jitter 字段', Number.isFinite(v.timing?.autoAdvanceJitterMinutes)],
]

console.log('')
let bad = 0
for (const [label, pass] of checks) {
  const good = pass === true
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${label}${pass !== true && pass !== false ? ` → ${pass}` : ''}`)
  if (!good) bad += 1
}

fs.rmSync(tmp, { recursive: true, force: true })
await ctx.stop?.()
console.log(bad === 0 ? '\n全部断言通过。' : `\n${bad} 项断言失败。`)
process.exit(bad === 0 ? 0 : 1)
