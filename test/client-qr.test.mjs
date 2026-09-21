/**
 * QQ 扫码绑定面板（QrConnectPanel）测试。
 *
 * 直接渲染 `exports.QrConnectPanel`（不穿透 InterludeCard），用假 fetch 驱动：
 *   - idle：显示「扫码绑定 QQ 机器人」按钮；
 *   - 点按钮 → POST begin → 显示二维码（img）与「用手机 QQ 扫一扫」；
 *   - done：显示绑定成功；
 *   - failed：显示错误并可重试；cancelled：显示已取消。
 *
 * 关键：**每个用例都重建 renderer 实例**（re-mount client.js 用 query 绕 ESM 缓存、
 * 每个 mount 新建 renderer，组件里捕获的 react 来自那个 renderer）。
 * 注意 hook 的 `currentScope` 来自组件捕获的 react 闭包，所以 factory 必须用
 * 「当前 renderer」的 react —— 不能像其它测试那样全局共享一个 react。
 * 扫码面板的 useEffect 会调 useRef/useState/useEffect，且没有早退；
 * 直接用独立 clone 的 renderer 最干净。
 */
import { strict as assert } from 'node:assert'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n        ${error?.message ?? error}`) }
}

/* ------------------------------- React 替身（每次 mount 独立） -------------- */

/**
 * 造一套完全独立的 react 替身，hooks 挂在这个 renderer 上。
 *
 * 组件（QrConnectPanel）在 factory 时捕获 `react` 闭包；这套替身把
 * `currentScope` 存在自己的实例上，所以**一个 mount = 一套 renderer = 一个组件实例**。
 */
function makeRenderer() {
  const instances = new Map()
  let currentScope = null
  let ordinal = 0
  let effects = []

  function scopeFor(identity) {
    if (!instances.has(identity)) instances.set(identity, { hooks: [], cursor: 0 })
    return instances.get(identity)
  }
  function renderComponent(Comp, props, identity) {
    const scope = scopeFor(identity)
    const prevScope = currentScope
    const prevOrdinal = ordinal
    currentScope = scope
    scope.cursor = 0
    ordinal = 0
    try { return Comp(props) } finally { currentScope = prevScope; ordinal = prevOrdinal }
  }

  const react = {
    createElement(tag, props, ...children) {
      const kids = children.length === 0 ? (props && props.children !== undefined ? props.children : undefined)
        : children.length === 1 ? children[0] : children
      if (typeof tag === 'function') {
        const slot = ordinal++
        const key = String(props?.key ?? '')
        return renderComponent(tag, { ...(props ?? {}), children: kids }, `${tag.name || 'anon'}#${slot}#${key}`)
      }
      return { tag: tag === undefined ? undefined : tag, props: props ?? {}, children: kids }
    },
    useState(initial) {
      const scope = currentScope
      const i = scope.cursor++
      if (scope.hooks[i] === undefined) scope.hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = scope.hooks[i]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect(fn) {
      const scope = currentScope
      const i = scope.cursor++
      if (scope.hooks[i] === undefined) {
        scope.hooks[i] = {}
        effects.push(() => { fn() })
      }
    },
    useRef(v) { const scope = currentScope; const i = scope.cursor++; if (scope.hooks[i] === undefined) scope.hooks[i] = { current: v }; return scope.hooks[i] },
  }

  return {
    react,
    render(Comp, props) {
      ordinal = 0
      effects = []
      const out = renderComponent(Comp, props ?? {}, `${Comp.name || 'Root'}#root`)
      for (const run of effects) run()
      return out
    },
  }
}

function findAll(node, pred, acc = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return acc
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, acc); return acc }
  if (typeof node !== 'object') return acc
  if (pred(node)) acc.push(node)
  findAll(node.children, pred, acc)
  return acc
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

/* ------------------------------- 假 fetch + 挂载 -------------- */

let importSeq = 0

/** 每个用例独立 mount：新 renderer + 重新加载 client.js（query 绕缓存）。 */
async function mount(status = { phase: 'idle', qrDataUrl: null, error: null }) {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }

  const url = new URL('../lib/client.js', import.meta.url)
  url.searchParams.set('qr', String(importSeq += 1) + '-' + Math.random().toString(36).slice(2))
  await import(url.href)

  const renderer = makeRenderer()
  const moduleExports = captured.factory((spec) => {
    if (spec === 'react') return renderer.react
    throw new Error('unexpected require: ' + spec)
  })

  const calls = []
  // 记录组件调度轮询 setTimeout 的次数。settle 自己的 setTimeout(0) 不算——
  // 只拦 ms>=1000 的轮询调度（轮询间隔 2000ms）。
  const timers = { set: 0 }
  const realSetTimeout = globalThis.setTimeout
  const fakeSetTimeout = function (fn, ms) {
    if (ms >= 1000) timers.set += 1
    return realSetTimeout(fn, ms)
  }
  globalThis.setTimeout = fakeSetTimeout
  globalThis.fetch = async (u, init = {}) => {
    calls.push({ url: u, method: init.method || 'GET' })
    const json = (body) => ({ json: async () => body })
    if (u === '/api/hds-interlude/qq-connect' && init.method === 'POST') {
      return json({ ok: true, value: { phase: 'qr', qrDataUrl: 'data:image/png;base64,AAA', qrUrl: 'https://qq.com/x' } })
    }
    if (u === '/api/hds-interlude/qq-connect/cancel' && init.method === 'POST') {
      return json({ ok: true, value: { phase: 'cancelled', qrDataUrl: null, error: null } })
    }
    return json({ ok: true, value: status })
  }

  let tree = renderer.render(moduleExports.QrConnectPanel)
  return {
    calls,
    timers,
    renderer,
    // 用 getter：h.render() 更新闭包 tree 后，读 h.tree 拿到的必须是最新的，
    // 否则断言还在看旧树（idle 那帧），症状就是「点了扫码却看不到二维码」。
    get tree() { return tree },
    render: () => { tree = renderer.render(moduleExports.QrConnectPanel); return tree },
    restore: () => { globalThis.setTimeout = realSetTimeout },
  }
}

const Panel = null // 不经 Panel 传参，直接由 mount 内部渲染
// `mount` 自建 renderer，因此不再有共享 Panel 引用。
void Panel
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0)) }

console.log('QQ 扫码绑定面板')

await check('初始（idle）显示「扫码绑定 QQ 机器人」按钮', async () => {
  const h = await mount()
  await settle()
  const buttons = findAll(h.tree, (n) => n.tag === 'button')
  assert.ok(buttons.some((b) => textOf(b).includes('扫码绑定')), '应有扫码按钮')
  assert.ok(textOf(h.tree).includes('扫码绑定'), '面板应有标题')
})

await check('已配置（重启后）→ 显示「已绑定，无需重新扫码」而不是诱导重扫', async () => {
  // 重启后 provision 内存状态回 idle，但配置/凭据已持久化。
  // 旧界面会让用户以为必须重扫；现在应直接说明已绑定。
  const h = await mount({
    phase: 'idle', qrDataUrl: null, error: null,
    configured: { configured: true, appId: '1905583221' },
  })
  await settle()
  const text = textOf(h.render())
  assert.ok(text.includes('已绑定'), '应显示已绑定')
  assert.ok(text.includes('无需重新扫码'), '应明确无需重扫')
  assert.ok(text.includes('1905583221'), '应带出 AppID')
  const btn = findAll(h.tree, (n) => n.tag === 'button')[0]
  assert.ok(textOf(btn).includes('扫码添加新机器人'), '已配置后扫码应是「新增机器人」而不是覆盖换绑')
})

await check('未配置（configured=false）→ 仍显示引导扫码的文案', async () => {
  const h = await mount({
    phase: 'idle', qrDataUrl: null, error: null,
    configured: { configured: false, appId: '' },
  })
  await settle()
  const text = textOf(h.tree)
  assert.ok(!text.includes('已绑定'), '未配置时不该说已绑定')
  assert.ok(text.includes('扫码绑定 QQ 机器人'), '应仍是扫码引导按钮')
})

await check('点「扫码绑定」→ POST begin → 显示二维码与提示', async () => {
  const h = await mount()
  await settle()
  const btn = findAll(h.tree, (n) => n.tag === 'button' && textOf(n).includes('扫码绑定'))[0]
  btn.props.onClick()
  await settle()

  const post = h.calls.find((c) => c.method === 'POST' && c.url === '/api/hds-interlude/qq-connect')
  assert.ok(post, '应发起 begin 请求')

  h.render()
  const img = findAll(h.tree, (n) => n.tag === 'img' && String(n.props?.src || '').startsWith('data:image'))
  assert.ok(img.length >= 1, '应渲染二维码图片')
  assert.ok(textOf(h.tree).includes('用手机 QQ 扫一扫'), '应显示扫码引导')
  // 扫码中不显示「扫码绑定」按钮（避免重复生成）。
  const buttons = findAll(h.tree, (n) => n.tag === 'button')
  assert.ok(!buttons.some((b) => textOf(b).includes('扫码绑定 QQ 机器人')), '扫码中不应再有开始按钮')
  assert.ok(buttons.some((b) => textOf(b).includes('取消')), '应有取消按钮')
})

await check('扫码结束（done）→ 显示应用凭据的进度提示', async () => {
  const h = await mount({ phase: 'done', qrDataUrl: null, error: null, lastApply: null })
  await settle()
  // 初次 GET 返回 done → 直接进入成功态。
  const text = textOf(h.render())
  assert.ok(text.includes('已扫码'), '应显示「已扫码」')
  assert.ok(text.includes('正在应用凭据'), '应显示正在应用凭据')
})

await check('done 但落地报告未回填 → 继续轮询（否则永远卡在「正在应用凭据」）', async () => {
  // 线上 bug：后端 onSuccess 先置 phase=done 再 await 凭证落地，lastApply 异步回填。
  // 旧实现把 done 当终态立刻停轮询 → 用户永远看不到三环结果是✓还是✗。
  const h = await mount({ phase: 'done', qrDataUrl: null, error: null, lastApply: null })
  await settle()
  assert.ok(h.timers.set >= 1, 'done 但无 lastApply 时应继续轮询等到落地报告')
  h.restore()
})

await check('done + 落地报告已就绪 → 停止轮询', async () => {
  const h = await mount({
    phase: 'done', qrDataUrl: null, error: null,
    lastApply: { secretRef: 'S', credential: { ok: true }, config: { ok: true }, reconnect: { ok: true } },
  })
  await settle()
  assert.equal(h.timers.set, 0, '报告已回填则不再轮询')
  h.restore()
})

await check('done + 落地报告 → 三环成败都显示（写凭据/配置/重连）', async () => {
  const h = await mount({
    phase: 'done', qrDataUrl: null, error: null,
    lastApply: {
      secretRef: 'DSH_QQBOT_APP_SECRET',
      credential: { ok: true },
      config: { ok: true },
      reconnect: { ok: true },
    },
  })
  await settle()
  const text = textOf(h.render())
  assert.ok(text.includes('写入凭据服务'), '应显示凭据写入步骤')
  assert.ok(text.includes('更新配置'), '应显示配置更新步骤')
  assert.ok(text.includes('重连通道'), '应显示重连步骤')
})

await check('done + 落地报告含失败 → 对应一步标 ✗ 并给出原因', async () => {
  const h = await mount({
    phase: 'done', qrDataUrl: null, error: null,
    lastApply: {
      secretRef: 'DSH_QQBOT_APP_SECRET',
      credential: { ok: true },
      config: { ok: true },
      reconnect: { ok: false, error: 'appSecret 无效' },
    },
  })
  await settle()
  const text = textOf(h.render())
  assert.ok(text.includes('✗'), '失败步骤应标 ✗')
  assert.ok(text.includes('重连通道'), '应显示重连步骤')
  assert.ok(text.includes('appSecret 无效'), '应显示失败原因')
})

await check('扫码失败 → 显示错误并可重试', async () => {
  const h = await mount({ phase: 'failed', qrDataUrl: null, error: '用户取消了授权' })
  await settle()
  h.render()
  assert.ok(textOf(h.tree).includes('用户取消了授权'), '应显示失败原因')
  const btn = findAll(h.tree, (n) => n.tag === 'button' && textOf(n).includes('扫码绑定'))[0]
  assert.ok(btn, '失败后应能重新开始')
})

await check('取消 → 显示已取消，且发起 cancel 请求', async () => {
  const h = await mount({ phase: 'qr', qrDataUrl: 'data:image/png;base64,AAA', error: null })
  await settle()
  h.render()
  const cancel = findAll(h.tree, (n) => n.tag === 'button' && textOf(n).includes('取消'))[0]
  assert.ok(cancel, '扫码中应有取消按钮')
  cancel.props.onClick()
  await settle()
  const cancelled = h.calls.find((c) => c.method === 'POST' && String(c.url).includes('/cancel'))
  assert.ok(cancelled, '应发起 cancel 请求')
  assert.ok(textOf(h.render()).includes('已取消'), '应显示已取消')
})

await check('后端未加载新代码（响应是文本 not found）时给出可读提示，而非英文报错', async () => {
  // 线上事故的原文照搬：响应体 `not found`，直接 r.json() 会抛
  // "Unexpected token 'o', \"not found\" is not valid JSON"。
  const h = await mount({ phase: 'idle', qrDataUrl: null, error: null })

  // 挂载后替换 fetch：后续所有扫码请求返回「body 不是 JSON」的假 Response。
  globalThis.fetch = async (u, init = {}) => {
    void u; void init
    return {
      json: async () => { throw new SyntaxError('Unexpected token \'o\', "not found" is not valid JSON') },
    }
  }

  // 触发一次请求：直接调组件里的 begin（点按钮等价）。
  const btn = findAll(h.tree, (n) => n.tag === 'button' && textOf(n).includes('扫码绑定'))[0]
  btn.props.onClick()
  await settle()

  const text = textOf(h.render())
  assert.ok(text.includes('扫码服务未就绪'), '应提示「扫码服务未就绪」（而不是显示 Unexpected token）')
  assert.ok(text.includes('重启 DSH'), '应给出重启指引')
  assert.ok(!text.includes('Unexpected token'), '不应泄露英文解析错误')
})

console.log(`\n扫码绑定面板：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)