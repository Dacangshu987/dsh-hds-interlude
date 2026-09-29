/**
 * 面板新增三块内容的测试：运行状态卡片的健康指标、实时日志卡片、意愿细调参数。
 *
 * 为什么需要它：
 *   - 健康指标是**派生数字**（成功率/缺失率/中位延迟），算错或格式错看起来"像正常"；
 *   - 实时日志要验证「拉到 → 渲染 → 增量 since」这条链，而不只是 DOM 里有没有字；
 *   - 意愿细调是新接进面板的 7 个字段 + 关键词：必须验证**读回**与**往返落对路径**
 *     （面板漏写会把用户手写的 settings.yaml 值抹掉）。
 *
 * 做法与其它 client 测试一致：真实 `lib/client.js` + 小型响应式 hook 跑真实组件。
 */
import { strict as assert } from 'node:assert'

let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }
await import(new URL('../lib/client.js', import.meta.url).href)
const factory = captured.factory

function makeReact() {
  let slots = []
  let cursor = 0
  let rerender = null
  let firstHookCount = null
  const react = {
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        slot.value = value
        queueMicrotask(() => rerender?.())
      }
      return [slot.value, set]
    },
    useEffect(fn) { const index = cursor; cursor += 1; if (!(index in slots)) slots[index] = { ran: true, cleanup: fn?.() }; return () => {} },
    useRef(v) { const index = cursor; cursor += 1; slots[index] ??= { current: v }; return slots[index] },
    useMemo(fn) { const index = cursor; cursor += 1; if (!(index in slots)) slots[index] = { value: fn() }; return slots[index].value },
    useCallback(fn) { return fn },
    createElement(tag, props, ...children) {
      const merged = children.flat(Infinity).filter(c => c != null && c !== false)
      if (merged.length === 0 && props?.children != null) merged.push(...[].concat(props.children))
      return { tag, props: props ?? {}, children: merged }
    },
  }
  react.__install = (Component) => {
    let tree = null
    const run = () => {
      cursor = 0
      tree = Component({})
      if (firstHookCount === null) firstHookCount = cursor
      else if (cursor !== firstHookCount) throw new Error(`hook 数量变化：首次 ${firstHookCount}，本次 ${cursor}`)
      return tree
    }
    rerender = run
    return { render: run, get: () => tree }
  }
  return react
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

/** 假宿主：/status 与 /logs 各自给固定数据，其余 GET 返回配置。 */
function makeFetch(state, { status, logs }) {
  const calls = []
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
  const fetchImpl = async (url, options = {}) => {
    const record = { url, options }
    calls.push(record)
    if (url.includes('/presets')) return json({ ok: true, presets: [] })
    if (url.includes('/logs')) {
      const since = Number(new URL(url, 'http://x').searchParams.get('since') ?? 0)
      record.since = since
      return json({ ok: true, seq: logs.seq, lines: logs.lines.filter(l => l.seq > since) })
    }
    if (url.includes('/status')) return json({ ok: true, value: status })
    if (!options.method || options.method === 'GET') return json({ ok: true, value: state.config })
    const payload = JSON.parse(options.body ?? '{}')
    record.payload = payload
    state.config = deepMerge(state.config ?? {}, payload.value ?? payload)
    return json({ ok: true, value: state.config })
  }
  return { fetchImpl, calls }
}

function collectText(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  const kids = node.children ?? []
  if (kids.length > 0) return kids.map(collectText).join('')
  return typeof node.props?.children === 'string' ? node.props.children : ''
}
function collectInputs(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.tag === 'input' || node.tag === 'select' || node.tag === 'textarea') out.push(node)
  for (const child of node.children ?? []) collectInputs(child, out)
  return out
}
function buttonByText(root, text) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    if (node.tag === 'button' && collectText(node).trim() === text) { found = node; return }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return found
}
/** 取「label 所在最内层节点」里的第一个控件。 */
function controlNearLabel(root, labelText) {
  const candidates = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (collectText(node).includes(labelText)) {
      const ctrls = collectInputs(node)
      if (ctrls.length) candidates.push(ctrls)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  candidates.sort((a, b) => a.length - b.length)
  return candidates.length ? candidates[0][0] : null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0
let failed = 0
/** 注意必须是 async 并 await：否则 async 断言里的失败会被静默吞掉（假通过）。 */
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const eq = (a, b, label) => assert.deepEqual(a, b, `${label}\n  实际: ${JSON.stringify(a)}\n  期望: ${JSON.stringify(b)}`)

const status = {
  now: Date.now(), zone: 'Asia/Shanghai', character: '江柚', enabled: true,
  toggles: { proactive: true, autoAdvance: true, autoMessage: true, agency: true, alter: true, preplan: true, wakeIdle: true, commitmentBackstop: true },
  timing: { checkIntervalMinutes: 5, graceMinutes: 1, autoAdvanceIntervalMinutes: 40, autoAdvanceJitterMinutes: 5, messageIntervalMinutes: 120, autoMessage: true, maxPerDay: 6 },
  channel: { enabled: true, connected: true, appId: '1905583221', sayFallback: 'strict', bindings: 2, bots: [] },
  sessions: { total: 3, live: 2 },
  advance: { sessions: [] },
  intents: { pending: 1, dueNow: 0, upcoming: [] },
  proactive: { reachedOutToday: 1, maxPerDay: 6, next: null },
  timers: { intentTimers: 1, scansInFlight: 0 },
  // 健康指标：成功率 50%、结构化缺失 20%、缓存命中 25%、中位 4s。
  health: {
    sessions: 1, narrativeTotal: 1, narrativeFailed: 1, structureMissing: 0.2,
    sideTaskTotal: 0, sideTaskFailed: 0, proactiveTotal: 2, proactiveSent: 1,
    inputTokens: 1000, cachedTokens: 250,
    successRate: 0.5, structureMissingRate: 0.2, cacheHitRate: 0.25, proactiveRate: 0.5,
    medianLatencyMs: 4000, sinceAt: '2026-09-28T20:00:00.000Z',
  },
}

const state = {
  config: {
    timeZone: 'Asia/Shanghai',
    im: {
      enabled: true,
      group: {
        willingness: {
          enabled: true, threshold: 0.3, minReplyIntervalSeconds: 120,
          probabilityAmplifier: 2.5, decayHalfLifeSeconds: 300, replyCost: 0.4,
          baseGain: 0.2, quoteGain: 0.3, keywordGain: 0.35, keywords: ['猫', '雨'],
        },
        willingnessPreset: 'auto',
        willingnessAuto: { busy: 'quiet', idle: 'active', asleep: 'quiet' },
      },
    },
  },
}
const logs = {
  seq: 2,
  lines: [
    { seq: 1, at: '2026-09-28T20:00:01.000Z', level: 'info', text: '通道已启动 bot=qq_test' },
    { seq: 2, at: '2026-09-28T20:00:02.000Z', level: 'warn', text: '无法解析 AppSecret（bot qq_test）' },
  ],
}

const { fetchImpl, calls } = makeFetch(state, { status, logs })
globalThis.fetch = fetchImpl

const react = makeReact()
const mod = factory((spec) => { if (spec === 'react') return react; throw new Error('unexpected: ' + spec) })
let Component = null
mod.apply({ slots: { inject: (slot, fn) => fn(), register: (reg, C) => { Component = C; return reg } } })
assert.ok(Component, '应当捕获到组件')

const view = react.__install(Component)
view.render()
await sleep(60)

function goTab(label) {
  const btn = buttonByText(view.get(), label)
  assert.ok(btn, `找不到「${label}」Tab`)
  btn.props.onClick()
  view.render()
  return view.get()
}

console.log('面板：状态卡片 / 实时日志 / 意愿细调')

/* ─────────────────── A. 运行状态卡片的健康指标 ─────────────────── */

/* ─────────────────── A. 状态卡片 ─────────────────── */

// 状态卡片**本体**在 test/status-view.test.mjs 里测（那边有能展开函数组件的夹具）。
// 这里只确认聊天页确实挂了这张卡：它是函数元素，普通文本遍历看不到内部内容。
const chatTab = goTab('聊天')
await check('聊天页顶部挂了压缩版连接状态卡片（RuntimeStatusView, compact）', () => {
  const found = (function find(node) {
    if (!node || typeof node !== 'object') return null
    if (typeof node.tag === 'function' && node.tag.name === 'RuntimeStatusView') return node
    for (const child of node.children ?? []) {
      const hit = find(child)
      if (hit) return hit
    }
    return null
  })(chatTab)
  assert.ok(found, '聊天页没找到 RuntimeStatusView 元素')
  assert.equal(found.props.compact, true, '挂的应是压缩版')
})

/* ─────────────────── B. 实时日志卡片 ─────────────────── */

const presets = goTab('预设/命令')
await check('日志卡片渲染宿主返回的日志行（含级别与内容）', () => {
  const text = collectText(presets)
  assert.ok(text.includes('实时日志'), '应有实时日志卡片')
  assert.ok(text.includes('通道已启动'), '缺少 info 行内容')
  assert.ok(text.includes('无法解析 AppSecret'), '缺少 warn 行内容')
  assert.ok(text.includes('WARN'), 'warn 行应有级别标记')
  assert.ok(text.includes('INFO'), 'info 行应有级别标记')
  assert.ok(text.includes('2 条'), '应显示条数')
})

await check('日志拉取带 since 参数（增量），刷新按钮再次拉取', async () => {
  const logCalls = calls.filter(c => c.url.includes('/logs'))
  assert.ok(logCalls.length >= 1, '挂载时应拉取一次')
  assert.equal(logCalls[0].since, 0, '首次 since 应为 0')
  // 点「刷新」
  const btn = buttonByText(view.get(), '刷新')
  assert.ok(btn, '没找到刷新按钮')
  await btn.props.onClick()
  await sleep(20)
  const after = calls.filter(c => c.url.includes('/logs'))
  assert.ok(after.length >= 2, '点刷新应再拉一次')
  assert.equal(after[after.length - 1].since, 2, '第二次应带上次的 seq（增量）')
})

/* ─────────────────── C. 意愿细调参数 ─────────────────── */

const chat = goTab('聊天')
await check('意愿细调默认收起；展开后读回配置里的 7 个参数与关键词', () => {
  const open = buttonByText(chat, '细调参数 ▸')
  assert.ok(open, '没找到「细调参数 ▸」折叠按钮（默认应收起）')
  assert.ok(!collectText(chat).includes('概率放大系数'), '收起时不该渲染细调字段')
  open.props.onClick()
  view.render()
  const expanded = view.get()
  eq(controlNearLabel(expanded, '概率放大系数').props.value, 2.5, '概率放大系数')
  eq(controlNearLabel(expanded, '意愿半衰期').props.value, 300, '半衰期')
  eq(controlNearLabel(expanded, '每次回复消耗').props.value, 0.4, '回复消耗')
  eq(controlNearLabel(expanded, '每条消息累积').props.value, 0.2, '基础累积')
  eq(controlNearLabel(expanded, '被引用时额外累积').props.value, 0.3, '引用累积')
  eq(controlNearLabel(expanded, '命中关键词时额外累积').props.value, 0.35, '关键词累积')
  eq(controlNearLabel(expanded, '关键词（每行一个').props.value, '猫\n雨', '关键词')
})

await check('细调参数改值后保存：落在 im.group.willingness.* 上', async () => {
  const expanded = view.get()
  controlNearLabel(expanded, '概率放大系数').props.onChange({ target: { value: '3.5' } })
  await sleep(20); view.render()
  controlNearLabel(view.get(), '关键词（每行一个').props.onChange({ target: { value: '猫\n咖啡' } })
  await sleep(20); view.render()

  const saveBtn = buttonByText(view.get(), '保存')
  assert.ok(saveBtn, '没找到保存按钮')
  await saveBtn.props.onClick()
  await sleep(80)

  const saveCall = calls.filter(c => c.payload).pop()
  assert.ok(saveCall, '应发出保存请求')
  const will = (saveCall.payload?.value ?? saveCall.payload)?.im?.group?.willingness
  assert.ok(will, 'payload 里应有 im.group.willingness')
  eq(will.probabilityAmplifier, 3.5, 'probabilityAmplifier 应写入')
  eq(will.keywords, ['猫', '咖啡'], 'keywords 应写入（按行切分）')
  // 未改动的细调项必须原样保留（面板漏写会把用户手写的值抹掉）
  eq(will.decayHalfLifeSeconds, 300, '半衰期不该被改掉')
  eq(will.replyCost, 0.4, '回复消耗不该被改掉')
  eq(will.baseGain, 0.2, '基础累积不该被改掉')
  eq(will.quoteGain, 0.3, '引用累积不该被改掉')
  eq(will.keywordGain, 0.35, '关键词累积不该被改掉')
  eq(will.threshold, 0.3, '阈值不该被改掉')
  eq(will.minReplyIntervalSeconds, 120, '冷却不该被改掉')
})

console.log(`\n面板状态/日志/细调：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

