/**
 * 新版宿主（dsh-settings ≥0.1.7）下的 settings 集成测试。
 *
 * 区别老形态测试（plugin.test.mjs / verify-preset-route.mjs 等都 mock 带 `register` 的
 * settings）：新宿主没有 `ctx.settings.register`，配置写入改用 `ctx.configEditor` 直写。
 *
 * 本测试验证的是**集成路径**而不是纯函数：
 *   1. apply() 在「settings 存在但无 register + 有 configEditor」的宿主下确实创建了
 *      settingsScope（settings 服务存在满足 inject，但没有 register 走 else 分支）；
 *   2. 设置页保存（POST /api/hds-interlude/settings）真的走到 configEditor.edit，
 *      深合并语义正确（story 保留、新字段写入）；
 *   3. 只是「当时 configEditor 未就绪」不应让 scope 永久失效——写入时应能重试取得。
 *
 * 运行：node test/settings-v2-integration.test.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

const plugin = await import('../lib/index.js')

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 新版设置的假 configEditor：edit 把「当前 raw + 继承层」交给 change。 */
function fakeConfigEditor(initialRaw) {
  let raw = structuredClone(initialRaw ?? {})
  const edits = []
  return {
    edits,
    entries: () => [{ options: { id: 'hds-interlude' } }],
    async edit(entry, change) {
      const inherited = { enabled: true, story: { character: { name: '继承层' } } }
      const next = change(raw, inherited)
      edits.push(next)
      raw = next
    },
    _read: () => raw,
  }
}

/**
 * 建新版宿主：提供 settings（**无 register**，模拟 SettingsForms 新版）+ configEditor。
 * @param {object} opts
 * @param {object} [opts.editor] 假 configEditor；不传 = 宿主暂时没有 configEditor。
 * @param {boolean} [opts.lateEditor] 传 true 时 editor 在 apply 之后才 provide（模拟异步就绪）。
 */
async function boot({ editor, lateEditor = false } = {}) {
  const routes = new Map()
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('webServer', {
    register(route) {
      routes.set(route.path, route.handler)
      return () => {}
    },
  })
  ctx.provide('credentials', { set: async () => {}, resolve: async () => undefined })
  // 新版 settings：存在但**没有 register**（只有新版方法）。空对象即可——apply 只探测 register。
  ctx.provide('settings', { describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} })
  if (!lateEditor) ctx.provide('configEditor', editor ?? fakeConfigEditor())

  const cfg = plugin.Config({
    timeZone: 'Asia/Shanghai',
    enabled: true,
    story: { character: { name: '水濑' }, plot: { style: '日常' } },
    runtime: { autoAdvanceEnabled: false, restWindows: [] },
    proactive: { enabled: false },
    im: { enabled: false },
  })
  const fiber = ctx.plugin(plugin, cfg)
  if (fiber && typeof fiber.then === 'function') await fiber
  await sleep(60)
  // 模拟 configEditor 异步就绪：apply 之后再注册。
  if (lateEditor) ctx.provide('configEditor', editor ?? fakeConfigEditor())
  return { ctx, routes }
}

function fakeReq(method, body) {
  const buf = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method, url: '/',
    on(evt, cb) {
      if (evt === 'data' && buf) cb(buf)
      if (evt === 'end') cb()
    },
  }
}
function fakeRes() {
  return { status: null, body: null, writeHead(code) { this.status = code }, end(text) { this.body = text } }
}

await check('新版宿主：settings 无 register + 有 configEditor → apply 启动、设置保存走 configEditor.edit', async () => {
  const editor = fakeConfigEditor({ enabled: true, story: { character: { name: '水濑' } }, im: { appId: '' } })
  const { routes } = await boot({ editor })
  const handler = routes.get('/api/hds-interlude/settings')
  assert.ok(handler, 'settings 路由应注册')

  const res = fakeRes()
  await handler(fakeReq('POST', { story: { character: { name: '新版水濑' } }, im: { appId: '1905583221' } }), res)
  assert.equal(res.status, 200, '保存应成功')
  assert.equal(editor.edits.length, 1, 'configEditor.edit 应被调用')

  const next = editor.edits[0]
  assert.equal(next.story.character.name, '新版水濑', 'story 应更新')
  assert.equal(next.im.appId, '1905583221', 'im.appId 应写入')
  assert.equal(next.enabled, true, 'enabled 应保留（深合并不覆盖无关字段）')
})

await check('重复保存：同一 scope 可复用，第二次 edit 也成功', async () => {
  const editor = fakeConfigEditor({ enabled: true, im: {} })
  const { routes } = await boot({ editor })
  const handler = routes.get('/api/hds-interlude/settings')

  const r1 = fakeRes(); await handler(fakeReq('POST', { im: { appId: 'A1' } }), r1)
  assert.equal(r1.status, 200)
  const r2 = fakeRes(); await handler(fakeReq('POST', { im: { appId: 'A2' } }), r2)
  assert.equal(r2.status, 200)
  assert.equal(editor.edits.length, 2)
  assert.equal(editor.edits.at(-1).im.appId, 'A2')
})

await check('configEditor 异步就绪（apply 时还没有）：保存仍能成功（惰性解析）', async () => {
  const editor = fakeConfigEditor({ enabled: true, im: {} })
  const { routes } = await boot({ editor, lateEditor: true })
  const handler = routes.get('/api/hds-interlude/settings')

  const res = fakeRes()
  await handler(fakeReq('POST', { im: { appId: 'LATE' } }), res)
  assert.equal(res.status, 200, 'configEditor 晚到也应能保存')
  assert.equal(editor.edits.at(-1)?.im?.appId, 'LATE', 'edit 应收到写入')
})

console.log(`\n新版宿主 settings 集成：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)