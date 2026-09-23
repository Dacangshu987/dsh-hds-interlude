/**
 * 设置面板「多 QQ 机器人小卡片」的接线验证。
 *
 * 覆盖：
 *   - 每张卡片：别名 + AppID + ⚙（齿轮展开二级面板）；
 *   - 二级面板：AppID / 别名 / 会话存放工作区 / 角色预设下拉 / 投递目标 / 白名单；
 *   - **D-1**：保存送完整数组、逐字段显式（含 cwd / whitelist / agentPreset）；
 *   - **D-2**：删除 Bot 后保存，旧值不残留；
 *   - 向后兼容：只有顶层 appId 的旧配置读回合成单条。
 */
import { strict as assert } from 'node:assert'

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
      if (!(index in slots)) {
        slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = slots[index]
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        queueMicrotask(() => rerender?.())
      }
      return [slot.value, set]
    },
    useEffect(fn) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) { slots[index] = { ran: true, cleanup: fn?.() } }
      return () => {}
    },
    useRef(v) { const index = cursor; cursor += 1; slots[index] ??= { current: v }; return slots[index] },
    useMemo(fn) { const index = cursor; cursor += 1; if (!(index in slots)) slots[index] = { value: fn() }; return slots[index].value },
    useCallback(fn) { return fn },
    createElement(tag, props, ...children) {
      const merged = children.flat(Infinity).filter(c => c != null && c !== false)
      if (merged.length === 0 && props?.children != null) {
        merged.push(...[].concat(props.children))
      }
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
        throw new Error(`hook 数量变化：首次 ${firstHookCount}，本次 ${cursor}`)
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
    if (url.includes('/status')) return json({ ok: true, value: state.statusValue ?? { channel: { bots: [] } } })
    if (url.includes('/fs/list')) {
      const payload = JSON.parse(options.body ?? '{}')
      record.payload = payload
      const path = payload.path || 'C:/home'
      return json({
        ok: true, path, home: 'C:/home',
        entries: [{ name: 'bot-folder', path: 'C:/home/bot-folder', hidden: false }],
      })
    }
    if (url.includes('/presets') && options.method === 'POST') {
      const payload = JSON.parse(options.body ?? '{}')
      record.payload = payload
      state.presets ??= []
      return json({ ok: true, preset: { id: 'preset-hds-new', name: payload.name } })
    }
    if (url.includes('/presets')) return json({ ok: true, presets: state.presets ?? [] })
    if (url.includes('/preset?')) return json(state.presetResult ?? { ok: false, error: 'not found' })
    if (!options.method || options.method === 'GET') {
      return json({ ok: true, value: state.config })
    }
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

function inputByPlaceholder(root, placeholder) {
  return collectInputs(root).find(i => i.props?.placeholder === placeholder)
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

/** 按文本包含查找 button（资源管理器文件夹格子是「图标 + 名称」两行，无法精确匹配）。 */
function buttonWithText(root, text) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    if (node.tag === 'button' && collectText(node).includes(text)) { found = node; return }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return found
}

function findText(root, text) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    if (collectText(node).includes(text)) { found = node; return }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return found
}

/** 子树里是否存在文本含指定文字的 button。 */
function hasButtonWithText(root, text) {
  let yes = false
  const walk = (node) => {
    if (!node || typeof node !== 'object' || yes) return
    if (node.tag === 'button' && collectText(node).includes(text)) { yes = true; return }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return yes
}

/** 统计子树里文本含指定文字的 button 数量。 */
function countButtonsWithText(root, text) {
  let count = 0
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.tag === 'button' && collectText(node).includes(text)) count += 1
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return count
}

/** 找到包含指定文本、且恰好一个 checkbox 的最内层节点里的 checkbox。 */
function checkboxInRow(root, labelText) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    for (const child of node.children ?? []) walk(child)
    if (found) return
    if (collectText(node).includes(labelText)) {
      const cbs = collectInputs(node).filter(i => i.props?.type === 'checkbox')
      if (cbs.length === 1) found = cbs[0]
    }
  }
  walk(root)
  return found
}

/** 找到包含指定文本、且带 ⚙ 按钮的**最内层**卡片节点（某张机器人卡片头）。 */
function findCardWith(root, label) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    // 先深入子节点，再检查自己：保证命中「最内层」含 label + ⚙ 的卡片头，
    // 而不是外层把整张卡片/整页都包住的大节点。
    for (const child of node.children ?? []) walk(child)
    if (found) return
    if (hasButtonWithText(node, '⚙') && collectText(node).includes(label)) found = node
  }
  walk(root)
  return found
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`) }
  catch (error) { failed += 1; console.error(`  ✗ ${label}\n      ${error.message}`) }
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}

async function mount(state, extraCtx = {}) {
  const { fetchImpl, calls } = makeFetch(state)
  globalThis.fetch = fetchImpl
  const react = makeReact()
  const mod = factory((spec) => { if (spec === 'react') return react; throw new Error('unexpected: ' + spec) })
  let Component = null
  mod.apply(Object.assign({
    slots: {
      inject: (slot, fn) => fn(),
      register: (reg, C) => { Component = C; return reg },
    },
  }, extraCtx))
  const view = react.__install(Component)
  view.render()
  await sleep(60)
  return { view, calls }
}

async function goChat(view) {
  const btn = buttonByText(view.get(), '聊天')
  assert.ok(btn, '找不到「聊天」Tab')
  btn.props.onClick()
  view.render()
  await sleep(15)
  return view.get()
}

async function rerender(view) {
  await sleep(15)
  view.render()
  return view.get()
}

/** 展开指定别名/名字的机器人卡片（点最右的 ⚙）。 */
async function expandBot(view, tree, label) {
  const card = findCardWith(tree, label)
  assert.ok(card, `找不到卡片「${label}」`)
  const gear = buttonByText(card, '⚙')
  assert.ok(gear, `卡片「${label}」应有 ⚙`)
  gear.props.onClick()
  return rerender(view)
}

console.log('一、多 Bot 小卡片：别名 + 状态 + 齿轮二级面板')

{
  const state = {
    config: {
      timeZone: 'Asia/Shanghai',
      im: {
        autoMessage: true, messageIntervalMinutes: 120, enabled: true,
        bots: [
          { botId: 'qq_a', appId: '1900000001', secretRef: 'DSH_QQBOT_APP_SECRET_A', alias: '一号' },
          { botId: 'qq_b', appId: '1900000002', secretRef: 'DSH_QQBOT_APP_SECRET_B', alias: '二号' },
        ],
      },
    },
    presets: [{ id: 'preset-hds-su', name: '苏念', description: '', createdAt: 1 }],
  }
  const { view, calls } = await mount(state)
  let tree = await goChat(view)

  await check('两个 Bot 各渲染成小卡片（别名 + AppID 遮罩 + ⚙）', () => {
    assert.ok(findCardWith(tree, '一号'), 'bot1 卡片（别名「一号」）')
    assert.ok(findCardWith(tree, '二号'), 'bot2 卡片（别名「二号」）')
    const text = collectText(tree)
    assert.ok(text.includes('AppID 1900000001'), 'bot1 卡片头应带 AppID')
    assert.ok(text.includes('AppID 1900000002'), 'bot2 卡片头应带 AppID')
    assert.equal(countButtonsWithText(tree, '⚙'), 2, '每张卡片一个 ⚙')
  })

  await check('展开 bot1 的二级面板：AppID/别名/工作区选择/角色预设下拉/投递目标/白名单都在', async () => {
    tree = await expandBot(view, tree, '一号')
    const appId = inputByPlaceholder(tree, '例如 1905583221')
    assert.ok(appId, '应找到 AppID 输入框')
    eq(appId.props.value, '1900000001', 'AppID 应读回')
    // 工作区改为目录选择器：只有「选择…」按钮 + 只读显示，没有文本输入框。
    const pickBtn = buttonByText(tree, '选择…')
    assert.ok(pickBtn, '应有工作区「选择…」按钮')
    assert.ok(!inputByPlaceholder(tree, '留空 = 继承全局'), '工作区不该再用文本输入')
    const presetSelect = collectInputs(tree).find(i => i.tag === 'select' && (i.children ?? []).some(o => o.props?.value === 'preset-hds-su'))
    assert.ok(presetSelect, '角色预设下拉应含已保存的预设')
    assert.ok(collectText(tree).includes('投递目标'), '应有投递目标区')
    assert.ok(collectText(tree).includes('暂无绑定'), '无绑定时提示自动绑定')
    const wl = collectInputs(tree).find(i => i.tag === 'textarea' && (i.props?.placeholder || '').includes('不限制'))
    assert.ok(wl, '应有白名单输入框')
    // Bot 标识 / secretRef 只读行已按需求移除。
    assert.ok(!collectInputs(tree).some(i => i.props?.disabled === true), '不再显示 botId/secretRef 只读输入')
  })

  await check('目录选择器：点「选择…」→ 浏览目录 → 「选择此目录」写入 bot.cwd', async () => {
    const pickBtn = buttonByText(tree, '选择…')
    assert.ok(pickBtn, '应有「选择…」')
    pickBtn.props.onClick()
    await sleep(15)
    tree = view.get()
    // 选择面板：路径输入 + 子目录 + 选择此目录。
    assert.ok(collectText(tree).includes('主目录'), '应有主目录入口')
    assert.ok(collectText(tree).includes('bot-folder'), '应列出子目录')
    const choose = buttonByText(tree, '选择此目录')
    assert.ok(choose, '应有「选择此目录」')
    choose.props.onClick()
    await sleep(15)
    tree = view.get()
    // 写入后显示所选路径（不再有选择面板）。
    assert.ok(collectText(tree).includes('C:/home'), '应显示所选工作区路径')
    assert.ok(!buttonByText(tree, '选择此目录'), '选定后选择面板应关闭')
  })

  await check('机器人命令开关：默认开；关闭后保存写进 bots[0].botCommands=false', async () => {
    // 「启用机器人命令」那一行恰好一个 checkbox。
    const cmdCheckbox = checkboxInRow(tree, '启用机器人命令')
    assert.ok(cmdCheckbox, '应有机器人命令开关')
    assert.equal(cmdCheckbox.props.checked, true, '默认开')
    cmdCheckbox.props.onChange({ target: { checked: false } })
    tree = await rerender(view)
    const save = buttonByText(tree, '保存')
    await save.props.onClick()
    await sleep(60)
    const call = calls.filter(c => c.payload).at(-1)
    const im = call.payload?.value?.im ?? call.payload?.im
    eq(im.bots[0].botCommands, false, '关闭后应写入 false')
  })

  await check('给第一个机器人选角色预设 → 保存后写进 bots[0].agentPreset', async () => {
    const presetSelect = collectInputs(tree).find(i => i.tag === 'select' && (i.children ?? []).some(o => o.props?.value === 'preset-hds-su'))
    presetSelect.props.onChange({ target: { value: 'preset-hds-su' } })
    tree = await rerender(view)

    const save = buttonByText(tree, '保存')
    await save.props.onClick()
    await sleep(60)
    const call = calls.filter(c => c.payload).at(-1)
    const im = call.payload?.value?.im ?? call.payload?.im
    eq(im.bots[0].agentPreset, 'preset-hds-su', 'bot1 的角色预设应写入')
  })

  await check('添加机器人 → 出现第三张卡片', async () => {
    const add = buttonByText(tree, '+ 添加机器人')
    assert.ok(add, '应有「+ 添加机器人」')
    add.props.onClick()
    tree = await rerender(view)
    assert.ok(findText(tree, '未命名'), '新卡片应显示「未命名」')
  })

  await check('保存 → payload.im.bots 完整数组，逐字段显式（D-1）', async () => {
    const save = buttonByText(tree, '保存')
    await save.props.onClick()
    await sleep(60)
    const call = calls.filter(c => c.payload).at(-1)
    const im = call.payload?.value?.im ?? call.payload?.im
    assert.ok(Array.isArray(im.bots), 'im.bots 应是数组')
    eq(im.bots.length, 3, '应有三条')
    for (let i = 0; i < im.bots.length; i += 1) {
      const b = im.bots[i]
      assert.equal(typeof b.botId, 'string', `bots[${i}].botId 应为字符串`)
      assert.equal(typeof b.appId, 'string', `bots[${i}].appId 应为字符串`)
      assert.equal(typeof b.secretRef, 'string', `bots[${i}].secretRef 应为字符串`)
      assert.equal(typeof b.alias, 'string', `bots[${i}].alias 应为字符串（空串也显式送）`)
      assert.equal(typeof b.agentPreset, 'string', `bots[${i}].agentPreset 应为字符串`)
      assert.equal(typeof b.cwd, 'string', `bots[${i}].cwd 应为字符串（空串也显式送）`)
      assert.ok(Array.isArray(b.whitelist), `bots[${i}].whitelist 应为数组`)
    }
    eq(im.bots[0].appId, '1900000001', 'bot1 appId 保留')
    eq(im.bots[1].appId, '1900000002', 'bot2 appId 保留')
    eq(im.bots[2].appId, '', '新增行 appId 空串')
    eq(im.appId, '1900000001', '顶层 appId 与 bot1 同步')
  })

  await check('删除第二个机器人 → 保存后只剩两条，旧值不残留（D-2）', async () => {
    tree = await expandBot(view, tree, '二号')
    const del = buttonByText(tree, '删除机器人')
    assert.ok(del, '二级面板应有「删除机器人」')
    del.props.onClick()
    tree = await rerender(view)
    assert.ok(!findText(tree, '二号'), 'bot2 卡片应消失')
    assert.ok(findText(tree, '一号'), 'bot1 卡片仍在')

    const save = buttonByText(tree, '保存')
    await save.props.onClick()
    await sleep(60)
    const call = calls.filter(c => c.payload).at(-1)
    const im = call.payload?.value?.im ?? call.payload?.im
    eq(im.bots.length, 2, '应只剩两条')
    assert.ok(!im.bots.some(b => b.appId === '1900000002'), '被删的 bot 不残留')
  })
}

console.log('\n二、单 Bot 旧配置向后兼容（顶层 appId → bots 合成）')

{
  const state = {
    config: {
      timeZone: 'Asia/Shanghai',
      im: { autoMessage: true, messageIntervalMinutes: 120, enabled: true, appId: '1905583221', botId: 'qq', secretRef: 'DSH_QQBOT_APP_SECRET' },
    },
    presets: [],
  }
  const { view, calls } = await mount(state)
  let tree = await goChat(view)

  await check('没有 bots 时读回合成单条（AppID 从顶层来，在二级面板里）', async () => {
    tree = await expandBot(view, tree, 'qq')
    const input = inputByPlaceholder(tree, '例如 1905583221')
    assert.ok(input, '应找到 AppID 输入框')
    eq(input.props.value, '1905583221', 'AppID 应读回顶层值')
  })

  await check('保存后写回 bots: [合成单条] 且顶层字段同步（向后兼容）', async () => {
    const save = buttonByText(tree, '保存')
    await save.props.onClick()
    await sleep(60)
    const call = calls.find(c => c.payload)
    const im = call.payload?.value?.im ?? call.payload?.im
    assert.ok(Array.isArray(im.bots), '应写 bots 数组')
    eq(im.bots.length, 1, '单条')
    eq(im.bots[0].appId, '1905583221', 'bot.appId 保留')
    eq(im.bots[0].botId, 'qq', 'bot.botId 保留')
    eq(im.bots[0].secretRef, 'DSH_QQBOT_APP_SECRET', 'bot.secretRef 保留')
    eq(im.appId, '1905583221', '顶层 appId 同步')
    eq(im.botId, 'qq', '顶层 botId 同步')
  })
}

console.log('\n三、状态点：出错时卡片与二级面板都显示原因（含对象错误规整）')

{
  const state = {
    config: {
      timeZone: 'Asia/Shanghai',
      im: { enabled: true, autoMessage: true, messageIntervalMinutes: 120, bots: [{ botId: 'qq_a', appId: '1900000001', secretRef: 'S', alias: '一号' }] },
    },
    presets: [],
    // lastError 是**对象**（errorsByBot 曾以 {at, error} 存储）——前端必须规整成
    // 字符串，否则会显示「[object Object]」（线上症状）。
    statusValue: {
      channel: {
        bots: [{ botId: 'qq_a', alias: '', appId: '1900000001', started: false, ready: false, lastError: { error: '无法解析 AppSecret（bot qq_a）' } }],
      },
    },
  }
  const { view } = await mount(state)
  let tree = await goChat(view)

  await check('出错的 bot：卡片头显示「· 出错」红字', () => {
    const card = findCardWith(tree, '一号')
    assert.ok(card, '应找到卡片')
    assert.ok(collectText(card).includes('· 出错'), '应显示出错状态文本')
  })

  await check('二级面板顶部直接列出连接异常原因（对象 lastError 被规整为文本）', async () => {
    tree = await expandBot(view, tree, '一号')
    assert.ok(!collectText(tree).includes('[object Object]'), '不该显示 [object Object]')
    assert.ok(collectText(tree).includes('连接异常：无法解析 AppSecret'), '应显示具体原因文本')
  })
}

console.log('\n四、工作区目录选择器：系统选择器优先，无则回退浏览')

{
  const state = {
    config: {
      timeZone: 'Asia/Shanghai',
      im: { enabled: true, autoMessage: true, messageIntervalMinutes: 120, bots: [{ botId: 'qq_a', appId: '1900000001', secretRef: 'S', alias: '一号' }] },
    },
    presets: [],
  }
  // 注入 DSH 的 workspaces（模拟宿主提供目录选择能力）→ pickerApi 优先。
  const ctx = {
    workspaces: {
      pickDirectory: async () => 'C:/picked-by-system',
      listDirectory: async () => ({ path: 'C:/', home: 'C:/', entries: [] }),
    },
  }
  const { view } = await mount(state, ctx)
  let tree = await goChat(view)
  tree = await expandBot(view, tree, '一号')

  await check('有系统选择器时：点「选择…」直接调用 pickDirectory 并写入路径', async () => {
    const pickBtn = buttonByText(tree, '选择…')
    assert.ok(pickBtn, '应有「选择…」')
    pickBtn.props.onClick()
    await sleep(15)
    tree = view.get()
    assert.ok(collectText(tree).includes('C:/picked-by-system'), '应显示系统选择器返回的路径')
    assert.ok(!buttonByText(tree, '选择此目录'), '走了系统选择器，不该出现自建浏览面板')
  })
}

console.log('\n五、全局默认工作区也用目录选择器（弹窗）')

{
  const state = {
    config: {
      timeZone: 'Asia/Shanghai',
      im: { enabled: true, autoMessage: true, messageIntervalMinutes: 120, bots: [{ botId: 'qq_a', appId: '1900000001', secretRef: 'S', alias: '一号' }] },
    },
    presets: [],
  }
  // 无系统选择器（pickerApi 为 null）→ 回退自建 fs/list 弹窗。
  const { view } = await mount(state)
  let tree = await goChat(view)

  await check('点全局「选择…」→ 弹出目录选择弹窗 → 选目录写入全局 im.cwd', async () => {
    const pickBtn = buttonByText(tree, '选择…')
    assert.ok(pickBtn, '全局工作区应有「选择…」')
    pickBtn.props.onClick()
    await sleep(15)
    tree = view.get()
    assert.ok(collectText(tree).includes('选择工作区目录'), '应弹出目录选择弹窗')
    const folder = buttonWithText(tree, 'bot-folder')
    assert.ok(folder, '弹窗应列出子目录')
    folder.props.onClick()
    await sleep(15)
    tree = view.get()
    const choose = buttonByText(tree, '选择此目录')
    assert.ok(choose, '应有「选择此目录」')
    choose.props.onClick()
    await sleep(15)
    tree = view.get()
    assert.ok(collectText(tree).includes('C:/home/bot-folder'), '全局工作区应显示所选路径')
    assert.ok(!buttonByText(tree, '选择工作区目录'), '选择后弹窗应关闭')
  })
}

console.log('\n六、全局默认角色预设下拉')

{
  const state = {
    config: {
      timeZone: 'Asia/Shanghai',
      im: { enabled: true, autoMessage: true, messageIntervalMinutes: 120, bots: [{ botId: 'qq_a', appId: '1900000001', secretRef: 'S', alias: '一号' }] },
    },
    presets: [{ id: 'preset-hds-su', name: '苏念', description: '', createdAt: 1 }],
  }
  const { view, calls } = await mount(state)
  let tree = await goChat(view)

  await check('全局默认角色预设是下拉，选项含已保存预设，默认留空', () => {
    const globalSelect = collectInputs(tree).find(i => i.tag === 'select'
      && (i.children ?? []).some(o => o.props?.value === 'preset-hds-su'))
    assert.ok(globalSelect, '应找到全局角色预设下拉（含已保存预设）')
    assert.equal(globalSelect.props.value, '', '默认留空')
  })

  await check('选择预设 → 保存后写进 im.agentPreset', async () => {
    const globalSelect = collectInputs(tree).find(i => i.tag === 'select'
      && (i.children ?? []).some(o => o.props?.value === 'preset-hds-su'))
    globalSelect.props.onChange({ target: { value: 'preset-hds-su' } })
    await sleep(15)
    tree = view.get()
    const save = buttonByText(tree, '保存')
    await save.props.onClick()
    await sleep(60)
    const call = calls.find(c => c.payload)
    const im = call.payload?.value?.im ?? call.payload?.im
    assert.equal(im.agentPreset, 'preset-hds-su', '全局预设应写入 im.agentPreset')
  })
}

console.log(`\nclient-multibot.test.mjs：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)