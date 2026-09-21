/**
 * 扫码路由的集成测试：验证「只要路由注册了，三端点一定返回我们预期的 JSON」。
 *
 * 背景（线上事故）：用户看到扫码面板（前端新代码）但点扫码报
 *   Unexpected token 'o', "not found" is not valid JSON
 * 这是因为**后端 Node 进程还在跑旧代码**——`/qq-connect` 路由根本没注册，
 * 请求落到兜底 404，响应体不是 JSON。这个测试证明：代码本身没错，
 * 注册了就一定能用；出问题只可能是「进程没重载」。
 *
 * 做法：拿真实的 apply()（index.js）+ 假 host，把 webServer.register 捕获成
 * 一张「注册表」，模拟真实 webserver 的 match 语义（exact 优先、prefix 最长匹配），
 * 再直接调用匹配到的 handler，断言三端点的响应。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../../.tmp-dsh-home-qrroute', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../../lib/index.js')

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

/* ------------------------------------------------------------------ 假 host */

/**
 * 建宿主：把 webServer.register 捕获成注册表（exact/prefix 两张表），
 * 并提供 settings / credentials / agents 等假服务。
 */
function makeHost() {
  const exact = new Map()
  const prefixes = new Map()
  let fakeConnector = null

  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, list: () => [], currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('webServer', {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      table.set(route.path, route)
    },
  })
  ctx.provide('credentials', {
    set: async () => {},
    resolve: async () => undefined,
  })
  ctx.provide('settings', {
    register: (ns, schema, options) => ({
      get: () => schema(options?.base ?? {}),
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }),
  })

  // 注入假 connector，避免真联网、也避免 import 失败。
  const connectorHooks = {}
  fakeConnector = () => {
    const callbacks = {}
    ;['onSuccess', 'onFailure', 'onQrDisplayed', 'onQrExpired'].forEach((k) => {
      callbacks[k] = (arg) => { connectorHooks[k]?.(arg) }
    })
    return () => {}
  }
  ctx.__qqProvisionOverrides = {
    loadConnector: async () => (callbacks) => {
      Object.keys(callbacks).forEach((k) => { connectorHooks[k] = callbacks[k] })
      return () => {}
    },
    makeQrDataUrl: async () => 'data:image/png;base64,QUJD',
    onCredentials: async () => {},
  }
  void fakeConnector

  return { ctx, exact, prefixes, connectorHooks }
}

/** 模拟真实 webserver 的 match：exact 优先，prefix 最长匹配。 */
function matchRoute(host, pathname) {
  if (host.exact.has(pathname)) return host.exact.get(pathname)
  let best
  for (const [prefix, route] of host.prefixes) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    if (!best || prefix.length > best.path.length) best = route
  }
  return best
}

/** 用一个假 req/res 调 handler，返回 { status, body }。 */
async function callHandler(route, method, url) {
  const chunks = []
  const res = {
    writeHead(status) { this._status = status },
    end(body) { chunks.push(body ?? '') },
    write(chunk) { chunks.push(chunk) },
  }
  const req = { method, url }
  await route.handler(req, res)
  const body = chunks.join('')
  return { status: res._status ?? 200, body: body ? JSON.parse(body) : null }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('扫码路由集成（假 webserver 注册表）')

/* ---------------------------------------------------------------- 组装 */

const host = makeHost()
const fiber = host.ctx.plugin(plugin, plugin.Config({
  timeZone: 'Asia/Shanghai',
  im: { enabled: false },
}))
if (fiber?.then) await fiber
await sleep(30)

const qrRoute = matchRoute(host, '/api/hds-interlude/qq-connect')

await check('prefix 路由已注册（/api/hds-interlude/qq-connect）', () => {
  assert.ok(qrRoute, '扫码路由未注册——后端没加载新代码时会是这样')
})

/* ---------------------------------------------------------------- 三端点 */

await check('GET <base> → 返回 JSON，phase=idle', async () => {
  const { status, body } = await callHandler(qrRoute, 'GET', '/api/hds-interlude/qq-connect')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value?.phase, 'idle')
})

await check('POST <base> → 返回 JSON，进入 starting/qr', async () => {
  const { status, body } = await callHandler(qrRoute, 'POST', '/api/hds-interlude/qq-connect')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value?.phase, 'starting', '假 connector 未回调前应是 starting')
})

await check('connector onQrDisplayed → 状态 qr 且带 qrDataUrl', async () => {
  host.connectorHooks.onQrDisplayed('https://qq.com/connect?task=t1')
  await sleep(10)
  const { body } = await callHandler(qrRoute, 'GET', '/api/hds-interlude/qq-connect')
  assert.equal(body.value?.phase, 'qr')
  assert.ok(body.value?.qrDataUrl?.startsWith('data:image/png;base64,'), '应有二维码 data URL')
})

await check('POST <base>/cancel → 返回 JSON，phase=cancelled', async () => {
  const { status, body } = await callHandler(qrRoute, 'POST', '/api/hds-interlude/qq-connect/cancel')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value?.phase, 'cancelled')
})

await check('未知子路径 → 405（不会落到 not found 文本）', async () => {
  const { status } = await callHandler(qrRoute, 'GET', '/api/hds-interlude/qq-connect/nope')
  assert.equal(status, 405)
})

await check('所有响应都是合法 JSON（不会出现 "not found"）', async () => {
  // 回归真实事故：任何一次响应都必须是 JSON。
  const probes = [
    ['GET', '/api/hds-interlude/qq-connect'],
    ['POST', '/api/hds-interlude/qq-connect'],
    ['POST', '/api/hds-interlude/qq-connect/cancel'],
  ]
  for (const [method, url] of probes) {
    const { body } = await callHandler(qrRoute, method, url)
    assert.ok(body !== null, `${method} ${url} 的响应不是 JSON`)
    assert.equal(typeof body.ok, 'boolean')
  }
})

await host.ctx.stop?.()
try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`\n扫码路由集成：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)