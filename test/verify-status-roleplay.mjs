/**
 * 要求1 的专项核验：「实时角色会话」只统计**真正在用幕间层**的会话。
 *
 * 隔离的 DSH_HOME + 伪造的 agents：
 *   - session-rp  有实时 agent、走角色预设      → 计入 live
 *   - session-rm  有实时 agent、被 /interlude on → 计入 live
 *   - session-plain 有实时 agent、普通会话      → 不计入
 *   - 只有磁盘状态、没有实时 agent             → 不计入（冷会话不再统计）
 *
 * 不碰真实的 ~/.dsh。用法: node test/verify-status-roleplay.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-status-role-'))
process.env.DSH_HOME = tmp
const dir = path.join(tmp, 'hds-interlude')
fs.mkdirSync(dir, { recursive: true })

// 造一个「真实存在」的角色预设目录：isRoleplayPresetId 靠 preset.yml 判断。
const presetDir = path.join(tmp, '.agent-presets', 'preset-hds-role')
fs.mkdirSync(presetDir, { recursive: true })
fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: "测试角色"\n', 'utf8')

const now = Date.now()

function writeState(key, extra = {}) {
  const state = {
    version: 1, sessionId: key,
    lastSeenSeq: 0, turns: 0,
    lastUserAt: null, previousUserAt: null, lastAssistantAt: null, lastInjectedAt: null,
    story: null, continuity: '', continuityUpdatedAt: null,
    facts: [], overlay: [], intents: [], seq: 0,
    agencyWindow: null, proactiveDrafts: [], proactiveFingerprints: [],
    roleplay: false, canonInjected: false,
    reachedOut: 0, reachedOutDay: '', lastAutoAdvanceAt: null,
    alter: { alterValue: 0, alterWeight: 0, lastTriggerDirection: 0, emotionalOffset: null },
    preplan: null,
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(state), 'utf8')
}

// 带角色预设的实时会话
writeState('session-rp', { lastAssistantAt: now - 10 * 60000 })
// 被 /interlude on 标记的实时会话
writeState('session-rm', { roleplay: true, lastAssistantAt: now - 10 * 60000 })
// 普通实时会话（没有角色预设、没有 roleplay 标记、没有幕间痕迹）
writeState('session-plain', {})
// 只有磁盘状态、没有实时 agent 的会话（过去有幕间痕迹）—— 不该计入 live
writeState('session-coldish', { canonInjected: true, lastUserAt: now - 60 * 60000 })

// 伪造实时 agent。session 形状对齐 sessionKeyOf：session.header.agentPreset / session.id。
function fakeAgent(id, presetId) {
  return { session: { id, header: presetId ? { agentPreset: presetId } : {} } }
}

const live = {
  'session-rp': fakeAgent('session-rp', 'preset-hds-role'),
  'session-rm': fakeAgent('session-rm', null),
  'session-plain': fakeAgent('session-plain', 'standard'),
  // session-coldish 没有 agent
}

const { Context } = await import('@deepseek-ai/cordis')
let handler = null
const ctx = new Context()
ctx.provide('agents', { get: (id) => live[id], currentInitiator: () => undefined })
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

console.log('sessions:', JSON.stringify(v.sessions))
console.log('advance.sessions 条数:', v.advance.sessions.length)
for (const row of v.advance.sessions) console.log('  advance:', row.sessionId)

const checks = [
  // 只有 rp（角色预设）+ rm（/interlude on）算「真正在用幕间层」。
  ['live = 2（角色预设 + /interlude on）', v.sessions.live === 2],
  ['liveTotal = 3（三个实时 agent，含普通会话）', v.sessions.liveTotal === 3],
  ['live < liveTotal（普通会话没被算进来）', v.sessions.live < v.sessions.liveTotal],
  ['没有 cold 字段', !('cold' in v.sessions)],
  ['没有 stored 字段', !('stored' in v.sessions)],
  // 自动推进只对实时角色会话计算，所以是 rp + rm 两条。
  ['advance.sessions 只含两个角色会话', v.advance.sessions.length === 2],
  ['advance 不含普通会话', !v.advance.sessions.some((r) => r.sessionId === 'session-plain')],
  ['advance 不含冷会话', !v.advance.sessions.some((r) => r.sessionId === 'session-coldish')],
]

console.log('')
let bad = 0
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`)
  if (!pass) bad += 1
}

fs.rmSync(tmp, { recursive: true, force: true })
await ctx.stop?.()
console.log(bad === 0 ? '\n全部断言通过。' : `\n${bad} 项断言失败。`)
process.exit(bad === 0 ? 0 : 1)
