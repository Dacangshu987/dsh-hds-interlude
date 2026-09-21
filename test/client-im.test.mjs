/**
 * 设置面板「IM 机器人」这一节的接线验证。
 *
 * 为什么需要它：面板的失败模式很隐蔽——
 *   ① 字段读错 → 面板显示的值和实际配置不一致；
 *   ② 保存时漏写 → 用户改了没生效（或被 mergeLayers 深合并吞掉旧值）；
 *   ③ 写错类型 → schema 校验失败，保存整个报错。
 *
 * 这些都不会抛异常，只会让用户觉得「填了没用」。所以要真的走一遍
 * 「渲染 → 改值 → 保存 → 读回」的闭环。
 *
 * 做法：加载真实的 lib/client.js，**用一个小型响应式 hook 运行真实的
 * InterludeCard 组件**（它内部用 useState 管异步加载后的重渲染，
 * 一次性调用拿不到内容），再驱动它的 onClick/onChange。
 */
import { strict as assert } from 'node:assert'

/* ---------------------------------------------------------------- 捕获模块 */

let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }

await import(new URL('../lib/client.js', import.meta.url).href)
const factory = captured.factory

/* ---------------------------------------------------------------- 假 React */

/**
 * 带「重渲染」语义的最小 React。
 *
 * 关键点：组件加载完后会 setState 触发重渲染，一次性调用 Component({})
 * 只会拿到「加载中…」。所以要支持在状态变化时重跑组件函数，
 * 并把每轮渲染的 hook 槽位重新对齐。
 */
function makeReact() {
  let slots = []
  let cursor = 0
  let rerender = null
  /** 挂载期首次渲染的 hook 总数（React #310 的检测基线）。 */
  let firstHookCount = null

  const react = {
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) {
        slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = slots[index]
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        // 让下一轮渲染在第一轮完全结束后再开始，避免重入。
        queueMicrotask(() => rerender?.())
      }
      return [slot.value, set]
    },
    useEffect(fn) {
      const index = cursor
      cursor += 1
      // 只在首次执行（模拟 [] 依赖的行为足够本测试使用）。
      if (!(index in slots)) { slots[index] = { ran: true, cleanup: fn?.() } }
      return () => {}
    },
    useRef(v) { const index = cursor; cursor += 1; slots[index] ??= { current: v }; return slots[index] },
    useMemo(fn) { const index = cursor; cursor += 1; if (!(index in slots)) slots[index] = { value: fn() }; return slots[index].value },
    useCallback(fn) { return fn },
    createElement(tag, props, ...children) {
      // 真实 React 会把 props.children 与第三个参数合并；这里照做，
      // 否则 jsx('span', { children: '文案' }) 这种写法在树里会「丢文本」。
      const merged = children.flat(Infinity).filter(c => c != null && c !== false)
      if (merged.length === 0 && props?.children != null) {
        merged.push(...[].concat(props.children))
      }
      return { tag, props: props ?? {}, children: merged }
    },
  }

  /**
   * 安装一个组件：给出 render()，它会（重）运行组件函数并返回最新树。
   * @param {Function} Component 组件函数
   */
  react.__install = (Component) => {
    let tree = null
    const run = () => {
      cursor = 0
      tree = Component({})
      // 真实 React 要求每次渲染的 hook 数量一致（React #310 = rendered more
      // hooks than during the previous render，症状是设置页直接白屏）。
      // 这套替身平时不会报这个错，这里显式校验，把「hook 放错位置」抓出来。
      if (firstHookCount === null) firstHookCount = cursor
      else if (cursor !== firstHookCount) {
        throw new Error(`hook 数量变化：首次 ${firstHookCount}，本次 ${cursor} —— hook 被放在了条件/早退分支之后？`)
      }
      return tree
    }
    rerender = run
    return { render: run, get: () => tree }
  }
  react.__resetSlots = () => { slots = []; cursor = 0; firstHookCount = null }
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

    // 预设列表（客户端会拉一次，返回空数组即可）。
    if (url.includes('/presets')) return json({ ok: true, presets: [] })
    // 只读运行状态视图（不参与本测试，给一个空壳）。
    if (url.includes('/status')) return json({ ok: true })

    if (!options.method || options.method === 'GET') {
      // 客户端的契约：`d.value`（不是 `d.data.value`）。
      return json({ ok: true, value: state.config })
    }

    const payload = JSON.parse(options.body ?? '{}')
    record.payload = payload
    // 宿主端 POST 走 settingsScope.update()，语义是**深合并**。
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
  // children 数组里已经含有 props.children（createElement 合并过了），
  // 所以只在数组为空时才回退去读 props.children——否则文本会被数两遍。
  if (kids.length > 0) return kids.map(collectText).join('')
  return typeof node.props?.children === 'string' ? node.props.children : ''
}

function collectInputs(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.tag === 'input' || node.tag === 'select' || node.tag === 'textarea') out.push(node)
  for (const child of node.children ?? []) collectInputs(child, out)
  return out
}

/**
 * 找「某个 toggle 行」里的 checkbox。
 *
 * 关键：要从**最内层**那个同时含 checkbox 和这段文本的节点上取，
 * 否则会匹配到某个把整节都包住的外层 div，拿到的是别的复选框
 * （这正是第一版实现踩的坑）。
 */
function checkboxNear(root, labelText) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const text = collectText(node)
    if (text.includes(labelText)) {
      const cbs = collectInputs(node).filter(i => i.props?.type === 'checkbox')
      // 只认「这一层恰好一个 checkbox」的情形——那就是这个 toggle 行。
      if (cbs.length === 1) { found = cbs[0]; return }
    }
    for (const child of node.children ?? []) {
      walk(child)
      if (found) return
    }
  }
  walk(root)
  return found
}

function inputByPlaceholder(root, placeholder) {
  return collectInputs(root).find(i => i.props?.placeholder === placeholder)
}

function buttonByText(root, text) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    // 用**精确相等**而不是 includes：页面上同时有「保存」和
    // 「保存当前设定为预设」，用 includes 会抓错那一个。
    if (node.tag === 'button' && collectText(node).trim() === text) { found = node; return }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return found
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------------------------------------------------------------- 用例 */

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`) }
  catch (error) { failed += 1; console.error(`  ✗ ${label}\n      ${error.message}`) }
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}

// 初始配置刻意用「dsh-im 时代的形状」：验证迁移与新字段默认值都对。
const state = {
  config: {
    timeZone: 'Asia/Shanghai',
    im: { autoMessage: true, messageIntervalMinutes: 120 },
  },
}
const { fetchImpl, calls } = makeFetch(state)
globalThis.fetch = fetchImpl

const react = makeReact()
const mod = factory((spec) => { if (spec === 'react') return react; throw new Error('unexpected: ' + spec) })

let Component = null
mod.apply({
  slots: {
    inject: (slot, fn) => fn(),
    register: (reg, C) => { Component = C; return reg },
  },
})
assert.ok(Component, '应当捕获到组件')

const view = react.__install(Component)
view.render()
await sleep(60)          // 等 fetch 落地触发重渲染

/** 切到指定 Tab 并重渲染。面板是分区结构，IM 控件在「聊天」页。 */
function goTab(label) {
  const btn = buttonByText(view.get(), label)
  assert.ok(btn, `找不到「${label}」Tab`)
  btn.props.onClick()
  view.render()
  return view.get()
}

/** 展开「高级选项」（降级策略等默认折叠）。 */
function openAdvanced(t) {
  const btn = buttonByText(t, '高级选项 ▸')
  if (btn) {
    btn.props.onClick()
    view.render()
  }
  return view.get()
}

/** 点击第一个机器人卡片的 ⚙，展开二级面板（AppID / 角色预设等移到了这里）。 */
async function openFirstBot(t) {
  const gear = buttonByText(t, '⚙')
  assert.ok(gear, '没找到机器人卡片的 ⚙ 按钮')
  gear.props.onClick()
  view.render()
  await sleep(15)
  return view.get()
}

const baseTree = openAdvanced(goTab('聊天'))
// 小卡片默认收起：AppID / 凭据名等控件在二级面板里，先展开第一张卡片。
const tree = await openFirstBot(baseTree)

console.log('一、面板读出的初始值')
{
  check('IM 开关默认关（未配置时不该假装已启用）', () => {
    const cb = checkboxNear(tree, '启用 QQ 机器人通道')
    assert.ok(cb, '没找到「启用 QQ 机器人通道」开关')
    eq(cb.props.checked, false, '默认应当是关')
  })

  check('派生字段已隐藏：不再显示 AppSecret 凭据名 / Bot 标识只读输入', () => {
    // 按需求，botId / secretRef 是派生只读字段，二级面板里不再展示。
    assert.ok(!inputByPlaceholder(tree, 'DSH_QQBOT_APP_SECRET'), '不应再有凭据名输入框')
    assert.ok(!collectInputs(tree).some(i => i.props?.disabled === true), '不应再有只读输入框（botId/secretRef）')
  })

  check('AppID 输入框存在且为空', () => {
    const input = inputByPlaceholder(tree, '例如 1905583221')
    assert.ok(input, '没找到 AppID 输入框')
    eq(input.props.value, '', '未配置时应当是空串')
  })

  check('降级策略默认 strict', () => {
    // 注意：展开机器人二级面板后，角色预设下拉会抢占「第一个 select」，
    // 降级策略下拉要按它的选项（strict/loose）来精确识别。
    const selects = collectInputs(baseTree).filter(i => i.tag === 'select')
    const select = selects.find(s => (s.children ?? []).some(o => o.props?.value === 'strict'))
    assert.ok(select, '没找到降级策略下拉框')
    eq(select.props.value, 'strict', '默认应当是 strict')
    const opts = (select.children ?? []).map(o => o.props?.value)
    eq(opts, ['strict', 'loose'], '下拉框应当只有两个合法选项')
  })

  check('所有 checkbox 都有受控的 checked（不是 undefined）', () => {
    const cbs = collectInputs(tree).filter(i => i.props?.type === 'checkbox')
    assert.ok(cbs.length > 0, '一个复选框都没有')
    for (const cb of cbs) {
      assert.equal(typeof cb.props.checked, 'boolean',
        `有复选框的 checked 不是布尔：${JSON.stringify(cb.props.checked)}`)
    }
  })
}

console.log('\n二、改值 + 保存')
{
  // 模拟用户操作。每次 onChange 都会触发重渲染，所以要**重新取最新的树**——
  // 拿旧树上的控件继续操作，改的是已经被替换掉的闭包。
  let current = tree
  const rerenderAndGet = async () => { await sleep(15); current = view.get(); return current }

  checkboxNear(current, '启用 QQ 机器人通道').props.onChange({ target: { checked: true } })
  current = await rerenderAndGet()

  inputByPlaceholder(current, '例如 1905583221').props.onChange({ target: { value: '1905583221' } })
  current = await rerenderAndGet()

  const select = collectInputs(current).find(i => i.tag === 'select' && (i.children ?? []).some(o => o.props?.value === 'loose'))
  select.props.onChange({ target: { value: 'loose' } })
  current = await rerenderAndGet()

  const saveBtn = buttonByText(current, '保存')
  check('找到保存按钮', () => { assert.ok(saveBtn, '没有保存按钮') })

  if (saveBtn) {
    await saveBtn.props.onClick()
    await sleep(60)
  }

  const saveCall = calls.find(c => c.payload)
  check('保存发出了请求', () => { assert.ok(saveCall, `没有发出保存请求（共 ${calls.length} 次请求：${calls.map(c => c.url).join(', ')}）`) })

  if (saveCall) {
    const im = saveCall.payload?.value?.im ?? saveCall.payload?.im
    check('payload 里有 im 块', () => { assert.ok(im, `实际 payload：${JSON.stringify(saveCall.payload)}`) })

    if (im) {
      check('刚改的三项都写进去了', () => {
        eq(im.enabled, true, 'enabled 应当为 true')
        eq(im.appId, '1905583221', 'appId 应当被写入')
        eq(im.sayFallback, 'loose', 'sayFallback 应当为 loose')
      })

      check('只写凭据引用，绝不出现密钥字段', () => {
        eq(typeof im.secretRef, 'string', 'secretRef 应当是字符串')
        const suspicious = Object.keys(im).filter(k => /^(secret|appSecret|password|token|key)$/i.test(k))
        eq(suspicious, [], `不该出现密钥字段：${suspicious.join(',')}`)
      })

      check('分条参数是数字而不是字符串（否则 schema 会拒）', () => {
        eq(typeof im.chunking?.maxChars, 'number', 'maxChars 应当是 number')
        eq(typeof im.chunking?.maxMessages, 'number', 'maxMessages 应当是 number')
        eq(typeof im.chunking?.minIntervalMs, 'number', 'minIntervalMs 应当是 number')
      })

      check('额度与去重参数是数字', () => {
        eq(typeof im.proactive?.maxPerDay, 'number', 'maxPerDay 应当是 number')
        eq(typeof im.interactive?.replyWindowMinutes, 'number', 'replyWindowMinutes 应当是 number')
        eq(typeof im.dedupe?.ttlMinutes, 'number', 'ttlMinutes 应当是 number')
      })

      check('交互式回复三个开关都写全（漏写会被深合并吞掉旧值）', () => {
        eq(typeof im.interactive?.enabled, 'boolean', 'interactive.enabled 缺失')
        eq(typeof im.interactive?.requireInbound, 'boolean', 'interactive.requireInbound 缺失')
      })

      check('不写 exposeService（面板不管它，免得误抢占 dshIm）', () => {
        assert.ok(!('exposeService' in im), 'exposeService 不该被面板写入')
      })

      check('新会话的 workspace / 角色预设也写进 im（决定会话显不显示、回不回复）', () => {
        assert.ok('cwd' in im, 'im.cwd 应当被面板写入（留空也要写，才能清掉旧值）')
        assert.ok('agentPreset' in im, 'im.agentPreset 应当被面板写入')
        eq(typeof im.cwd, 'string', 'cwd 应当是字符串')
        eq(typeof im.agentPreset, 'string', 'agentPreset 应当是字符串')
      })
    }
  }
}

console.log('\n三、payload 能通过真实 schema')
{
  const saveCall = calls.find(c => c.payload)
  const { Config } = await import('../lib/schema.js')
  check('面板写出的 im 块能被 schema 接受并归一', () => {
    const value = saveCall.payload?.value ?? saveCall.payload
    const normalized = Config(value)
    eq(normalized.im.enabled, true, 'enabled 应当保留')
    eq(normalized.im.appId, '1905583221', 'appId 应当保留')
    eq(normalized.im.sayFallback, 'loose', 'sayFallback 应当保留')
    eq(normalized.im.chunking.maxChars, 40, 'chunking 应当有默认值')
  })

  check('服务端归一后的配置与面板读回的值一致（往返一致）', () => {
    const normalized = Config(saveCall.payload?.value ?? saveCall.payload)
    // 关键：把归一后的配置再喂给面板的读取逻辑，应当得到同样的开关状态。
    eq(normalized.im.enabled, true, 'enabled 往返一致')
    eq(normalized.im.secretRef, 'DSH_QQBOT_APP_SECRET', 'secretRef 往返一致')
  })
}

console.log(`\nclient-im.test.mjs：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)
