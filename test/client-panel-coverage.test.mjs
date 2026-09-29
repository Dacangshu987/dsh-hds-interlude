/**
 * 配置面板「覆盖度 + 往返」测试。
 *
 * 为什么需要它：面板是**手写字段清单**，新加的配置项很容易只出现在 schema 里、
 * 却没人接进面板——用户看不到、也改不了，而且不会报错（属于"静默缺失"）。
 * 这个测试把本轮移植进来的新能力逐个钉在面板上，并验证「渲染 → 改值 → 保存」
 * 真的写进了正确的嵌套路径。
 *
 * 覆盖面：
 *   A. 节奏页：打字节奏四项（rc21）
 *   B. 聊天页：合并转发预算（rc6）、跨群投递（rc11）、意愿档位与 auto 三态（rc23）
 *   C. 扩展页：世界事件播种器（rc23）、模型特化（rc14）
 *   D. 往返：面板读回配置值；改动后保存，payload 落在正确的嵌套路径上
 *
 * 做法与 client-im.test.mjs 一致：加载真实 lib/client.js，用小型响应式 hook
 * 运行真实组件，再驱动它的 onClick / onChange。
 */
import { strict as assert } from 'node:assert'

/* ---------------------------------------------------------------- 捕获模块 */

let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }
await import(new URL('../lib/client.js', import.meta.url).href)
const factory = captured.factory

/* ---------------------------------------------------------------- 假 React */

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
        if (Object.is(value, slot.value)) return
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
      else if (cursor !== firstHookCount) {
        throw new Error(`hook 数量变化：首次 ${firstHookCount}，本次 ${cursor} —— hook 被放在了条件/早退分支之后？`)
      }
      return tree
    }
    rerender = run
    return { render: run, get: () => tree }
  }
  return react
}

/* ---------------------------------------------------------------- 假宿主 */

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

function makeFetch(state) {
  const calls = []
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
  const fetchImpl = async (url, options = {}) => {
    const record = { url, options }
    calls.push(record)
    if (url.includes('/presets')) return json({ ok: true, presets: [] })
    if (url.includes('/status')) return json({ ok: true })
    if (!options.method || options.method === 'GET') return json({ ok: true, value: state.config })
    const payload = JSON.parse(options.body ?? '{}')
    record.payload = payload
    state.config = deepMerge(state.config ?? {}, payload.value ?? payload)
    return json({ ok: true, value: state.config })
  }
  return { fetchImpl, calls }
}

/* ---------------------------------------------------------------- 树查询 */

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
/** 找「某个 label 所在格子里」的那个控件（最内层同时含 label 文本与一个控件的节点）。 */
function controlNearLabel(root, labelText) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    const text = collectText(node)
    if (text.includes(labelText)) {
      const ctrls = collectInputs(node)
      if (ctrls.length === 1) { found = ctrls[0]; return }
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return found
}
/**
 * 找「某个 label 所在格子里」的全部控件。
 *
 * 关键：从**最内层**取——含该文本的祖先节点控件更多，所以要收集全部候选、
 * 取控件数最少的那个（并列时取更深的，即后遍历到的）。
 */
function controlsNearLabel(root, labelText) {
  const candidates = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const text = collectText(node)
    if (text.includes(labelText)) {
      const ctrls = collectInputs(node)
      if (ctrls.length >= 1) candidates.push(ctrls)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  if (!candidates.length) return []
  candidates.sort((a, b) => a.length - b.length)
  return candidates[0]
}
function checkboxNear(root, labelText) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    const text = collectText(node)
    if (text.includes(labelText)) {
      const cbs = collectInputs(node).filter(i => i.props?.type === 'checkbox')
      if (cbs.length === 1) { found = cbs[0]; return }
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return found
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------------------------------------------------------------- 夹具 */

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const eq = (a, b, label) => assert.deepEqual(a, b, `${label}\n  实际: ${JSON.stringify(a)}\n  期望: ${JSON.stringify(b)}`)

// 初始配置刻意**全部用非默认值**：面板要是没读对这些路径，值就会露馅。
const state = {
  config: {
    timeZone: 'Asia/Shanghai',
    im: {
      enabled: true,
      group: {
        willingnessPreset: 'auto',
        willingnessAuto: { busy: 'reserved', idle: 'eager', asleep: 'quiet' },
      },
      chunking: {
        typingBaseDelaySeconds: 2,
        typingCharactersPerSecond: 12,
        typingMaxDelaySeconds: 8,
        typingJitterRatio: 0.1,
      },
      forwardLimits: { maxNodes: 10, maxCharacters: 4000, maxDepth: 1 },
      crossConversation: { enabled: true, maxPerTurn: 2, whitelist: ['group:777'] },
    },
    worldSeeder: {
      enabled: true, cadenceMinutes: 30, maxPending: 3, dailyCap: 2,
      maxHorizonHours: 48, temperature: 1.1, blockedNames: ['小鹿'],
    },
    specialization: { mode: 'lite', modelProbe: 'gemini-3-flash' },
    logLevel: 'warn',
    runtime: {
      contextEntryLimit: 35,
      contextTimeWindowMinutes: 45,
      memoryLimit: 12,
      repetitionGuard: false,
      restWindows: [{ enabled: true, label: 'night', start: '22:30', end: '06:30', minIntervalMinutes: 90, maxIntervalMinutes: 180 }],
    },
    proactive: { duringSleep: true, duringSleepPromises: false },
  },
}
const { fetchImpl, calls } = makeFetch(state)
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
/** 改值 + 重渲染（异步保存路径要等一拍）。 */
async function setValue(node, value) {
  node.props.onChange({ target: { value } })
  await sleep(20)
  view.render()
  return view.get()
}

console.log('配置面板：新能力覆盖度与往返')

/** 展开「高级选项」（分条/打字/降级等默认折叠）。 */
function openAdvanced(t) {
  const btn = buttonByText(t, '高级选项 ▸')
  if (btn) { btn.props.onClick(); view.render() }
  return view.get()
}

/* ─────────────────── A. 聊天页：打字节奏（与分条同段） ─────────────────── */

const chat = openAdvanced(goTab('聊天'))
check('聊天页有打字节奏四项，且读回配置里的值（rc21）', () => {
  eq(controlNearLabel(chat, '打字基础等待').props.value, 2, '基础等待')
  eq(controlNearLabel(chat, '打字速度').props.value, 12, '字/秒')
  eq(controlNearLabel(chat, '单条最长等待').props.value, 8, '最长等待')
  eq(controlNearLabel(chat, '等待的随机浮动').props.value, 0.1, '抖动')
})

/* ─────────────────── B. 聊天页：转发预算 / 跨群 / 意愿档位 ─────────────────── */

check('聊天页有合并转发预算三项，且读回配置值（rc6）', () => {
  const nodes = controlNearLabel(chat, '最多展开节点数')
  assert.ok(nodes, '没找到「最多展开节点数」')
  eq(nodes.props.value, 10, '节点上限')
  eq(controlNearLabel(chat, '字符预算').props.value, 4000, '字符预算')
  eq(controlNearLabel(chat, '嵌套递归深度').props.value, 1, '嵌套深度')
})

check('聊天页有跨群投递（rc11）：开关已开、每轮上限与白名单读回', () => {
  const cb = checkboxNear(chat, '允许私聊回合跨群投递')
  assert.ok(cb, '没找到跨群投递开关')
  eq(cb.props.checked, true, '开关应读回 true')
  eq(controlNearLabel(chat, '每轮最多几次').props.value, 2, '每轮上限')
  eq(controlNearLabel(chat, '目标白名单').props.value, 'group:777', '白名单')
})

check('聊天页有意愿档位（rc23）：档位 = auto，三态映射读回', () => {
  const preset = collectInputs(chat).find(i => i.tag === 'select' && (i.children ?? []).some(o => o.props?.value === 'auto'))
  assert.ok(preset, '没找到意愿档位下拉')
  eq(preset.props.value, 'auto', '档位应读回 auto')
  eq(controlNearLabel(chat, '忙碌时').props.value, 'reserved', 'busy 档')
  eq(controlNearLabel(chat, '闲适时').props.value, 'eager', 'idle 档')
  eq(controlNearLabel(chat, '睡眠时').props.value, 'quiet', 'asleep 档')
})

/* ─────────────────── C. 扩展页：播种器 / 模型特化 ─────────────────── */

const advanced = goTab('扩展')
check('扩展页有世界事件播种器（rc23）并读回配置值', () => {
  const cb = checkboxNear(advanced, '启用：低频生成与她有关的外部事件')
  assert.ok(cb, '没找到播种器开关')
  eq(cb.props.checked, true, '开关应读回 true')
  eq(controlNearLabel(advanced, '生成检查间隔').props.value, 30, '检查间隔')
  eq(controlNearLabel(advanced, '最远时限').props.value, 48, '最远时限')
  eq(controlNearLabel(advanced, '生成温度').props.value, 1.1, '温度')
  eq(controlNearLabel(advanced, '拉黑名单').props.value, '小鹿', '拉黑名单')
})

check('扩展页有模型特化（rc14）：档位与模型名读回', () => {
  const mode = collectInputs(advanced).find(i => i.tag === 'select' && (i.children ?? []).some(o => o.props?.value === 'lite'))
  assert.ok(mode, '没找到档位下拉')
  eq(mode.props.value, 'lite', '档位')
  eq(controlNearLabel(advanced, '模型名（用于自动推断）').props.value, 'gemini-3-flash', '模型名')
})

check('扩展页有维护段（记忆窗口 / 休息时段 / 日志）并读回配置值', () => {
  eq(controlNearLabel(advanced, '近期记录保留条目数').props.value, 35, '条目下限')
  eq(controlNearLabel(advanced, '额外保留时间窗').props.value, 45, '时间窗')
  eq(controlNearLabel(advanced, '长期事实读取上限').props.value, 12, '事实上限')
  eq(controlNearLabel(advanced, '休息时段').props.value, '22:30-06:30', '休息时段文本')
  const intervalInputs = controlsNearLabel(advanced, '窗口内推进间隔')
  eq(intervalInputs.length, 2, '窗口间隔应有最短/最长两个输入')
  eq(intervalInputs[0].props.value, 90, '窗口最短间隔')
  eq(intervalInputs[1].props.value, 180, '窗口最长间隔')
  const guard = checkboxNear(advanced, '连发同条数守卫')
  assert.ok(guard, '没找到条数守卫开关')
  eq(guard.props.checked, false, '守卫应读回 false')
  eq(checkboxNear(advanced, '休息时段也允许普通的主动联系').props.checked, true, 'duringSleep 应读回 true')
  eq(checkboxNear(advanced, '答应过的事').props.checked, false, 'duringSleepPromises 应读回 false')
  const log = collectInputs(advanced).find(i => i.tag === 'select' && (i.children ?? []).some(o => o.props?.value === 'warn'))
  assert.ok(log, '没找到日志级别下拉')
  eq(log.props.value, 'warn', '日志级别')
})

/* ─────────────────── D. 往返：改值 → 保存 → 落对路径 ─────────────────── */

let current = view.get()
current = await setValue(controlNearLabel(goTab('聊天'), '打字速度'), '20')
// 扩展页：改播种器检查间隔与模型名
current = await setValue(controlNearLabel(goTab('扩展'), '生成检查间隔'), '50')
current = await setValue(controlNearLabel(current, '模型名（用于自动推断）'), 'claude-sonnet')
// 聊天页：改跨群每轮上限
current = await setValue(controlNearLabel(goTab('聊天'), '每轮最多几次'), '3')
// 扩展页：改休息时段（两行 → 解析成两个窗口）
current = await setValue(controlNearLabel(goTab('扩展'), '休息时段'), '23:00-07:00\n13:00-14:00')

const saveBtn = buttonByText(current ?? view.get(), '保存')
check('找到保存按钮', () => { assert.ok(saveBtn, '没有保存按钮') })
if (saveBtn) {
  await saveBtn.props.onClick()
  await sleep(80)
}

const saveCall = calls.find(c => c.payload)
check('保存发出了请求', () => { assert.ok(saveCall, `没有发出保存请求（共 ${calls.length} 次：${calls.map(c => c.url).join(', ')}）`) })

if (saveCall) {
  const value = saveCall.payload?.value ?? saveCall.payload
  check('改动的值落在正确的嵌套路径上', () => {
    eq(value.im?.chunking?.typingCharactersPerSecond, 20, 'im.chunking.typingCharactersPerSecond')
    eq(value.im?.crossConversation?.maxPerTurn, 3, 'im.crossConversation.maxPerTurn')
    eq(value.worldSeeder?.cadenceMinutes, 50, 'worldSeeder.cadenceMinutes')
    eq(value.specialization?.modelProbe, 'claude-sonnet', 'specialization.modelProbe')
  })
  check('未改动的相关字段仍在（没有被面板漏写而丢失）', () => {
    eq(value.im?.forwardLimits?.maxDepth, 1, 'im.forwardLimits.maxDepth')
    eq(value.im?.group?.willingnessPreset, 'auto', 'im.group.willingnessPreset')
    eq(value.im?.group?.willingnessAuto?.idle, 'eager', 'willingnessAuto.idle')
    eq(value.worldSeeder?.blockedNames, ['小鹿'], 'worldSeeder.blockedNames')
    eq(value.specialization?.mode, 'lite', 'specialization.mode')
    eq(value.im?.chunking?.typingJitterRatio, 0.1, 'typingJitterRatio 未被取整破坏')
  })
  check('维护段的改动也落对路径（含休息时段解析成两个窗口）', () => {
    eq(value.logLevel, 'warn', 'logLevel')
    eq(value.runtime?.contextEntryLimit, 35, 'runtime.contextEntryLimit')
    eq(value.runtime?.memoryLimit, 12, 'runtime.memoryLimit')
    eq(value.runtime?.repetitionGuard, false, 'runtime.repetitionGuard')
    eq(Array.isArray(value.runtime?.restWindows) ? value.runtime.restWindows.length : -1, 2, '休息时段应解析成两条窗口')
    if (Array.isArray(value.runtime?.restWindows) && value.runtime.restWindows.length === 2) {
      eq(value.runtime.restWindows[0].start, '23:00', '第一条窗口 start')
      eq(value.runtime.restWindows[0].end, '07:00', '第一条窗口 end')
      eq(value.runtime.restWindows[1].start, '13:00', '第二条窗口 start')
    }
    eq(value.proactive?.duringSleep, true, 'proactive.duringSleep')
    eq(value.proactive?.duringSleepPromises, false, 'proactive.duringSleepPromises')
  })
}

console.log(`\n配置面板覆盖度：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
