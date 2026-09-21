/**
 * 扫码成功后的「凭据落地」编排测试。
 *
 * 验证的核心（对应线上「扫码后一直连接中」的修复）：
 *   1. 写凭据服务（secretRef 名）；
 *   2. 更新配置；
 *   3. **用 applyConfigAndReconnect 同步推进配置并重连**——旧实现
 *      「stop → 等 50ms → start」有竞态：旧连接的 finally 会把新连接
 *      的 started/ready 清掉，表现就是「一直连接中」。
 *   4. 每步成败都进 report，供前端展示（用户问「是否正常写入」）。
 *   5. 各依赖缺失/失败时的降级。
 */
import assert from 'node:assert/strict'

import { applyScanCredentials } from '../../lib/qq-im/credential-apply.js'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

/**
 * 假通道：记录 applyConfigAndReconnect 收到的配置。
 */
function makeChannel() {
  const calls = { applyConfig: [], started: 0 }
  const channel = {
    applyConfigAndReconnect: async (next) => {
      calls.applyConfig.push(next)
      calls.started += 1
      return { configApplied: true, reconnectStarted: true }
    },
  }
  return { channel, calls }
}

function makeDeps(overrides = {}) {
  const calls = { credentials: [], updates: [], starts: 0 }
  const deps = {
    creds: { appId: '1900000001', appSecret: 'SECRET_X', userOpenid: 'OP' },
    im: { secretRef: 'DSH_QQBOT_APP_SECRET', botId: 'qq' },
    credentials: { set: async (ref, value) => { calls.credentials.push({ ref, value }) } },
    settingsScope: { update: async (patch) => { calls.updates.push(patch) } },
    log: () => {},
    ...overrides,
  }
  return { deps, calls }
}

console.log('扫码凭据落地编排')

await check('写凭据 + 更新配置 + 用 applyConfigAndReconnect 重连，顺序正确', async () => {
  const { deps, calls } = makeDeps()
  const { channel, calls: channelCalls } = makeChannel()
  const report = await applyScanCredentials({ ...deps, channel })

  // ① 凭据写入：引用名 = im.secretRef。
  assert.equal(calls.credentials.length, 1, '应写一次凭据')
  assert.equal(calls.credentials[0].value, 'SECRET_X')

  // ② 配置更新：im.enabled=true + appId + secretRef + botId。
  assert.equal(calls.updates.length, 1, '应更新一次配置')
  const patch = calls.updates[0].im
  assert.equal(patch.enabled, true)
  assert.equal(patch.appId, '1900000001')
  assert.equal(patch.secretRef, 'DSH_QQBOT_APP_SECRET')
  assert.equal(patch.botId, 'qq')

  // ③ 重连走 applyConfigAndReconnect（把 patch 同步推进通道）。
  assert.equal(channelCalls.applyConfig.length, 1, '应调用 applyConfigAndReconnect')
  assert.equal(channelCalls.started, 1, '应触发一次重连')

  // ④ report 三环全绿，供前端展示。
  assert.equal(report.credential.ok, true)
  assert.equal(report.config.ok, true)
  assert.equal(report.reconnect.ok, true)
  assert.equal(report.secretRef, 'DSH_QQBOT_APP_SECRET')
})

await check('channel 有 start 但无 applyConfigAndReconnect（旧实现兜底）：仍能重连', async () => {
  const { deps, calls } = makeDeps()
  const channel = { start: async () => { calls.starts += 1 } }
  const report = await applyScanCredentials({ ...deps, channel })
  assert.equal(report.reconnect.ok, true)
  assert.equal(calls.starts, 1)
})

await check('凭据服务缺失 → 降级：配置与重连仍执行，report 里写明', async () => {
  const { deps } = makeDeps({ credentials: undefined })
  const channel = makeChannel().channel
  const report = await applyScanCredentials({ ...deps, channel })
  assert.equal(report.credential.ok, false, '凭据一步应标记失败')
  assert.ok(String(report.credential.error).includes('凭据服务不可用'), '应说明原因')
  assert.equal(report.config.ok, true, '配置仍应更新')
  assert.equal(report.reconnect.ok, true, '重连仍应执行')
})

await check('配置更新失败 → report 标记，但凭据与重连仍执行', async () => {
  const { deps, calls } = makeDeps({
    settingsScope: { update: async () => { throw new Error('update boom') } },
  })
  const channel = makeChannel().channel
  const report = await applyScanCredentials({ ...deps, channel })
  assert.equal(report.config.ok, false)
  assert.ok(String(report.config.error).includes('update boom'))
  assert.equal(calls.credentials.length, 1, '凭据仍写')
  assert.equal(report.reconnect.ok, true, '重连仍执行')
})

await check('重连失败 → report 标记，不抛出', async () => {
  const { deps } = makeDeps()
  const channel = {
    applyConfigAndReconnect: async () => { throw new Error('appSecret 无效') },
  }
  const report = await applyScanCredentials({ ...deps, channel })
  assert.equal(report.reconnect.ok, false)
  assert.ok(String(report.reconnect.error).includes('appSecret 无效'))
})

await check('没有 AppSecret → 整步失败，report 标注 credential 错误', async () => {
  const { deps } = makeDeps()
  const report = await applyScanCredentials({ ...deps, creds: { appId: 'x', appSecret: '' } })
  assert.equal(report.credential.ok, false)
  assert.ok(String(report.credential.error).includes('没有拿到 AppSecret'))
})

await check('im 配置缺 secretRef → 用默认引用名', async () => {
  const { deps, calls } = makeDeps({ im: {} })
  const channel = makeChannel().channel
  const report = await applyScanCredentials({ ...deps, channel })
  assert.equal(report.secretRef, 'DSH_QQBOT_APP_SECRET')
  assert.equal(calls.updates[0].im.secretRef, 'DSH_QQBOT_APP_SECRET')
})

await check('扫码落地不应再用裸 stop（会踩竞态）', async () => {
  // 旧实现：stop() → 等 50ms → start()。旧连接的 finally 会把新连接的
  // started/ready 清掉 → 一直「连接中」。
  // 新实现：applyConfigAndReconnect 内部用 channel.restart()，先等旧 run
  // 退出再起新 run。这里验证调用的是 applyConfigAndReconnect 而不是裸 stop。
  const { deps } = makeDeps()
  let usedStopped = false
  const channel = {
    applyConfigAndReconnect: async () => ({ configApplied: true, reconnectStarted: true }),
    stop() { usedStopped = true },
  }
  const report = await applyScanCredentials({ ...deps, channel })
  assert.equal(report.reconnect.ok, true)
  assert.equal(usedStopped, false, '扫码落地不应再用裸 stop（会踩竞态）')
})

await check('多 Bot：扫码结果追加进 bots 数组，并用派生的 secretRef（凭据隔离）', async () => {
  const { deps, calls } = makeDeps({
    im: {
      secretRef: 'DSH_QQBOT_APP_SECRET',
      botId: 'qq',
      bots: [
        { botId: 'qq_existing', appId: '1900000000', secretRef: 'DSH_QQBOT_APP_SECRET_OLD', alias: '旧' },
      ],
    },
  })
  const channel = makeChannel().channel
  const report = await applyScanCredentials({ ...deps, channel })

  const patch = calls.updates[0].im
  assert.ok(Array.isArray(patch.bots), '应写 bots 数组')
  assert.equal(patch.bots.length, 2, '新机器人应追加')
  assert.equal(patch.bots[0].appId, '1900000000', '旧机器人保留')
  assert.equal(patch.bots[1].appId, '1900000001', '新机器人追加在末尾')
  assert.ok(/^qq_[a-f0-9]{24}$/.test(patch.bots[1].botId), `新 botId 应派生：${patch.bots[1].botId}`)
  assert.ok(/^DSH_QQBOT_APP_SECRET_[A-F0-9]{24}$/.test(patch.bots[1].secretRef), `新 secretRef 应派生：${patch.bots[1].secretRef}`)
  // 凭据写到新机器人自己的引用名下（隔离）。
  assert.equal(calls.credentials[0].ref, patch.bots[1].secretRef, '凭据应写到派生引用')
  assert.equal(report.secretRef, patch.bots[1].secretRef, 'report.secretRef 应为派生引用')
})

await check('多 Bot：扫到已有 appId 时按 appId 覆盖而非追加（幂等重扫）', async () => {
  const { deps, calls } = makeDeps({
    im: {
      secretRef: 'DSH_QQBOT_APP_SECRET',
      botId: 'qq',
      bots: [
        { botId: 'qq_old', appId: '1900000001', secretRef: 'DSH_QQBOT_APP_SECRET_X', alias: '旧名' },
        { botId: 'qq_other', appId: '1900000002', secretRef: 'DSH_QQBOT_APP_SECRET_Y', alias: '二号' },
      ],
    },
  })
  const channel = makeChannel().channel
  await applyScanCredentials({ ...deps, channel })
  const patch = calls.updates[0].im
  assert.equal(patch.bots.length, 2, '不应新增重复条目')
  assert.equal(patch.bots[0].appId, '1900000001', '仍是第一条')
  assert.ok(/^qq_[a-f0-9]{24}$/.test(patch.bots[0].botId), 'botId 已更新为派生值')
})

await check('扫码是新增：单 Bot 顶层配置（有 appId）扫新 bot → 旧 bot 保留、新 bot 追加', async () => {
  // 用户已经配过第一个机器人（顶层 appId/botId/secretRef），再扫一个新 bot：
  // 旧机器人必须保留（合成进 bots[0]），新机器人追加为 bots[1]——不是覆盖换绑。
  const { deps, calls } = makeDeps({
    im: { appId: '1900000000', botId: 'qq_old', secretRef: 'DSH_QQBOT_APP_SECRET_OLD' },
  })
  const channel = makeChannel().channel
  const report = await applyScanCredentials({ ...deps, channel })

  const patch = calls.updates[0].im
  assert.ok(Array.isArray(patch.bots), '应写 bots 数组（从单 Bot 升级为多 Bot）')
  assert.equal(patch.bots.length, 2, '旧 + 新 = 两条')
  assert.equal(patch.bots[0].appId, '1900000000', '旧 bot 保留在 bots[0]')
  assert.equal(patch.bots[0].botId, 'qq_old', '旧 botId 保留')
  assert.equal(patch.bots[0].secretRef, 'DSH_QQBOT_APP_SECRET_OLD', '旧 secretRef 保留')
  assert.equal(patch.bots[1].appId, '1900000001', '新 bot 追加在末尾')
  assert.ok(/^qq_[a-f0-9]{24}$/.test(patch.bots[1].botId), '新 botId 派生')
  // 凭据写到新 bot 自己的派生引用（与旧 bot 隔离）。
  assert.equal(calls.credentials[0].ref, patch.bots[1].secretRef, '新 bot 凭据应写到派生引用')
  assert.equal(report.secretRef, patch.bots[1].secretRef, 'report.secretRef 应为新 bot 的派生引用')
})

await check('被删除的 bot 重新扫码 → 清除其旧绑定（开新会话）', async () => {
  const { deps } = makeDeps({
    // 当前配置里**没有**扫码的这个 bot（它刚被删除）→ isFreshBot。
    im: {
      secretRef: 'DSH_QQBOT_APP_SECRET',
      botId: 'qq',
      bots: [{ botId: 'qq_other', appId: '1900000009', secretRef: 'S_OTHER' }],
    },
  })
  const removals = []
  const channel = {
    removeBotBindings: async (id) => { removals.push(id); return 3 },
    applyConfigAndReconnect: async () => ({ configApplied: true, reconnectStarted: true }),
  }
  const report = await applyScanCredentials({ ...deps, channel })
  // 扫码 appId=1900000001 → botId 派生，不在当前配置 → 应清旧绑定。
  assert.equal(removals.length, 1, '应清一次旧绑定')
  assert.ok(/^qq_[a-f0-9]{24}$/.test(removals[0]), `botId 应派生：${removals[0]}`)
  assert.equal(report.staleBindingsCleared, 3, 'report 应记录清除条数')
})

await check('已在配置的 bot 正常重扫 → 不清绑定（保留会话关系）', async () => {
  const { deriveBotIdentity } = await import('../../lib/qq-im/config.js')
  const derived = deriveBotIdentity('1900000001')
  const { deps } = makeDeps({
    im: {
      secretRef: 'DSH_QQBOT_APP_SECRET',
      botId: 'qq',
      bots: [{ botId: derived.botId, appId: '1900000001', secretRef: 'S1' }],
    },
  })
  const removals = []
  const channel = {
    removeBotBindings: async (id) => { removals.push(id); return 1 },
    applyConfigAndReconnect: async () => ({ configApplied: true, reconnectStarted: true }),
  }
  await applyScanCredentials({ ...deps, channel })
  assert.deepEqual(removals, [], '已在配置里的 bot 重扫不应清绑定')
  assert.equal('staleBindingsCleared' in (await applyScanCredentials({ ...deps, channel })), false,
    '不该有 staleBindingsCleared 字段')
})

console.log(`\n凭据落地编排：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)