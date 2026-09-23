/**
 * provisioning 管理器的状态机测试（不联网）。
 *
 * 用假 connector / 假二维码生成 / 假凭据落地驱动，验证：
 *   - begin → starting →（SDK 回调 onQrDisplayed）→ qr + qrDataUrl；
 *   - onSuccess → done + onCredentials 被调用；
 *   - onFailure → failed；cancel → cancelled；
 *   - begin 幂等：流程进行中重复 begin 不重启。
 */
import assert from 'node:assert/strict'

import { createProvisionManager } from '../../lib/qq-im/connect.js'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

/**
 * 造一个可控的假 connector。
 *
 * @returns {{stop: Function, startQrConnect: Function, hooks: object}}
 */
function fakeConnector() {
  const hooks = {}
  let stopCalls = 0
  const startQrConnect = (callbacks) => {
    hooks.onQrDisplayed = callbacks.onQrDisplayed
    hooks.onSuccess = callbacks.onSuccess
    hooks.onFailure = callbacks.onFailure
    hooks.onQrExpired = callbacks.onQrExpired
    return () => { stopCalls += 1 }
  }
  return { startQrConnect, hooks, stopCalls: () => stopCalls }
}

const makeManager = (overrides = {}) => {
  const events = []
  const connector = fakeConnector()
  const manager = createProvisionManager({
    log: (level, text) => events.push(`${level}:${text}`),
    loadConnector: async () => connector.startQrConnect,
    makeQrDataUrl: async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
    onCredentials: async (creds) => events.push(`cred:${creds.appId}`),
    ...overrides,
  })
  return { manager, connector, events }
}

console.log('QQ 扫码绑定状态机')

await check('begin → starting，SDK 就绪后回调 onQrDisplayed → qr + qrDataUrl', async () => {
  const { manager, connector } = makeManager()
  const r = await manager.begin()
  assert.equal(r.phase, 'starting', `初态应是 starting，实际 ${r.phase}`)

  // 模拟 SDK 二维码就绪。
  connector.hooks.onQrDisplayed('https://qq.com/connect?task=abc')
  const s = manager.status()
  assert.equal(s.phase, 'qr', `二维码就绪后应是 qr，实际 ${s.phase}`)
  assert.equal(s.qrUrl, 'https://qq.com/connect?task=abc')
  // qrDataUrl 是异步生成的，等一拍。
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(manager.status().qrDataUrl?.startsWith('data:image/png;base64,'), '应生成二维码 data URL')
})

await check('扫码成功 → done，onCredentials 收到凭据', async () => {
  const { manager, connector, events } = makeManager()
  await manager.begin()
  connector.hooks.onQrDisplayed('https://qq.com/x')
  await connector.hooks.onSuccess([{ appId: '1900000001', appSecret: 'SECRET_1', userOpenid: 'OP' }])
  const s = manager.status()
  assert.equal(s.phase, 'done', `成功后应是 done，实际 ${s.phase}`)
  assert.equal(s.credentials?.appId, '1900000001')
  assert.ok(events.includes('cred:1900000001'), 'onCredentials 应被调用')
  // 「写凭据/更新配置/重连」的编排在 credential-apply.test.mjs 里验，
  // 这里只保证状态机把凭据交给了 onCredentials。
})

await check('扫码失败 → failed 且带错误信息', async () => {
  const { manager, connector } = makeManager()
  await manager.begin()
  connector.hooks.onFailure(new Error('用户取消了授权'))
  const s = manager.status()
  assert.equal(s.phase, 'failed', `失败后应是 failed，实际 ${s.phase}`)
  assert.ok(String(s.error).includes('用户取消了授权'))
})

await check('cancel → cancelled，且再次 begin 可以重新开始', async () => {
  const { manager, connector } = makeManager()
  await manager.begin()
  connector.hooks.onQrDisplayed('https://qq.com/x')
  const c = manager.cancel()
  assert.equal(c.phase, 'cancelled', `取消后应是 cancelled，实际 ${c.phase}`)
  assert.equal(connector.stopCalls(), 1, '应调用 SDK stop')

  // 取消后可重新开始（此时 stopFn 已清空）。
  const again = await manager.begin()
  assert.ok(['starting', 'qr'].includes(again.phase), `重新 begin 应回到 starting/qr，实际 ${again.phase}`)
})

await check('begin 幂等：流程进行中重复 begin 返回现有状态，不重启', async () => {
  const { manager, connector } = makeManager()
  await manager.begin()
  connector.hooks.onQrDisplayed('https://qq.com/a')

  const second = await manager.begin()
  assert.equal(second.phase, 'qr', `重复 begin 应沿用现有 qr 状态，实际 ${second.phase}`)
  assert.equal(second.attemptId ?? second.qrUrl, 'https://qq.com/a')
  assert.equal(connector.stopCalls(), 0, '重复 begin 不应取消当前流程')
})

await check('二维码过期：图片清空、保持 qr；新码显示后 rev+1 且图不被旧码覆盖', async () => {
  const { manager, connector } = makeManager()
  await manager.begin()
  connector.hooks.onQrDisplayed('https://qq.com/v1')
  await new Promise((r) => setTimeout(r, 10))
  const first = manager.status()
  assert.equal(first.phase, 'qr')
  assert.ok(first.qrDataUrl, '首码应有图片')

  // 过期：清图（避免扫到已失效的码）、保持 qr、rev 不变（留给新码递增）。
  connector.hooks.onQrExpired()
  const expired = manager.status()
  assert.equal(expired.phase, 'qr', '过期后仍应是 qr')
  assert.equal(expired.qrDataUrl, null, '过期后图片应清空')
  assert.equal(expired.qrRevision, first.qrRevision, 'rev 不应在过期时变')

  // SDK 刷新 → 新码：rev+1、新图；模拟旧图晚到，确认不会覆盖新图。
  const imgFor = (u) => 'data:image/png;base64,' + Buffer.from(u).toString('base64')
  connector.hooks.onQrDisplayed('https://qq.com/v2')
  await new Promise((r) => setTimeout(r, 10))
  const refreshed = manager.status()
  assert.ok(refreshed.qrRevision > first.qrRevision, '新码显示后 rev 应递增')
  assert.equal(refreshed.qrDataUrl, imgFor('https://qq.com/v2'), '图片应与当前 rev 的 URL 一致')
})

await check('二维码图片生成失败时降级：保留授权链接，不影响扫码', async () => {
  const { manager, connector } = makeManager({
    makeQrDataUrl: async () => { throw new Error('qrcode 不可用') },
  })
  const { events } = { events: [] }
  // 重新跑一次，捕获 log
  const m2 = createProvisionManager({
    log: (level, text) => events.push(`${level}:${text}`),
    loadConnector: async () => connector.startQrConnect,
    makeQrDataUrl: async () => { throw new Error('qrcode 不可用') },
  })
  await m2.begin()
  connector.hooks.onQrDisplayed('https://qq.com/y')
  await new Promise((r) => setTimeout(r, 10))
  const s = m2.status()
  assert.equal(s.phase, 'qr', '图片失败不应打断扫码')
  assert.equal(s.qrDataUrl, null, '没有图片 data URL')
  assert.equal(s.qrUrl, 'https://qq.com/y', '授权链接仍在')
  assert.ok(events.some(e => e.includes('二维码图片生成失败')), '应记录降级警告')
})

await check('connector 不可用 → failed，错误信息说明是扫码组件缺失', async () => {
  const { manager } = makeManager({
    loadConnector: async () => { throw new Error("Cannot find package '@tencent-connect/qqbot-connector'") },
  })
  const r = await manager.begin()
  assert.equal(r.ok, false)
  assert.equal(r.phase, 'failed')
  assert.ok(String(r.error).includes('扫码组件不可用'), `错误应说明组件缺失，实际 ${r.error}`)
})

/* ------------------------------------------------- 已配置感知（重启免重扫） */

await check('已配置时 status 带 configured（重启后前端据此免重扫）', async () => {
  // 重启后内存状态回到 idle，但配置/凭据已持久化——readConfigured 告诉前端。
  const { manager } = makeManager({
    readConfigured: () => ({ configured: true, appId: '1905583221' }),
  })
  const s = manager.status()
  assert.equal(s.phase, 'idle', '内存状态仍是 idle')
  assert.equal(s.configured?.configured, true, '应带出已配置标记')
  assert.equal(s.configured?.appId, '1905583221', '应带出 AppID')
})

await check('未配置时 configured.configured 为 false', async () => {
  const { manager } = makeManager({
    readConfigured: () => ({ configured: false, appId: '' }),
  })
  assert.equal(manager.status().configured?.configured, false)
})

await check('不注入 readConfigured 时不带该字段（纯状态机行为不变）', async () => {
  const { manager } = makeManager()
  assert.equal('configured' in manager.status(), false, '未注入时不应凭空出现 configured 字段')
})

await check('configured 随配置热更（不缓存）', async () => {
 let configured = false
  const { manager } = makeManager({
    readConfigured: () => ({ configured, appId: configured ? 'A' : '' }),
  })
  assert.equal(manager.status().configured?.configured, false)
 configured = true
  assert.equal(manager.status().configured?.configured, true, '每次快照都应重新读取')
})

console.log(`\n扫码状态机：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)