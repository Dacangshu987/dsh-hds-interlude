/**
 * 后端 `/api/hds-interlude/im-test` 路由的用例。
 *
 * 这是设置页「发送测试」按钮的后端：它必须**走真实投递链路**
 * （deliverToIm → 分条 → 通道出口），并把结果如实回报。
 *
 * 要钉住：
 *   ① 有投递目标时真的发出去，且回报 sentCount/total/目标；
 *   ② 没有目标 / 没有会话时明确报错，不假装成功；
 *   ③ 只接受 POST（其余 405）；
 *   ④ 自定义文案可用；默认文案带【投递测试】标记（用户能一眼认出不是角色说的）。
 *
 * 运行：node test/im-test-route.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { caseDir } from './helpers/tmp.mjs'

const TEST_HOME = caseDir('im-test-route')
process.env.DSH_HOME = TEST_HOME

const plugin = await import('../lib/index.js')
const { saveState, emptyState } = await import('../lib/state.js')
const { BindingStore } = await import('../lib/qq-im/binding.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

const SESSION = 'session-im-test-route'
const CONV = 'c2c:OPENID_ROUTE_TEST'

/** 起一个插件实例，返回「调用路由」的入口与发出去的文本。 */
async function boot({ withBinding = true } = {}) {
  const home = caseDir('route-home')
  fs.mkdirSync(path.join(home, '.agent-presets', 'p'), { recursive: true })
  fs.writeFileSync(path.join(home, '.agent-presets', 'p', 'preset.yml'), 'name: p\n')
  process.env.DSH_HOME = home

  // 绑定表要在**插件启动前**写好：插件启动时读一次并缓存，
  // 之后再改磁盘它不会自动重读（生产里由入站消息驱动刷新）。
  // 注意传的是 DSH_HOME 本身——BindingStore 内部会自己拼 integrations/dsh-qq-im。
  if (withBinding) {
    const store = new BindingStore({ home })
    store.set({ conversationKey: CONV, sessionId: SESSION, botId: 'qq_bot', name: '测试目标' })
  }

  const sent = []
  const routes = new Map()
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('settings', {
    register: (ns, schema, options) => ({
      get: () => schema(options?.base ?? {}), watch: () => () => {}, update: async () => {}, replace: async () => {},
    }),
  })
  // 捕获路由注册，测的时候直接调 handler（不用真起 HTTP 服务）。
  ctx.provide('webServer', { register: (def) => { routes.set(def.path, def.handler); return () => {} } })
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.__qqImTransport = async (target, text) => { sent.push({ target, text }); return { sent: true } }

  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  saveState(SESSION, state)

  const config = plugin.Config({
    timeZone: 'Asia/Shanghai',
    proactive: { enabled: false },
    runtime: { restWindows: [], autoAdvanceEnabled: false },
    im: { enabled: true, appId: 'test-app' },
  })
  const fiber = ctx.plugin(plugin, config)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(80)
  return { ctx, routes, sent, home }
}

/** 造一个最小的 req/res，跑一次路由。 */
async function callRoute(handler, { method = 'POST', body = {} } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: '/api/hds-interlude/im-test',
    on(event, fn) {
      if (event === 'data' && chunks.length) setTimeout(() => fn(chunks[0]), 0)
      if (event === 'end') setTimeout(fn, 1)
      if (event === 'error') { /* 不触发 */ }
      return this
    },
    destroy() {},
  }
  let statusCode = 0
  let payload = ''
  const res = {
    writeHead(code) { statusCode = code; return this },
    end(text) { payload = text ?? ''; return this },
  }
  await handler(req, res)
  await sleep(20)
  return { statusCode, body: payload ? JSON.parse(payload) : null }
}

console.log('后端路由：/api/hds-interlude/im-test')

const booted = await boot({ withBinding: true })
const handler = booted.routes.get('/api/hds-interlude/im-test')

await check('路由已注册', () => {
  assert.ok(handler, `没注册该路由。已注册：${[...booted.routes.keys()].join(', ')}`)
})

await check('有投递目标时真的发出去，并回报条数与目标', async () => {
  booted.sent.length = 0
  const { statusCode, body } = await callRoute(handler, { body: { botId: 'qq_bot', conversationKey: CONV } })
  assert.equal(statusCode, 200)
  assert.equal(body.ok, true, `应成功：${JSON.stringify(body)}`)
  assert.equal(booted.sent.length, body.sentCount, '发出的条数与回报一致')
  assert.ok(booted.sent.length > 0, '传输层应收到消息')
  assert.equal(body.target.conversationKey, CONV)
  assert.equal(body.target.sessionId, SESSION)
})

await check('默认文案带「投递测试」字样（用户能认出不是角色说的）', async () => {
  booted.sent.length = 0
  const { body } = await callRoute(handler, { body: { botId: 'qq_bot', conversationKey: CONV } })
  assert.ok(body.text.includes('投递测试'), `默认文案应带标记：${body.text}`)
  assert.ok(booted.sent.some((m) => m.text.includes('投递测试')), '实际发出的文本也带标记')
})

await check('自定义文案可用（面板将来要传自定义时不必改后端）', async () => {
  booted.sent.length = 0
  const { body } = await callRoute(handler, {
    body: { botId: 'qq_bot', conversationKey: CONV, text: '自定义测试内容' },
  })
  assert.equal(body.text, '自定义测试内容')
  assert.ok(booted.sent.some((m) => m.text.includes('自定义测试内容')))
})

await check('不指定 conversationKey 时取该 bot 的第一条绑定', async () => {
  booted.sent.length = 0
  const { body } = await callRoute(handler, { body: { botId: 'qq_bot' } })
  assert.equal(body.ok, true)
  assert.equal(body.target.conversationKey, CONV)
})

await check('没有投递目标时明确报错，不假装成功', async () => {
  const b = await boot({ withBinding: false })
  const h = b.routes.get('/api/hds-interlude/im-test')
  const { statusCode, body } = await callRoute(h, { body: { botId: 'qq_bot' } })
  assert.equal(statusCode, 200)
  assert.equal(body.ok, false)
  assert.ok(body.error && body.error.length > 0, '应给出原因')
  assert.ok(body.error.includes('投递目标'), `原因应说明缺什么：${body.error}`)
  assert.equal(b.sent.length, 0, '没目标时不该发出任何东西')
  await b.ctx.stop?.()
})

await check('非 POST 返回 405', async () => {
  const { statusCode } = await callRoute(handler, { method: 'GET', body: null })
  assert.equal(statusCode, 405)
})

await booted.ctx.stop?.()

console.log(`\nim-test-route.test.mjs：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)
