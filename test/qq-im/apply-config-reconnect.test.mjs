/**
 * channel.js 的 applyConfigAndReconnect 测试 —— 扫码落地重连的核心。
 *
 * 线上 bug 链（用户看到「扫码后一直未启动、lastError 空」）：
 *   1. applyConfigAndReconnect 把 `{im:{...}}` 直接传给 applyConfig →
 *      resolveConfig 契约是扁平 im 块 → appId/secretRef 读到 undefined → appId 清空；
 *   2. 且用 needsRestart 决定是否启动：若 settingsScope.update 已把配置推进
 *      （watch 同步），applyConfig 判定「没变化」→ 不 start → 通道从未启动。
 *
 * 修复后：
 *   - applyConfigAndReconnect 解包 {im:{...}} 为扁平 im 再交给 applyConfig；
 *   - **无条件建连**：通道没在跑就 start（start 内部区分新建/restart）。
 *
 * 本测试验证这两条，不依赖真实 SDK（transport 注入 + resolveConfig 契约断言）。
 */
import assert from 'node:assert/strict'
import { caseDir } from '../helpers/tmp.mjs'
import path from 'node:path'
import fs from 'node:fs'

import { installQqIm } from '../../lib/qq-im/channel.js'
import { resolveConfig } from '../../lib/qq-im/config.js'

const TEST_HOME = caseDir('acr')
fs.mkdirSync(TEST_HOME, { recursive: true })
process.env.DSH_HOME = TEST_HOME

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

/** 建一个真实通道（transport 注入，SDK 不会真连网——但 appId 缺失时 start 会直接失败，
 *  我们主要测 applyConfigAndReconnect 的**解包**与**建连被调用**这两点）。 */
function makeCtx() {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: () => undefined,
  }
}
function makeChannel(appId) {
  const channel = installQqIm(makeCtx(), {
    config: { enabled: true, appId, secretRef: 'DSH_QQBOT_APP_SECRET' },
    log: () => {},
    transport: async () => ({ sent: true }),
  })
  return channel
}

await check('resolveConfig 契约：扁平 im 块；{im:{...}} 会丢字段（线上成因复现）', () => {
  // 未解包 → resolveConfig 读 source.appId → undefined → appId 清空。
  const wrapped = resolveConfig({ im: { appId: '1900000001', secretRef: 'S', enabled: true } })
  assert.equal(wrapped.appId, '', '传 {im:{...}} 给 resolveConfig 会丢 appId（bug 复现）')
  // 解包后 → 扁平 → 字段保留。
  const flat = resolveConfig({ appId: '1900000001', secretRef: 'S', enabled: true })
  assert.equal(flat.appId, '1900000001', '扁平 im 块 appId 保留')
  assert.equal(flat.secretRef, 'S')
})

await check('applyConfigAndReconnect 解包 {im:{...}}：appId 真正进入通道配置', async () => {
  const channel = makeChannel('')
  await channel.applyConfigAndReconnect({ im: { appId: '1900000001', secretRef: 'DSH_QQBOT_APP_SECRET', enabled: true, botId: 'qq' } })
  // applyConfigAndReconnect 内部 applyConfig(解包后的 im) → 通道 config 更新。
  assert.equal(channel.config.appId, '1900000001', '解包后 appId 应进入通道配置')
  assert.equal(channel.config.secretRef, 'DSH_QQBOT_APP_SECRET')
  assert.equal(channel.config.enabled, true)
})

await check('applyConfigAndReconnect 无条件建连：即使这是一次全新 applyConfig（needsRestart=true）也启动', async () => {
  // 用「有 appId」的通道：applyConfig 判定 appId 从空→有值 = needsRestart=true，
  // 此时必须 start（会因无真实 SDK 失败，但 start 被调用、lastError 被记录）。
  const channel = makeChannel('1900000001')
  const result = await channel.applyConfigAndReconnect({
    im: { appId: '1900000001', secretRef: 'DSH_QQBOT_APP_SECRET', enabled: true, botId: 'qq' },
  })
  assert.equal(result.configApplied, true)
  assert.equal(result.reconnectStarted, true, '配置变化时应触发重连')
  // start 尝试建立真连接（此处无 SDK）→ 会记录 lastError 而不是静默。
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(channel.stats.lastError, '启动被调用过（失败会留 lastError，而不是从未启动）')
})

await check('applyConfig 收到扁平 im 时 appId 保留（宿主 watch 回调契约定死）', async () => {
  // 宿主 settingsScope.watch 回调传的是 current().im —— 本来就是扁平。
  const channel = makeChannel('')
  const applied = channel.applyConfig({ appId: 'abc', secretRef: 'S', enabled: true })
  assert.equal(channel.config.appId, 'abc', '扁平 im 应保留')
  assert.equal(applied.needsRestart, true, 'appId 变化应提示需要重启')
})

await check('applyConfig 删除 bot：config.bots 更新、status 不再包含被删 bot（删除链路的服务端侧）', async () => {
  const channel = installQqIm(makeCtx(), {
    config: {
      enabled: true,
      bots: [
        { botId: 'qq_bot1', appId: '1900000001', secretRef: 'S1', alias: '一号' },
        { botId: 'qq_bot2', appId: '1900000002', secretRef: 'S2', alias: '二号' },
      ],
    },
    log: () => {},
    transport: async () => ({ sent: true }),
  })
  assert.equal(channel.status().bots.length, 2, '删除前两个 bot')

  // 面板删除 bot2 后保存 → watch 把新 im 交给 applyConfig（只含 bot1）。
  channel.applyConfig({
    enabled: true,
    bots: [
      { botId: 'qq_bot1', appId: '1900000001', secretRef: 'S1', alias: '一号' },
    ],
  })
  assert.equal(channel.config.bots.length, 1, 'config.bots 应只剩 1 个')
  assert.equal(channel.status().bots.length, 1, 'status 不应再包含被删 bot')
  assert.equal(channel.status().bots[0].botId, 'qq_bot1', '只剩 bot1')
  assert.equal(channel.config.botId, 'qq_bot1', '顶层兼容字段同步到剩余 bot')
  // 状态视图「连接中/已连接」只反映剩余 bot：不再有 bot2 的行。
  assert.ok(!JSON.stringify(channel.status().bots).includes('qq_bot2'), 'bot2 不应出现在状态里')
})

await check('applyConfig 清空全部 bot（bots: []）→ 通道不再有任何 bot', async () => {
  const channel = installQqIm(makeCtx(), {
    config: {
      enabled: true,
      bots: [{ botId: 'qq_bot1', appId: '1900000001', secretRef: 'S1' }],
    },
    log: () => {},
    transport: async () => ({ sent: true }),
  })
  channel.applyConfig({ enabled: true, bots: [] })
  assert.equal(channel.config.bots.length, 0, 'bots 应为空')
  assert.equal(channel.status().bots.length, 0, 'status 无 bot')
})

await check('applyConfig 删除 bot：同时清除该 bot 的绑定（重新扫码后开新会话）', async () => {
  const channel = installQqIm(makeCtx(), {
    config: {
      enabled: true,
      bots: [
        { botId: 'qq_bot1', appId: '1900000001', secretRef: 'S1' },
        { botId: 'qq_bot2', appId: '1900000002', secretRef: 'S2' },
      ],
    },
    log: () => {},
    transport: async () => ({ sent: true }),
  })
  // bot2 有一条绑定（删除前绑定的旧会话）。
  channel.bindings.set({ conversationKey: 'c2c:U1', sessionId: 'sess-old', botId: 'qq_bot2', name: '角色' })
  assert.equal(channel.bindings.list('qq_bot2').length, 1, '删除前 bot2 有绑定')

  // 删除 bot2 并保存 → applyConfig 应清掉 bot2 的绑定。
  channel.applyConfig({
    enabled: true,
    bots: [{ botId: 'qq_bot1', appId: '1900000001', secretRef: 'S1' }],
  })
  assert.equal(channel.bindings.list('qq_bot2').length, 0, '被删 bot 的绑定应被清除')
  assert.equal(channel.bindings.list().length, 0, '绑定表不应残留')
  // 重新扫回 bot2 后（绑定已清），消息会走自动新建 → 开新会话。
})

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`\napplyConfigAndReconnect：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)