/**
 * 冷会话的自动生活推进（线上症状：角色一整天不主动发消息）。
 *
 * ## 事故
 *
 * 用户当天一条消息都没收到。排查发现：
 *   - 到期待办（intents）为空 → 没有东西会唤醒会话；
 *   - 自动推进原先写成 `if (live) await handleAutoAdvance(...)`——**冷会话永不推进**；
 *   - 于是「用户没在 DSH 里打开那个会话」+「没有待办」= 角色连开口的机会都没有。
 *
 * 修复：冷会话在 `proactive.wakeIdleSessions` 打开时可以被唤醒后推进，
 * 但先用 `shouldWakeForAdvance` 做廉价预判，避免每次扫描都白唤醒一整轮模型调用。
 *
 * 本测试验证：到点的冷会话会被唤醒并开始推进；未到点 / 关掉开关时不唤醒。
 *
 * 运行：node test/cold-advance-wake.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../.tmp-dsh-home-coldadvance', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../lib/index.js')

const PRESET_ID = 'preset-hds-coldadvance'
const SESSION = 'session-cold-advance-1'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 造一个有效角色预设（isRoleplayPresetId 只看文件存在）。 */
function makePreset(id) {
  const dir = path.join(TEST_HOME, '.agent-presets', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: "测试"\n', 'utf8')
}

/** 造一个 IM 绑定（冷会话只有「真的能发出去」才值得被唤醒）。 */
function makeBinding(sessionId, botId = 'qq_test') {
  const dir = path.join(TEST_HOME, 'integrations', 'dsh-qq-im')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'bindings.json'), JSON.stringify({
    version: 2,
    bindings: {
      [`${botId}\u0000c2c:USER1`]: {
        conversationKey: 'c2c:USER1',
        sessionId,
        botId,
        name: '测试',
        boundAt: new Date().toISOString(),
      },
    },
  }, null, 2), 'utf8')
}

function clearBinding() {
  const file = path.join(TEST_HOME, 'integrations', 'dsh-qq-im', 'bindings.json')
  fs.rmSync(file, { force: true })
}

/** 造一份冷会话状态（canonInjected 让 isRoleplayState 通过）。 */
function makeState(id, { lastAssistantAgoMs, lastAdvanceAgoMs }) {
  const dir = path.join(TEST_HOME, 'hds-interlude')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    version: 1,
    sessionId: id,
    canonInjected: true,
    canonInjectedIm: 'im',
    roleplay: false,
    turns: 5,
    lastUserAt: now - 6 * 3600_000,
    lastAssistantAt: now - lastAssistantAgoMs,
    lastAutoAdvanceAt: now - lastAdvanceAgoMs,
    intents: [],
    ledger: { entries: [], cursor: 0 },
  }, null, 2), 'utf8')
  return path.join(dir, `${id}.json`)
}

/**
 * 起插件实例。冷会话（ctx.agents.get 返回 undefined），
 * sessionController.resolveAgent 记录唤醒次数并返回一个带 header 的 agent。
 */
async function boot({ wakeIdleSessions = true, intervalMinutes = 60 } = {}) {
  const calls = { resolveAgent: [], followups: [] }
  const agent = {
    session: { id: SESSION, header: { id: SESSION, agentPreset: PRESET_ID, cwd: TEST_HOME } },
    followup(message) { calls.followups.push(message) },
  }
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, list: () => [], currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', { describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} })
  ctx.provide('configEditor', { entries: () => [], edit: async () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('agentPresets', { async register() { return async () => {} }, async resolve(id) { throw new Error(`Unknown agent preset: ${id}`) } })
  ctx.provide('sessionController', {
    async resolveAgent(id) { calls.resolveAgent.push(id); return agent },
  })

  const cfg = plugin.Config({
    timeZone: 'Asia/Shanghai',
    runtime: { autoAdvanceEnabled: true, autoAdvanceIntervalMinutes: intervalMinutes, autoAdvanceJitterMinutes: 0 },
    proactive: { enabled: true, wakeIdleSessions },
    im: {
      enabled: false,
      waitForTurnMs: 5000,
      // 必须声明这个 bot：applyConfig 会清理「配置里已消失的 bot」的绑定，
      // 不声明的话测试里造的绑定会被当成孤儿删掉。
      bots: [{ botId: 'qq_test', appId: '1', alias: '测试', agentPreset: PRESET_ID }],
    },
  })
  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  // 等启动扫描跑完 + 捕获窗口超时（waitForTurnMs=150）
  await sleep(700)
  return { ctx, calls }
}

makePreset(PRESET_ID)

await check('到点的冷会话会被唤醒并开始推进（修复前完全不会）', async () => {
  makeState(SESSION, { lastAssistantAgoMs: 3 * 3600_000, lastAdvanceAgoMs: 3 * 3600_000 })
  makeBinding(SESSION)
  const { calls } = await boot()
  assert.ok(calls.resolveAgent.includes(SESSION), `应唤醒冷会话，实际 resolveAgent=${JSON.stringify(calls.resolveAgent)}`)
  assert.equal(calls.followups.length, 1, '推进应唤起一个回合（followup 一次）')
  const state = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hds-interlude', `${SESSION}.json`), 'utf8'))
  assert.ok(Number.isFinite(state.lastAutoAdvanceAt) && Date.now() - state.lastAutoAdvanceAt < 60_000,
    'lastAutoAdvanceAt 应被推进（说明真的跑了这一轮）')
})

await check('未到点（刚写过）→ 不唤醒，省掉一整轮模型调用', async () => {
  makeState(SESSION, { lastAssistantAgoMs: 60_000, lastAdvanceAgoMs: 60_000 })
  makeBinding(SESSION)
  const { calls } = await boot()
  assert.equal(calls.resolveAgent.length, 0, '不该唤醒')
  assert.equal(calls.followups.length, 0, '不该唤起回合')
})

await check('wakeIdleSessions=false → 冷会话不唤醒（用户显式关掉）', async () => {
  makeState(SESSION, { lastAssistantAgoMs: 3 * 3600_000, lastAdvanceAgoMs: 3 * 3600_000 })
  makeBinding(SESSION)
  const { calls } = await boot({ wakeIdleSessions: false })
  assert.equal(calls.resolveAgent.length, 0, '关掉开关后不该唤醒')
  assert.equal(calls.followups.length, 0, '不该唤起回合')
})

await check('到点但没有 IM 绑定 → 不唤醒（唤醒了也发不出去）', async () => {
  makeState(SESSION, { lastAssistantAgoMs: 3 * 3600_000, lastAdvanceAgoMs: 3 * 3600_000 })
  clearBinding()
  const { calls } = await boot()
  assert.equal(calls.resolveAgent.length, 0, '无绑定的冷会话不该被唤醒')
  assert.equal(calls.followups.length, 0, '不该唤起回合')
})

console.log(`\n冷会话推进唤醒：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
