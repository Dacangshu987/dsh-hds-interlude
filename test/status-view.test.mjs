/**
 * 只读运行状态视图测试。
 *
 * 目的：真的把 `RuntimeStatusView` 渲染出来，验证
 *   1. 它只对 `/api/hds-interlude/status` 发 GET（绝不写入）；
 *   2. 拿到正常 payload 时，会话数 / 待办数 / 开关芯片 / 即将到点都渲染出来；
 *   3. 后端报错时显示错误而不是崩掉；
 *   4. 自动刷新默认开启，卸载时定时器被清掉（不泄漏）。
 *
 * 用一套足够真实的 React 替身：useState 跨渲染保持、useEffect 支持依赖数组与清理函数。
 * 不依赖真实浏览器，也不联网。
 */
import { strict as assert } from 'node:assert'

let passed = 0
let failed = 0

async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok  ${label}`)
    passed += 1
  } catch (error) {
    console.error(`  FAIL ${label}\n        ${error?.message ?? error}`)
    failed += 1
  }
}

/* ------------------------------- React 替身 ------------------------------- */

/**
 * 建立一份「有状态」的渲染器：useState 在同一次挂载内跨渲染保持。
 *
 * 关键点：hook 槽位**按组件实例分开**。父子组件共用一个 cursor 会让
 * RuntimeStatusView 的 useState 占用 InterludeCard 的槽位，渲染结果错乱。
 * 这里按「组件函数 + 组件在树里的出现次序」给每个实例一份独立的 hooks 数组，
 * 于是两次渲染之间，同一个实例的 hook 顺序稳定对齐。
 */
function makeRenderer() {
  // 每个组件实例的身份 → hooks。key 在每次渲染时按出现次序重新分配，
  // 保证「父的第 1 个子组件」永远是同一个实例。
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
    try {
      return Comp(props)
    } finally {
      currentScope = prevScope
      ordinal = prevOrdinal
    }
  }

  const react = {
    createElement(tag, props, ...children) {
      const kids = children.length === 0 ? (props && props.children !== undefined ? props.children : undefined)
        : children.length === 1 ? children[0] : children
      // 函数组件（如 RuntimeStatusView）在真实 React 里会被展开渲染；
      // 这里必须做同样的事，否则它只会变成一个没有 tag 的占位节点。
      if (typeof tag === 'function') {
        const slot = ordinal++
        const name = tag.name || 'anon'
        const key = String(props?.key ?? '')
        return renderComponent(tag, { ...(props ?? {}), children: kids }, `${name}#${slot}#${key}`)
      }
      return { tag: tag === undefined ? undefined : tag, props: props ?? {}, children: kids }
    },
    useState(initial) {
      const scope = currentScope
      const i = scope.cursor++
      if (scope.hooks[i] === undefined) scope.hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = scope.hooks[i]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }]
    },
    useEffect(fn, deps) {
      const scope = currentScope
      const i = scope.cursor++
      const prev = scope.hooks[i]
      const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
      if (changed) {
        if (prev && typeof prev.cleanup === 'function') prev.cleanup()
        scope.hooks[i] = { deps, cleanup: undefined }
        const slot = scope.hooks[i]
        effects.push(() => { slot.cleanup = fn() })
      }
    },
    useRef(v) { return { current: v } },
  }

  return {
    react,
    /** 渲染一次；返回元素树，并把本轮的 effect 跑掉。 */
    render(Comp, props) {
      ordinal = 0
      effects = []
      const out = renderComponent(Comp, props ?? {}, `${Comp.name || 'Root'}#root`)
      for (const run of effects) run()
      return out
    },
  }
}

/** 深度遍历元素树，收集所有匹配谓词的节点。 */
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

/** 挂载 client.js 的 factory，返回 { Renderer, View }。 */
// client.js 顶层会调用 window.__ModuleLoader__.load 把自己注册进来；
// ESM 的 import 只执行一次，所以每次 mount 都换一个 query 绕开模块缓存。
let importSeq = 0

async function mount(statusPayload, opts = {}) {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }

  const url = new URL('../lib/client.js', import.meta.url)
  url.searchParams.set('mount', String(importSeq += 1))
  await import(url.href)

  assert.ok(captured, 'client.js 未调用 window.__ModuleLoader__.load')
  const r = makeRenderer()
  const req = (spec) => {
    if (spec === 'react') return r.react
    throw new Error('unexpected require: ' + spec)
  }
  const moduleExports = captured.factory(req)

  // fetch 替身：记录调用，按需返回 payload / 报错。
  const calls = []
  globalThis.fetch = async (u, init) => {
    calls.push({ url: u, method: (init && init.method) || 'GET', init })
    if (opts.fetchError) throw new Error(opts.fetchError)
    if (u === '/api/hds-interlude/status') {
      if (opts.statusError) return { json: async () => ({ ok: false, error: opts.statusError }) }
      return { json: async () => ({ ok: true, value: statusPayload }) }
    }
    return { json: async () => ({ ok: true, value: {} }) }
  }

  // 捕获 setInterval / clearInterval 的调用次数，验证清理。
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const timers = { set: 0, clear: 0, ids: [] }
  globalThis.setInterval = (fn, ms) => { timers.set += 1; const id = realSet(fn, ms); timers.ids.push(id); return id }
  globalThis.clearInterval = (id) => { timers.clear += 1; return realClear(id) }

  // 走一次真实的注册流程，确认卡片确实注册了；同时拿到供直接渲染的只读视图。
  let registered = null
  moduleExports.apply({
    slots: {
      inject: (slot, fn) => { registered = fn() },
      register: (reg, Comp) => ({ reg, Comp }),
    },
  })

  // 让首轮 fetch 的 promise 链跑完。
  await new Promise((res) => realSet(res, 0))

  return {
    ...r,
    Comp: registered.Comp,
    // 直接渲染只读视图本身：InterludeCard 会先读设置、在 loading/error 时早退，
    // 穿透它去断言子视图会让用例依赖无关的加载时序。这里只测这张卡片。
    View: moduleExports.RuntimeStatusView,
    calls,
    timers,
    realSet,
    realClear,
  }
}

/**
 * 渲染 + 把 fetch 的 promise 链跑完 + 再渲染一次。
 *
 * 组件在 useEffect 里发起 fetch，首帧拿到的是「读取中…」；要看到真实内容必须
 * 让微任务/宏任务队列清空后重新渲染一次。真实 React 里这件事由 setState 驱动，
 * 这里的替身没有调度器，所以显式做两轮。
 */
async function settle(h) {
  h.render(h.View)
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => h.realSet(r, 0))
  }
  const tree = h.render(h.View)
  await new Promise((r) => h.realSet(r, 0))
  return tree
}

const SAMPLE = {
  now: Date.now(),
  zone: 'Asia/Shanghai',
  character: '水濑',
  enabled: true,
  toggles: { proactive: true, autoAdvance: true, agency: true, alter: true, preplan: true, wakeIdle: true, commitmentBackstop: false },
  timing: { checkIntervalMinutes: 5, graceMinutes: 1, autoAdvanceIntervalMinutes: 40, autoAdvanceJitterMinutes: 5, maxPerDay: 6 },
  // 只统计「真正在用幕间层」的实时会话；不再有 cold 字段。
  sessions: { live: 2, liveTotal: 7 },
  intents: {
    pending: 4, dueNow: 1, failed: 2,
    upcoming: [
      { sessionId: 'session-a', id: 'i9', kind: 'promise', summary: '承诺回访：三分钟后喊你', dueAt: Date.now() + 3 * 60000 },
      { sessionId: 'session-b', id: 'i3', kind: 'reminder', summary: '提醒喝水', dueAt: Date.now() + 40 * 60000 },
    ],
  },
  advance: {
    enabled: true,
    sessions: [
      { sessionId: 'session-a', nextAt: Date.now() + 12 * 60000, nextLatestAt: Date.now() + 17 * 60000, blockedByRest: false, pushToIm: true },
      { sessionId: 'session-b', nextAt: Date.now() + 25 * 60000, nextLatestAt: Date.now() + 30 * 60000, blockedByRest: true, pushToIm: false },
    ],
  },
  proactive: {
    reachedOutToday: 2,
    maxPerDay: 6,
    // 下一次主动开口：待办（到点+宽限）比推进更早，所以取它。
    next: {
      sessionId: 'session-a', id: 'i9', kind: 'promise',
      summary: '承诺回访：三分钟后喊你',
      at: Date.now() + 3 * 60000, atLatest: null,
      overdue: false, via: 'intent', blockedByRest: false, pushToIm: true,
    },
  },
  timers: { intentTimers: 2, scansInFlight: 0 },
}

console.log('只读运行状态视图')

/* ------------------------------- 用例 ------------------------------- */

await check('只对 status 路由发 GET，绝不写入', async () => {
  const h = await mount(SAMPLE)
  await settle(h)
  const statusCalls = h.calls.filter((c) => c.url === '/api/hds-interlude/status')
  assert.ok(statusCalls.length >= 1, '应对 status 路由发起请求')
  for (const c of statusCalls) assert.equal(c.method, 'GET', 'status 路由只能用 GET')
  // 整张卡片不应发出任何非 GET 请求（保存按钮要用户点击才触发）。
  const writes = h.calls.filter((c) => c.method !== 'GET')
  assert.equal(writes.length, 0, `卡片挂载即产生了写请求：${JSON.stringify(writes.map((w) => w.url))}`)
})

await check('渲染实时角色会话数、待办数、今日主动联系等统计', async () => {
  const h = await mount(SAMPLE)
  const text = textOf(await settle(h))
  assert.match(text, /运行状态（只读）/, '应有标题')
  assert.match(text, /实时角色会话/, '应有「实时角色会话」标签')
  assert.match(text, /待处理待办/, '应有待办标签')
  assert.match(text, /即将到点/, '应有即将到点区域')
  // 统计数字本身
  assert.match(text, /2\s*\/\s*6/, '今日已主动联系应显示 2 / 6')
})

await check('要求1：不再出现「冷会话」这一项', async () => {
  const h = await mount(SAMPLE)
  const text = textOf(await settle(h))
  assert.doesNotMatch(text, /冷会话（落盘）/, '不应再统计冷会话')
  assert.doesNotMatch(text, /冷会话数/, '不应再统计冷会话')
  // live 只取 sessions.live（=真正在用幕间层的实时会话），不取 liveTotal。
  assert.match(text, /实时角色会话/, '应有实时角色会话标签')
})

await check('要求3：显示下一次主动开口的预计时间', async () => {
  const h = await mount(SAMPLE)
  const text = textOf(await settle(h))
  assert.match(text, /下次主动开口/, '应有「下次主动开口」一栏')
  assert.match(text, /3 分钟后/, '应显示相对时间（取待办那条，比推进更早）')
  assert.match(text, /承诺回访/, '应显示开口类型')
  assert.match(text, /会投递到聊天软件/, '应说明是否真的发到聊天软件')
})

await check('要求3：待办已到点时如实说「随时」而不是编一个时间', async () => {
  const h = await mount({
    ...SAMPLE,
    proactive: {
      ...SAMPLE.proactive,
      next: { ...SAMPLE.proactive.next, overdue: true, at: Date.now() - 60000 },
    },
  })
  const text = textOf(await settle(h))
  assert.match(text, /随时（已到点，等下次扫描补跑）/, '已到点应说明是随时补跑')
})

await check('要求3：自动推进作为下次开口来源时标注区间与本地/投递', async () => {
  const h = await mount({
    ...SAMPLE,
    proactive: {
      ...SAMPLE.proactive,
      next: {
        sessionId: 'session-a', id: null, kind: 'advance',
        summary: '续写故事（只写故事，不发消息）',
        at: Date.now() + 12 * 60000, atLatest: Date.now() + 17 * 60000,
        overdue: false, via: 'advance', blockedByRest: false, pushToIm: false,
      },
    },
  })
  const text = textOf(await settle(h))
  assert.match(text, /续写故事/, '应标明来源是故事续写')
  assert.match(text, /12 分钟后\s*~\s*17 分钟后/, '应给时间区间（推进带随机抖动，不该假装精确）')
  assert.match(text, /只在 DSH 内唤起/, '未绑定聊天软件时应如实说明不会投递')
})

await check('要求3：没有待办且未开推进时如实说明', async () => {
  const h = await mount({ ...SAMPLE, proactive: { ...SAMPLE.proactive, next: null } })
  const text = textOf(await settle(h))
  assert.match(text, /暂无预计的主动开口/, '应说明暂无预计开口')
})

await check('要求3：写故事与发消息是两个节奏，面板上分开报', async () => {
  const h = await mount(SAMPLE)
  const text = textOf(await settle(h))
  assert.match(text, /故事续写与发消息/, '应有这一节')
  assert.match(text, /写故事/, '应有写故事一栏')
  assert.match(text, /每 40 分钟/, '应显示写故事间隔')
  assert.match(text, /随机/, '应说明抖动是随机的')
  assert.match(text, /发消息/, '应有发消息一栏')
  assert.match(text, /至少 120 分钟/, '应显示发消息间隔')
  assert.match(text, /只在角色说了话的那一轮发/, '应说明什么情况下才会真的发出去')
  assert.match(text, /下次续写/, '应列出各实时会话的下次续写时间')
  assert.match(text, /落在休息时段，会顺延/, '落在休息时段时应如实标注')
})

await check('要求3：面板如实区分「这一轮会发消息」与「只写故事」', async () => {
  // 这是这次改版的核心：故事照写不等于消息照发。面板混为一谈的话，
  // 用户会以为「下次续写」就是「下次会收到消息」。
  const h = await mount({
    ...SAMPLE,
    advance: {
      enabled: true,
      sessions: [
        { sessionId: 's-will-speak', nextAt: Date.now() + 60000, lastAssistantAt: null, lastAutoAdvanceAt: null, lastAutoMessageAt: null, nextLatestAt: null, restingNow: false, blockedByRest: false, pushToIm: true, speakMode: 'speak', speakBlockedBy: null, lastDelivery: null },
        { sessionId: 's-story-only', nextAt: Date.now() + 120000, lastAssistantAt: null, lastAutoAdvanceAt: null, lastAutoMessageAt: null, nextLatestAt: null, restingNow: false, blockedByRest: false, pushToIm: false, speakMode: 'story-only', speakBlockedBy: 'message-interval', lastDelivery: null },
      ],
    },
  })
  const text = textOf(await settle(h))
  assert.match(text, /这一轮可能发消息/, '放行的会话应说明可能会发')
  assert.match(text, /只写故事/, '被拦的会话应说明只写故事')
  assert.match(text, /还没到发消息间隔，攒着/, '应给出具体原因，而不是笼统一句「仅本地」')
})

await check('要求3：关闭自动推进时不再显示补齐时间', async () => {
  const h = await mount({ ...SAMPLE, advance: { enabled: false, sessions: SAMPLE.advance.sessions } })
  const text = textOf(await settle(h))
  assert.match(text, /已关闭/, '应显示已关闭')
  assert.doesNotMatch(text, /下次续写/, '关闭后不应再显示补齐时间')
})

await check('渲染即将到点的待办摘要与类型标签', async () => {
  const h = await mount(SAMPLE)
  const text = textOf(await settle(h))
  assert.match(text, /承诺回访：三分钟后喊你/, '应显示待办摘要')
  assert.match(text, /承诺回访\]/, '应把 promise 翻成中文标签')
  assert.match(text, /提醒喝水/, '应显示第二条待办')
})

await check('开关芯片如实区分开与关', async () => {
  const h = await mount(SAMPLE)
  const tree = await settle(h)
  const chips = findAll(tree, (n) => typeof n.props?.children === 'string' && /[●○]/.test(n.props.children))
  const labels = chips.map((c) => c.props.children)
  assert.ok(labels.some((l) => l.startsWith('● ') && l.includes('主动联系')), '开启的应显示实心点')
  assert.ok(labels.some((l) => l.startsWith('● ') && l.includes('写故事')), '开启的应显示实心点')
  assert.ok(labels.some((l) => l.startsWith('● ') && l.includes('自动发消息')), '开启的应显示实心点')
  assert.ok(labels.some((l) => l.startsWith('○ ') && l.includes('承诺兜底')), '关闭的应显示空心点')
})

await check('没有挂起待办时如实说明，而不是留白', async () => {
  const h = await mount({ ...SAMPLE, intents: { pending: 0, dueNow: 0, failed: 0, upcoming: [] } })
  const text = textOf(await settle(h))
  assert.match(text, /没有挂起的待办/, '应给出「没有挂起待办」的说明')
})

await check('后端报错时显示错误信息而不是崩溃', async () => {
  const h = await mount(SAMPLE, { statusError: '状态命名空间不可用' })
  const text = textOf(await settle(h))
  assert.match(text, /读取运行状态失败/, '应显示失败提示')
  assert.match(text, /状态命名空间不可用/, '应带上后端给的原因')
})

await check('网络异常时也降级为错误提示', async () => {
  const h = await mount(SAMPLE, { fetchError: 'Failed to fetch' })
  const text = textOf(await settle(h))
  assert.match(text, /读取运行状态失败/, '网络异常也应显示失败提示')
})

await check('自动刷新默认开启并注册了定时器', async () => {
  const h = await mount(SAMPLE)
  await settle(h)
  assert.ok(h.timers.set >= 1, '默认应注册自动刷新定时器')
  // 清掉，避免影响后续用例与进程退出。
  for (const id of h.timers.ids) h.realClear(id)
})

await check('自动刷新关掉后不再注册定时器', async () => {
  const h = await mount(SAMPLE)
  const tree = await settle(h)
  const boxes = findAll(tree, (n) => n.tag === 'input' && n.props?.type === 'checkbox' && typeof n.props?.onChange === 'function')
  assert.ok(boxes.length >= 1, '应有自动刷新复选框')
  const autoBox = boxes.find((b) => b.props.checked === true)
  assert.ok(autoBox, '自动刷新应默认勾选')

  // 勾掉自动刷新，然后重新渲染：effect 的依赖 [auto] 变了，
  // 旧定时器应被清理，且不应再挂新的。
  autoBox.props.onChange({ target: { checked: false } })
  const before = h.timers.set
  for (let i = 0; i < 3; i += 1) {
    h.render(h.View)
    await new Promise((r) => h.realSet(r, 0))
  }
  assert.equal(h.timers.set, before, `关掉自动刷新后仍在新增定时器：${h.timers.set}（关闭前 ${before}）`)

  // 收尾：清掉此前注册的定时器，避免拖住进程退出。
  for (const id of h.timers.ids) h.realClear(id)
})

await check('IM 通道状态：已连接时如实报告 AppID 与策略', async () => {
  const h = await mount({
    ...SAMPLE,
    channel: {
      enabled: true, connected: true, started: true,
      appId: '1905583221', secretRef: 'DSH_QQBOT_APP_SECRET_X', botId: 'qq',
      sayFallback: 'strict', lastError: null,
      bindings: 3, inbound: 12, outbound: 8,
    },
  })
  const text = textOf(await settle(h))
  assert.match(text, /IM 机器人/, '应有 IM 机器人一栏')
  assert.match(text, /已连接/, '应显示已连接')
  assert.match(text, /1905583221/, '应显示 AppID')
  assert.match(text, /strict/, '应显示降级策略')
  assert.match(text, /3 个会话/, '应显示绑定数')
  assert.match(text, /收 12 条 \/ 发 8 条/, '应显示收发统计')
})

await check('IM 通道状态：未启用时给出引导而不是报错', async () => {
  const h = await mount({ ...SAMPLE, channel: { enabled: false } })
  const text = textOf(await settle(h))
  assert.match(text, /未启用/, '应说明通道未启用')
  assert.match(text, /IM 机器人/, '应指出去哪打开')
})

await check('IM 通道状态：未连接时说明原因（凭据或 SDK）', async () => {
  const h = await mount({
    ...SAMPLE,
    channel: { enabled: true, connected: false, started: false, appId: '', secretRef: 'DSH_QQBOT_APP_SECRET', lastError: null },
  })
  const text = textOf(await settle(h))
  assert.match(text, /未启动/, '应显示未启动')
  assert.match(text, /缺 AppID/, 'appId 为空时明确指出')
})

await check('IM 通道状态：有 lastError 时如实展示', async () => {
  const h = await mount({
    ...SAMPLE,
    channel: { enabled: true, connected: false, started: false, appId: 'x', secretRef: 'DSH_QQBOT_APP_SECRET', lastError: 'AppSecret 未配置' },
  })
  const text = textOf(await settle(h))
  assert.match(text, /AppSecret 未配置/, '应显示具体的失败原因')
})

await check('压缩版（compact，聊天 Tab 用）只渲染连接状态，不带完整诊断', async () => {
  const h = await mount({
    ...SAMPLE,
    channel: { enabled: true, connected: true, appId: '1905583221', sayFallback: 'strict', bindings: 3, inbound: 12, outbound: 8 },
  })
  // 显式传 props 渲染压缩版（settle 不带 props，这里手动做两轮）。
  h.render(h.View, { compact: true })
  for (let i = 0; i < 4; i += 1) await new Promise((r) => h.realSet(r, 0))
  const text = textOf(h.render(h.View, { compact: true }))
  await new Promise((r) => h.realSet(r, 0))

  assert.match(text, /连接状态/, '压缩版标题应为「连接状态」')
  assert.match(text, /已连接/, '应显示连接状态')
  assert.match(text, /1905583221/, '应显示 AppID')
  assert.match(text, /3 个会话/, '应显示绑定数')
  assert.match(text, /收 12 条 \/ 发 8 条/, '应显示收发统计')
  // 压缩版不该带完整诊断卡的内容（统计网格 / 开关芯片 / 下次开口）。
  assert.doesNotMatch(text, /实时角色会话/, '压缩版不该渲染统计网格')
  assert.doesNotMatch(text, /下次主动开口/, '压缩版不该渲染下次开口')
  assert.doesNotMatch(text, /即将到点/, '压缩版不该渲染待办列表')
})

console.log(`\n只读运行状态视图：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
