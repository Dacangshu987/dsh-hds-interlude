/**
 * 设置页「发送测试消息」按钮（`lib/client.js` 的 sendImTest + 后端 /im-test 路由）。
 *
 * 这个按钮的价值在于**验证投递链路真的通**——所以测试要钉住：
 *   ① 有投递目标时才渲染按钮（没有目标时给引导文案）；
 *   ② 点击后 POST 到 /api/hds-interlude/im-test，带上 botId 与 conversationKey；
 *   ③ 成功与失败都如实显示（失败必须带具体原因，不能笼统说"失败"）；
 *   ④ 防连点（发送中禁用）。
 *
 * 运行：node test/client-im-test-button.test.mjs
 */
import assert from 'node:assert/strict'

let passed = 0
let failed = 0
/** 支持异步用例：必须 await fn()，否则多个用例会并发交错、断言看到彼此的状态。 */
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

/* --------------------------------------------------------- React 替身 */

function createHarness() {
  let index = 0
  let hooks = []
  let pendingEffects = []
  let firstCount = null
  const react = {
    useState(init) {
      const i = index++
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
      return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v }]
    },
    useEffect(fn) { const i = index++; if (!(i in hooks)) { hooks[i] = true; pendingEffects.push(fn) } },
    useRef(init) { const i = index++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i] },
    createElement(tag, props) {
      const rest = Array.prototype.slice.call(arguments, 2)
      const merged = Object.assign({}, props || {})
      const raw = rest.length ? rest : (props && props.children !== undefined ? [props.children] : [])
      merged.children = raw.length === 1 ? raw[0] : raw
      return { tag, props: merged }
    },
  }
  const endRender = () => {
    if (firstCount === null) firstCount = index
    else if (index !== firstCount) throw new Error(`hook 数量变化：首次 ${firstCount}，本次 ${index}`)
  }
  return {
    react,
    beginRender: () => { index = 0 },
    endRender,
    unmount: () => { hooks = []; pendingEffects = []; index = 0; firstCount = null },
    takeEffects: () => pendingEffects.splice(0),
  }
}

function walk(node, out = []) {
  if (Array.isArray(node)) { for (const item of node) walk(item, out); return out }
  if (!node || typeof node !== 'object' || !node.tag) return out
  out.push(node)
  walk(node.props && node.props.children, out)
  return out
}
const all = (tree) => walk(tree)
const textOf = (node) => {
  const c = node && node.props && node.props.children
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join('')
  return ''
}
const buttonByText = (tree, text) => all(tree).find((el) => el.tag === 'button' && textOf(el) === text)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)) }

/* --------------------------------------------------------- 装载 */

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
  get: () => undefined,
  slots: {
    inject: (slot, factoryFn) => { registered = factoryFn() },
    register: (reg, Comp) => ({ reg, Comp }),
  },
})
const Card = registered.Comp

/* --------------------------------------------------------- 假宿主 */

const server = {
  /** /status 返回的通道状态（含绑定）。 */
  status: { channel: { started: true, ready: true, bots: [{ botId: 'qq_bot', ready: true, appId: '1905' }] } },
  /** /im-test 的行为开关。 */
  testResult: { ok: true, sentCount: 1, total: 1, target: { botId: 'qq_bot', conversationKey: 'c2c:USER1' } },
  /** 最近一次 /im-test 的请求体。 */
  testPosted: null,
}
const jsonResponse = (payload) => ({ json: async () => payload })

globalThis.fetch = async (url, options) => {
  const target = String(url)
  const method = (options && options.method) || 'GET'
  if (target.includes('/settings')) {
    if (method === 'GET') return jsonResponse({ ok: true, value: { im: { enabled: true, appId: '1905', botId: 'qq_bot', targetId: 'USER1' } } })
    // 记录保存 payload，供「面板写出的配置」相关断言使用。
    server.posted = JSON.parse(options.body)
    return jsonResponse({ ok: true })
  }
  if (target.includes('/presets')) return jsonResponse({ ok: true, presets: [] })
  if (target.includes('/status')) return jsonResponse({ ok: true, value: server.status })
  if (target.includes('/im-test')) {
    server.testPosted = JSON.parse(options.body)
    return jsonResponse(server.testResult)
  }
  if (target.includes('/stickers')) return jsonResponse({ ok: true, dir: '', defaultDir: '', stats: null, stickers: [] })
  return jsonResponse({ ok: true })
}

/** 造一份带投递目标的状态（绑定挂在 bots[] 里，这才是前端读的位置）。 */
function statusWithBinding(conversationKey = 'c2c:USER1') {
  return {
    channel: {
      started: true,
      ready: true,
      bindings: 1,
      bots: [{
        botId: 'qq_bot',
        ready: true,
        appId: '1905',
        bindings: [{ conversationKey, sessionId: 'session-abc123456789', name: '我', boundAt: null }],
      }],
    },
  }
}

let renderCard = null
async function mount(status) {
  server.status = status
  server.testPosted = null
  harness.unmount()
  harness.beginRender()
  renderCard = () => { const t = Card(); harness.endRender(); return t }
  let tree = renderCard()
  for (const fn of harness.takeEffects()) fn()
  // /settings 与 /status 是两个并发的异步拉取：多轮 flush 让它们都落地，
  // 否则断言会看到上一轮的 botStatus（测试假红）。
  await flush()
  await sleep(20)
  await flush()
  harness.beginRender()
  tree = renderCard()
  return tree
}

/** 切到「聊天」Tab。 */
function goChat(tree) {
  const tab = all(tree).find((el) => el.tag === 'button' && textOf(el) === '聊天')
  if (tab) { tab.props.onClick(); harness.beginRender(); return renderCard() }
  return tree
}

/** 展开第一个机器人卡片（⚙）。 */
function openBot(tree) {
  const gear = buttonByText(tree, '⚙')
  if (gear) { gear.props.onClick(); harness.beginRender(); return renderCard() }
  return tree
}

console.log('设置页：发送测试消息按钮')

let tree = await mount(statusWithBinding())
tree = openBot(goChat(tree))

/* --------------------------------------------------------- ① 渲染 */

await check('有投递目标时渲染「发送测试」按钮', () => {
  const btn = buttonByText(tree, '发送测试')
  assert.ok(btn, `没找到按钮。横幅文本：${all(tree).map(textOf).filter(Boolean).join(' | ').slice(0, 300)}`)
})

await check('按钮所在的投递目标行同时有解绑按钮', () => {
  const send = buttonByText(tree, '发送测试')
  const row = all(tree).find((el) => {
    const kids = el.props && el.props.children
    return Array.isArray(kids) && kids.includes(send)
  })
  assert.ok(row, '找不到按钮所在的行')
  assert.ok(all(row).some((el) => el.tag === 'button' && textOf(el) === '解绑'), '同一行应有解绑按钮')
})

await check('没有投递目标时不渲染按钮，而是给引导文案', async () => {
  const t2 = await mount({
    channel: { started: true, ready: true, bots: [{ botId: 'qq_bot', ready: true, appId: '1905', bindings: [] }] },
  })
  const t3 = openBot(goChat(t2))
  assert.equal(buttonByText(t3, '发送测试'), undefined, '无绑定时不该有测试按钮')
  assert.ok(all(t3).some((el) => textOf(el).includes('暂无绑定')), '应提示暂无绑定')
})

/* --------------------------------------------------------- ② 点击行为 */

tree = await mount(statusWithBinding())
tree = openBot(goChat(tree))

await check('点击后 POST 到 /im-test 并带上 botId 与 conversationKey', async () => {
  const btn = buttonByText(tree, '发送测试')
  btn.props.onClick()
  await flush()
  assert.ok(server.testPosted, '没有发出请求')
  assert.equal(server.testPosted.botId, 'qq_bot')
  assert.equal(server.testPosted.conversationKey, 'c2c:USER1')
})

/* --------------------------------------------------------- ③ 结果如实显示 */

await check('发送中显示「发送中…」（防连点）', async () => {
  const t = await mount(statusWithBinding())
  const tree2 = openBot(goChat(t))
  const btn = buttonByText(tree2, '发送测试')
  btn.props.onClick()
  harness.beginRender()
  const mid = renderCard()
  const busy = buttonByText(mid, '发送中…')
  assert.ok(busy, '点击后应立刻显示发送中')
  assert.equal(busy.props.disabled, true, '发送中应禁用')
  await flush()
})

await check('成功时给出条数与目标', async () => {
  server.testResult = { ok: true, sentCount: 1, total: 1, target: { botId: 'qq_bot', conversationKey: 'c2c:USER1' } }
  const t = await mount(statusWithBinding())
  const tree2 = openBot(goChat(t))
  buttonByText(tree2, '发送测试').props.onClick()
  await flush()
  harness.beginRender()
  const after = renderCard()
  const texts = all(after).map(textOf).join('\n')
  assert.ok(texts.includes('测试消息已发出'), `应提示成功：${texts.slice(0, 200)}`)
  assert.ok(texts.includes('1/1'), '应给出条数')
  assert.ok(texts.includes('c2c:USER1'), '应给出目标')
})

await check('失败时如实显示后端给的具体原因（不笼统说失败）', async () => {
  server.testResult = { ok: false, error: '机器人未启动：无法解析 AppSecret（DSH_QQBOT_APP_SECRET 未配置）' }
  const t = await mount(statusWithBinding())
  const tree2 = openBot(goChat(t))
  buttonByText(tree2, '发送测试').props.onClick()
  await flush()
  harness.beginRender()
  const after = renderCard()
  const texts = all(after).map(textOf).join('\n')
  assert.ok(texts.includes('测试消息发送失败'), '应提示失败')
  assert.ok(texts.includes('无法解析 AppSecret'), `应带上具体原因：${texts.slice(0, 260)}`)
})

await check('网络异常也有提示（不静默）', async () => {
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/im-test')) throw new Error('network down')
    return savedFetch(url, options)
  }
  try {
    const t = await mount(statusWithBinding())
    const tree2 = openBot(goChat(t))
    buttonByText(tree2, '发送测试').props.onClick()
    await flush()
    harness.beginRender()
    const after = renderCard()
    assert.ok(all(after).map(textOf).join('\n').includes('network down'), '应显示错误信息')
  } finally {
    globalThis.fetch = savedFetch
  }
})

/* --------------------------------------------------------- ④ 引导文案 */

await check('投递目标区给出「收到即说明通道通」的说明', () => {
  const texts = all(tree).map(textOf).join('\n')
  assert.ok(texts.includes('投递测试'), '应说明测试消息的标记')
})

/* --------------------------------------------------------- ⑤ 群聊意愿配置往返 */

console.log('\n群聊意愿：面板字段与配置往返')

/**
 * 打开「聊天」Tab 并展开第一个机器人卡片。
 *
 * 传当前树进来；goChat / openBot 自己会配对渲染（内部 beginRender + renderCard），
 * 所以这里不要额外手动渲染，否则同一轮会被算两次 hook（会触发
 * 「hook 数量变化」的误报）。
 */
function chatTree(tree) {
  return openBot(goChat(tree))
}
/** 按开关文案找到它的 checkbox。 */
function toggleByText(root, text) {
  const label = all(root).find((el) => el.tag === 'span' && textOf(el).includes(text))
  assert.ok(label, `找不到开关「${text}」`)
  const row = all(root).find((el) => {
    const kids = el.props && el.props.children
    return Array.isArray(kids) && kids.includes(label)
  })
  const box = all(row).find((el) => el.tag === 'input' && el.props.type === 'checkbox')
  assert.ok(box, `「${text}」这一行没有 checkbox`)
  return box
}

await check('群聊意愿开关渲染在「消息行为」区', async () => {
  const t = chatTree(await mount(statusWithBinding()))
  const texts = all(t).map(textOf).join('\n')
  assert.ok(texts.includes('群聊发言意愿'), '应有意愿开关')
  assert.ok(texts.includes('群聊仅响应 @机器人'), '应有 @门控 开关（既有项）')
})

await check('关闭意愿时不铺开参数（面板保持克制）', async () => {
  const t = chatTree(await mount(statusWithBinding()))
  const boxes = all(t).filter((el) => el.tag === 'input' && el.props.type === 'number')
  assert.equal(boxes.some((el) => String(el.props.value) === '0.24'), false, '关闭时不该出现阈值输入框')
})

await check('开启意愿后显示阈值与冷却输入框（默认 0.24 / 0）', async () => {
  let t = await mount(statusWithBinding())
  t = chatTree(t)
  toggleByText(t, '群聊发言意愿').props.onChange({ target: { checked: true } })
  harness.beginRender()
  t = renderCard()
  const boxes = all(t).filter((el) => el.tag === 'input' && el.props.type === 'number')
  assert.ok(boxes.some((el) => String(el.props.value) === '0.24'), '应显示阈值（默认 0.24）')
  assert.ok(boxes.some((el) => String(el.props.value) === '0'), '应显示冷却（默认 0）')
})

await check('保存时写出 im.group.willingness 的三个字段', async () => {
  let t = await mount(statusWithBinding())
  t = chatTree(t)
  toggleByText(t, '群聊发言意愿').props.onChange({ target: { checked: true } })
  harness.beginRender()
  t = renderCard()
  // 「保存」按钮（页面底部那个）。
  const save = all(t).filter((el) => el.tag === 'button' && textOf(el) === '保存').pop()
  assert.ok(save, '找不到保存按钮')
  save.props.onClick()
  await flush()
  const posted = server.posted
  assert.ok(posted?.im?.group?.willingness, `payload 应含 group.willingness：${JSON.stringify(posted?.im?.group)}`)
  assert.equal(posted.im.group.willingness.enabled, true)
  assert.equal(posted.im.group.willingness.threshold, 0.24)
  assert.equal(posted.im.group.willingness.minReplyIntervalSeconds, 0)
  // @门控 与意愿是独立字段，不该互相干扰。
  assert.equal(posted.im.group.mentionOnly, true, '@门控 仍按面板值写出')
})

await check('面板不覆盖 settings.yaml 里的细调参数（深合并语义）', () => {
  // 用户在配置文件里写了概率放大 / 关键词 / 消耗；面板保存后它们必须还在。
  // 这是「只写面板管理的字段」这条设计的核心保证。
  const mergeLayers = (under, over) => {
    if (over === undefined) return under
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    if (!isObj(under) || !isObj(over)) return over
    const out = { ...under }
    for (const [k, v] of Object.entries(over)) out[k] = k in out ? mergeLayers(out[k], v) : v
    return out
  }
  const existing = { im: { group: { willingness: { enabled: false, probabilityAmplifier: 2.5, keywords: ['江柚'], replyCost: 0.9 } } } }
  const posted = { im: { group: { willingness: { enabled: true, threshold: 0.24, minReplyIntervalSeconds: 0 } } } }
  const merged = mergeLayers(existing, posted).im.group.willingness
  assert.equal(merged.enabled, true, '面板改了开关')
  assert.equal(merged.threshold, 0.24, '面板写了阈值')
  assert.equal(merged.probabilityAmplifier, 2.5, '手写的概率放大保留')
  assert.deepEqual(merged.keywords, ['江柚'], '手写关键词保留')
  assert.equal(merged.replyCost, 0.9, '手写消耗保留')
})

await check('@门控关闭时给出醒目提示（否则每条群消息都会触发）', async () => {
  let t = await mount(statusWithBinding())
  t = chatTree(t)
  toggleByText(t, '群聊仅响应 @机器人').props.onChange({ target: { checked: false } })
  harness.beginRender()
  t = renderCard()
  const texts = all(t).map(textOf).join('\n')
  assert.ok(texts.includes('建议同时开启'), `关掉 @门控 应提示配合意愿：${texts.slice(0, 200)}`)
})

console.log(`\nclient-im-test-button.test.mjs：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)
