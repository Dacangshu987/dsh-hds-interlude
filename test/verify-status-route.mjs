/**
 * 只读核验：用真实 ~/.dsh 数据挂载插件，捕获 /api/hds-interlude/status 的处理器，
 * 真的调一次，打印它返回的运行状态。
 *
 * 只读：不发消息、不改配置、不唤醒来回会话。仅读取内存与磁盘状态。
 * 用法: node test/verify-status-route.mjs
 */
import { Context } from '@deepseek-ai/cordis'

const captured = []
let handler = null

const ctx = new Context()
ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
ctx.provide('systemPrompt', { section: () => () => {} })
ctx.provide('tools', { register: () => () => {} })
ctx.provide('commands', { register: () => () => {} })
ctx.provide('settings', {
  register(ns, schema, options) {
    const resolveImpl = () => schema(options?.base ?? {})
    return { get: resolveImpl, watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})
ctx.provide('webServer', {
  register(route) {
    captured.push(route)
    if (route.path === '/api/hds-interlude/status') handler = route.handler
  },
})

const mod = await import('../lib/index.js')
const fiber = ctx.plugin(mod.default ?? mod, {})
if (fiber && typeof fiber.then === 'function') await fiber
await new Promise((r) => setTimeout(r, 300))

console.log('已注册路由：')
for (const r of captured) console.log(`  ${r.kind} ${r.path}`)

if (!handler) {
  console.error('\nFAIL: 没有捕获到 /api/hds-interlude/status 处理器')
  await ctx.stop?.()
  process.exit(1)
}

function fakeRes() {
  return {
    status: null,
    body: null,
    writeHead(code) { this.status = code },
    end(text) { this.body = text },
  }
}

// 1) GET 应返回 200 + ok:true
const res = fakeRes()
await handler({ method: 'GET' }, res)
console.log(`\nGET → ${res.status}`)
const parsed = JSON.parse(res.body)
console.log(JSON.stringify(parsed, null, 2))

// 2) 非 GET 必须 405（只读保证）
const res2 = fakeRes()
await handler({ method: 'POST' }, res2)
console.log(`\nPOST → ${res2.status}（应为 405）`)

// 3) 断言关键字段都在，且口径自洽
const v = parsed.value
const checks = [
  ['ok 为真', parsed.ok === true],
  ['GET 返回 200', res.status === 200],
  ['POST 被拒 405', res2.status === 405],
  ['有 sessions', v && typeof v.sessions === 'object'],
  ['有 intents', v && typeof v.intents === 'object'],
  ['有 timing', v && typeof v.timing === 'object'],
  ['有 toggles', v && typeof v.toggles === 'object'],
  ['有 advance', v && typeof v.advance === 'object'],
  ['有 proactive', v && typeof v.proactive === 'object'],
  // 要求1：只统计真正在用幕间层的实时会话；不再有 cold/stored。
  ['live 是数字且 >= 0', Number.isFinite(v?.sessions?.live) && v.sessions.live >= 0],
  ['不再有 cold 字段', !('cold' in (v?.sessions ?? {}))],
  ['不再有 stored 字段', !('stored' in (v?.sessions ?? {}))],
  // 要求3：下一次预计开口 + 幕间推进。
  ['advance.sessions 是数组', Array.isArray(v?.advance?.sessions)],
  ['proactive.next 是对象或 null', v?.proactive?.next === null || typeof v?.proactive?.next === 'object'],
  ['next 存在时带 at 与 pushToIm', !v?.proactive?.next || (Number.isFinite(v.proactive.next.at) && typeof v.proactive.next.pushToIm === 'boolean')],
  ['pending 是数字', Number.isFinite(v?.intents?.pending)],
  ['upcoming 是数组', Array.isArray(v?.intents?.upcoming)],
  ['upcoming 按到点时间升序', (() => {
    const u = v?.intents?.upcoming ?? []
    for (let i = 1; i < u.length; i += 1) if (u[i].dueAt < u[i - 1].dueAt) return false
    return true
  })()],
  ['advance.sessions 按下次补齐升序', (() => {
    const rows = (v?.advance?.sessions ?? []).filter((r) => Number.isFinite(r.nextAt))
    for (let i = 1; i < rows.length; i += 1) if (rows[i].nextAt < rows[i - 1].nextAt) return false
    return true
  })()],
  ['时区非空', typeof v?.zone === 'string' && v.zone.length > 0],
]

console.log('')
let bad = 0
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`)
  if (!pass) bad += 1
}
console.log(bad === 0 ? '\n全部断言通过。' : `\n${bad} 项断言失败。`)

await ctx.stop?.()
process.exit(bad === 0 ? 0 : 1)
