/**
 * 设置页「幕间系统」面板的**输入**回归测试。
 *
 * 用一套足够真实的 React 替身（useState 跨渲染保持 + 受控 input + 可重渲染），
 * 真的去渲染卡片、真的派发 onChange，再看「谁收到了这段文字」。
 * 不是断言源码里有没有某个字符串——断言的是用户打字的结果。
 *
 * 覆盖两个线上症状：
 *   1. 在任意输入框里打字打不进去 / 打进去了却出现在别的框里；
 *   2. 把某个框清空后保存，刷新又变回旧值（清不掉）。
 *
 * 运行：node test/client-input.test.mjs
 */
import { strict as assert } from 'node:assert'

/* ------------------------------------------------------------ React 替身 */

/**
 * 极简但行为正确的 React 替身。
 *
 * 关键在 useState 的**跨渲染保持**：hook 槽按调用顺序存放，重渲染时 index 归零
 * 但槽位保留。受控 input 依赖这一点——如果状态不保持，就复现不出「打进去又弹回来」。
 */
function createHarness() {
  let hooks = []
  let pendingEffects = []
  let index = 0
  /** 挂载期首次渲染的 hook 总数（React #310 的检测基线）。 */
  let firstCount = null

  const react = {
    useState(init) {
      const i = index++
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
      return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next }]
    },
    useEffect(fn) {
      const i = index++
      // 只在首次渲染登记，模拟依赖数组为 [] 的「挂载时跑一次」。
      if (!(i in hooks)) { hooks[i] = true; pendingEffects.push(fn) }
    },
    useRef(init) {
      const i = index++
      if (!(i in hooks)) hooks[i] = { current: init }
      return hooks[i]
    },
    createElement(tag, props) {
      const rest = Array.prototype.slice.call(arguments, 2)
      const merged = Object.assign({}, props || {})
      const raw = rest.length ? rest : (props && props.children !== undefined ? [props.children] : [])
      merged.children = raw.length === 1 ? raw[0] : raw
      return { tag, props: merged }
    },
  }

  /**
   * 每次渲染结束后调用：校验 hook 数量在挂载期内稳定。
   * 真实 React 在 hook 数量变化时抛 #310（设置页直接白屏），
   * 这套替身不会自动报，所以显式检验——把「hook 放在早退分支之后」这类
   * 结构错误当场抓出来。
   */
  const endRender = () => {
    if (firstCount === null) firstCount = index
    else if (index !== firstCount) {
      throw new Error(`hook 数量变化：首次 ${firstCount}，本次 ${index} —— hook 被放在了条件/早退分支之后？`)
    }
  }

  return {
    react,
    beginRender: () => { index = 0 },
    endRender,
    /** 重新挂载：清空 hook 槽，等价于 React 里卸载再挂载一个新实例。 */
    unmount: () => { hooks = []; pendingEffects = []; index = 0; firstCount = null },
    takeEffects: () => pendingEffects.splice(0),
  }
}

/** 深度优先收集元素。 */
function walk(node, out = []) {
  if (Array.isArray(node)) { for (const item of node) walk(item, out); return out }
  if (!node || typeof node !== 'object' || !node.tag) return out
  out.push(node)
  walk(node.props && node.props.children, out)
  return out
}

const all = tree => walk(tree)
const textOf = node => {
  const c = node && node.props && node.props.children
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter(x => typeof x === 'string').join('')
  return ''
}
/** 按 placeholder 找控件——比按 label 找稳，因为 label 与控件是兄弟节点。 */
const byPlaceholder = (tree, ph) => all(tree).find(el => el.props && el.props.placeholder === ph)
const buttonByText = (tree, text) => all(tree).find(el => el.tag === 'button' && textOf(el) === text)

/** 派发一次「用户输入」。 */
const type = (control, value) => control.props.onChange({ target: { value, checked: value } })

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise(r => setTimeout(r, 0)) }

/* --------------------------------------------------------------- 装载 */

let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }

const harness = createHarness()
const mockRequire = (spec) => {
  if (spec === 'react') return harness.react
  throw new Error('unexpected require: ' + spec)
}

await import(new URL('../lib/client.js', import.meta.url).href)
const exports_ = captured.factory(mockRequire)

let registered = null
exports_.apply({
  slots: {
    inject: (slot, factoryFn) => { registered = factoryFn() },
    register: (reg, Comp) => ({ reg, Comp }),
  },
})
const Card = registered.Comp

/* --------------------------------------------------------- 假 fetch */

/**
 * 宿主端 `settingsScope.update()` 的深合并（逐字复刻 dsh-settings 的 mergeLayers）。
 *
 * 这个函数是整个「清空删不掉」问题的关键：**字段缺席 = 保持原值**。
 * 测试里真的用它来合并 POST 上来的补丁，而不是只检查 payload 长什么样——
 * 否则测的只是「我们发了什么」，而不是「用户最终看到什么」。
 */
function mergeLayers(under, over) {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

const server = {
  /** GET /settings 的返回值；模拟宿主里已存的配置。 */
  value: {},
  /** 宿主端真正保存下来的用户段（POST 会深合并进这里）。 */
  userSection: {},
  /** 最近一次 POST 的请求体。 */
  posted: null,
}
const jsonResponse = payload => ({ json: async () => payload })

globalThis.fetch = async (url, options) => {
  const method = (options && options.method) || 'GET'
  if (method === 'GET') {
    if (String(url).includes('/presets')) return jsonResponse({ ok: true, presets: [] })
    // 读回来的是「用户段合并到已存配置之上」的结果，与宿主一致。
    return jsonResponse({ ok: true, value: mergeLayers(server.value, server.userSection) })
  }
  server.posted = JSON.parse(options.body)
  server.userSection = mergeLayers(server.userSection, server.posted)
  return jsonResponse({ ok: true })
}

/** 渲染一次（先跑挂载副作用，再重渲染到就绪）。 */
async function mount(initialValue = {}) {
  server.value = initialValue
  server.userSection = {}
  server.posted = null
  harness.unmount()          // 每个用例都是一个全新的组件实例
  harness.beginRender()
  renderCard()
  for (const fn of harness.takeEffects()) fn()
  await flush()
  harness.beginRender()
  return renderCard()
}

/** 模拟「保存后重新打开面板」：拿宿主里存下来的合并结果重新挂载。 */
async function reopen() {
  const saved = mergeLayers(server.value, server.userSection)
  harness.unmount()
  harness.beginRender()
  renderCard()
  server.value = saved
  server.userSection = {}
  for (const fn of harness.takeEffects()) fn()
  await flush()
  harness.beginRender()
  return renderCard()
}

/**
 * 渲染并校验 hook 数量稳定。
 * 为什么必须经这里：真实 React 在 hook 数量变化时抛 #310（设置页白屏），
 * 替身不会自动报；endRender 把这条 invariant 变成显式断言。
 */
const renderCard = () => {
  const t = Card()
  harness.endRender()
  return t
}
const rerender = () => { harness.beginRender(); return renderCard() }
const save = async (tree) => { buttonByText(tree, '保存').props.onClick(); await flush() }

/** 切到指定 Tab（面板现在是分区结构；时区/间隔/开关在「节奏」页，IM 在「聊天」页）。 */
function switchTab(tree, label) {
  const btn = all(tree).find(el => el.tag === 'button' && textOf(el) === label)
  assert.ok(btn, `找不到「${label}」Tab`)
  btn.props.onClick()
  return rerender()
}

let passed = 0
let failed = 0
const check = async (label, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.log(`  FAIL ${label}\n       ${error && error.message ? error.message : error}`) }
}

console.log('面板输入：打字是否落在自己那一栏')

await check('每个输入框的 onChange 都写回它自己那条路径', async () => {
  const tree = await mount({})
  // FIELDS 里全部 12 个文本框（多行 + 单行），逐一验证「写进去的是自己」。
  const cases = [
    ['主角的称呼。', 'character.name', '水濑'],
    ['身份、性格、作息、习惯、压力、行为边界。', 'character.profile', '在便利店打工'],
    ['说话风格与口头习惯。', 'character.speech', '短句'],
    ['看待世界的方式，随剧情漂移，不改写人设。', 'perspective', '保持距离'],
    ['时间、地点、社会与现实规则。', 'world.setting', '沿海小城'],
    ['主角主要活动地点。', 'world.location', '便利店'],
    ['重要配角及其与主角的关系。', 'world.supportingCast', '店长佐藤'],
    ['对话者的默认背景。', 'counterpart.profile', '第一次来的客人'],
    ['新参与者与主角的默认初始关系。', 'counterpart.initial', '陌生而好奇'],
    ['你们现在是什么关系。', 'plot.startingPoint', '某个雨夜'],
    ['当前故事文风。', 'plot.style', '日常治愈向'],
    ['禁则与边界。', 'plot.boundaries', '不写血腥'],
  ]

  for (const [hint, path, value] of cases) {
    let t = await mount({})
    const control = byPlaceholder(t, hint)
    assert.ok(control, `找不到 placeholder 为「${hint}」的输入框`)
    type(control, value)
    t = rerender()

    // 症状 1：输入框自己能显示出来（受控值来自 draft 的对应路径）。
    const after = byPlaceholder(t, hint)
    assert.equal(after.props.value, value, `「${hint}」打进去的字没有留在框里（期望 ${path}=${value}，实际 value=${JSON.stringify(after.props.value)}）`)

    // 症状 1b：而且不能跑到别的框里去。
    for (const [otherHint, otherPath] of cases) {
      if (otherHint === hint) continue
      const other = byPlaceholder(t, otherHint)
      assert.equal(other.props.value, '', `「${hint}」的字跑到了「${otherHint}」（${otherPath}）`)
    }
  }
})

await check('保存时，打进去的字落在正确字段上', async () => {
  let tree = await mount({})
  type(byPlaceholder(tree, '主角的称呼。'), '水濑')
  tree = rerender()
  await save(tree)

  assert.ok(server.posted, '未发出保存请求')
  assert.deepEqual(
    server.posted.story && server.posted.story.character && server.posted.story.character.name,
    '水濑',
    `保存的 payload 里主角名称不对：${JSON.stringify(server.posted.story)}`,
  )
  const boundaries = server.posted.story && server.posted.story.plot && server.posted.story.plot.boundaries
  assert.ok(!boundaries, `「禁则与边界」不该收到别人的文字，实际：${JSON.stringify(boundaries)}`)
})

console.log('\n面板输入：清空一个字段是否真的清得掉')

await check('清空字段后保存并重开面板，框里应该真的是空的（不被深合并留下）', async () => {
  let tree = await mount({
    story: { character: { name: '水濑', profile: '在便利店打工的普通青年' } },
  })
  const HINT = '身份、性格、作息、习惯、压力、行为边界。'
  assert.equal(byPlaceholder(tree, HINT).props.value, '在便利店打工的普通青年', '初始值应从服务端读回')

  // 用户把「身份设定」整段删掉，保存。
  type(byPlaceholder(tree, HINT), '')
  tree = rerender()
  await save(tree)

  // 关键断言：重开面板时（= 真实用户刷新页面的体验）它是空的。
  const reopened = await reopen()
  assert.equal(
    byPlaceholder(reopened, HINT).props.value,
    '',
    '清空后重开仍是旧值——说明空串没有提交，宿主端深合并把旧值留下了',
  )
  // 没被清空的那栏要原样保留。
  assert.equal(byPlaceholder(reopened, '主角的称呼。').props.value, '水濑', '不该误伤其它字段')
})

await check('把整页都清空后保存，重开应当全空（可整段重置）', async () => {
  let tree = await mount({ story: { character: { name: '水濑' }, plot: { style: '日常治愈向' } } })
  buttonByText(tree, '重置本页').props.onClick()
  tree = rerender()
  await save(tree)

  const reopened = await reopen()
  assert.equal(byPlaceholder(reopened, '主角的称呼。').props.value, '', '重置后主角名称应为空')
  assert.equal(byPlaceholder(reopened, '当前故事文风。').props.value, '', '重置后文风应为空')
})

await check('清空关键词后保存，重开不该残留旧关键词', async () => {
  let tree = await mount({ story: { plot: { keywords: ['雨夜', '便利店'] } } })
  const box = byPlaceholder(tree, '用于长期事实检索，每行一个')
  assert.ok(box, '找不到关键词输入框')
  assert.equal(box.props.value, '雨夜\n便利店', '旧关键词应读得回来')

  type(box, '')
  tree = rerender()
  await save(tree)

  const reopened = await reopen()
  assert.equal(byPlaceholder(reopened, '用于长期事实检索，每行一个').props.value, '', '关键词没清掉')
})

console.log('\n面板输入：同一帧内的多次改动不互相覆盖')

await check('同一帧里改两个不同字段，两处都要留下', async () => {
  // React 会把同一个 tick 里的多次 setState 批处理掉。若更新基于渲染快照 `draft`，
  // 第二次 onChange 读到的还是旧草稿，第一次的改动就被整份覆盖丢失。
  // 真实触发场景：输入法组合输入、粘贴、自动填充，或「粘贴后紧接着点开关」。
  let tree = await mount({})
  // 注意：两次输入之间**不重渲染**——模拟同一帧内的连续事件。
  type(byPlaceholder(tree, '主角的称呼。'), '水濑')
  type(byPlaceholder(tree, '主角主要活动地点。'), '便利店')
  tree = rerender()
  await save(tree)

  const reopened = await reopen()
  assert.equal(byPlaceholder(reopened, '主角的称呼。').props.value, '水濑', '第一个字段的改动被覆盖丢了')
  assert.equal(byPlaceholder(reopened, '主角主要活动地点。').props.value, '便利店', '第二个字段的改动丢了')
})

await check('同一帧里改两个标量（时区 + 间隔），两处都要留下', async () => {
  // scalar 是独立的一份状态，同样会被批处理：两次 updateScalar 若都基于渲染快照，
  // 第二次会把第一次整个覆盖掉。
  let tree = await mount({})
  tree = switchTab(tree, '节奏')
  const tz = byPlaceholder(tree, 'Asia/Shanghai')
  const num = all(tree).find(el => el.props && el.props.type === 'number')
  assert.ok(tz && num, '找不到时区/数字输入框')
  // 同一帧内连续两次标量改动，中间不重渲染。
  type(tz, 'Europe/London')
  type(num, '15')
  tree = rerender()
  await save(tree)

  assert.equal(server.posted.timeZone, 'Europe/London', '先改的时区被后一次标量改动覆盖了')
  assert.equal(server.posted.gapNoticeMinutes, 15, '后改的间隔没有生效')
})

console.log('\n面板输入：数字与开关')

await check('间隔提示填 0 不该被悄悄改成 30', async () => {
  let tree = await mount({})
  tree = switchTab(tree, '节奏')
  const box = byPlaceholder(tree, undefined) && all(tree).find(el => el.props && el.props.type === 'number')
  assert.ok(box, '找不到数字输入框')
  type(box, '0')
  tree = rerender()
  await save(tree)
  assert.equal(server.posted.gapNoticeMinutes, 0, `填 0 却存成了 ${server.posted.gapNoticeMinutes}`)
})

await check('开关能独立切换且落在正确的键上', async () => {
  let tree = await mount({})
  tree = switchTab(tree, '节奏')
  // 勾上「每回合都注入当前时间」（「节奏」页的第一个复选框）
  const toggle = all(tree).find(el => el.tag === 'input' && el.props.type === 'checkbox')
  assert.ok(toggle, '找不到复选框')
  toggle.props.onChange({ target: { checked: true } })
  tree = rerender()
  await save(tree)
  assert.equal(server.posted.alwaysReportTime, true)
})

console.log('\n面板输入：写故事间隔 / 发消息间隔')

/** 按 label 文案找到同一格里的数字输入框（label 与控件是兄弟节点，见 renderField）。 */
function numberBoxByLabel(tree, labelText) {
  const label = all(tree).find(el => el.tag === 'label' && textOf(el) === labelText)
  assert.ok(label, `找不到「${labelText}」这一栏`)
  const cell = all(tree).find(el => {
    const kids = el.props && el.props.children
    return Array.isArray(kids) && kids.includes(label)
  })
  assert.ok(cell, `找不到「${labelText}」所在的格子`)
  const box = all(cell).find(el => el.tag === 'input' && el.props.type === 'number')
  assert.ok(box, `「${labelText}」里没有数字输入框`)
  return box
}

await check('写故事间隔能改，并落在 runtime.autoAdvanceIntervalMinutes', async () => {
  let tree = await mount({})
  tree = switchTab(tree, '节奏')
  type(numberBoxByLabel(tree, '写故事间隔（分钟）'), '25')
  tree = rerender()
  await save(tree)
  assert.equal(server.posted.runtime.autoAdvanceIntervalMinutes, 25, JSON.stringify(server.posted.runtime))
})

await check('发消息间隔填 0 不该被悄悄改成 120（0 = 每轮有话就发，是合法值）', async () => {
  // 与「间隔提示填 0」同一个坑：`Number('0') || 120` 会把明确的 0 改成默认值，
  // 用户想恢复「有话就发」的旧节奏却怎么填都没用。
  let tree = await mount({})
  tree = switchTab(tree, '节奏')
  type(numberBoxByLabel(tree, '发消息间隔（分钟）'), '0')
  tree = rerender()
  await save(tree)
  assert.equal(server.posted.im.messageIntervalMinutes, 0, JSON.stringify(server.posted.im))
})

await check('发消息间隔能改，并落在 im.messageIntervalMinutes', async () => {
  let tree = await mount({})
  tree = switchTab(tree, '节奏')
  type(numberBoxByLabel(tree, '发消息间隔（分钟）'), '180')
  tree = rerender()
  await save(tree)
  assert.equal(server.posted.im.messageIntervalMinutes, 180, JSON.stringify(server.posted.im))
})

await check('「故事里角色的发言自动发出去」关掉后落在 im.autoMessage', async () => {
  let tree = await mount({})
  tree = switchTab(tree, '节奏')
  const label = all(tree).find(el => el.tag === 'span' && /故事里角色的发言自动发出去/.test(textOf(el)))
  assert.ok(label, '找不到这个开关')
  const row = all(tree).find(el => {
    const kids = el.props && el.props.children
    return Array.isArray(kids) && kids.includes(label)
  })
  const box = all(row).find(el => el.tag === 'input' && el.props.type === 'checkbox')
  assert.ok(box, '这一行里没有复选框')
  assert.equal(box.props.checked, true, '默认应是开着的')
  box.props.onChange({ target: { checked: false } })
  tree = rerender()
  await save(tree)
  assert.equal(server.posted.im.autoMessage, false)
})

await check('老配置 deliverAutoAdvance=false 时，面板开关如实显示为关', async () => {
  // 兼容开关与新开关是「都开才开」。面板若不把它算进去，老用户会看到开着却收不到消息。
  let tree = await mount({ im: { autoMessage: true, deliverAutoAdvance: false } })
  tree = switchTab(tree, '节奏')
  const label = all(tree).find(el => el.tag === 'span' && /故事里角色的发言自动发出去/.test(textOf(el)))
  const row = all(tree).find(el => {
    const kids = el.props && el.props.children
    return Array.isArray(kids) && kids.includes(label)
  })
  const box = all(row).find(el => el.tag === 'input' && el.props.type === 'checkbox')
  assert.equal(box.props.checked, false, '老开关关着时面板该显示关，而不是开着')
})

console.log(`\n设置页输入：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
