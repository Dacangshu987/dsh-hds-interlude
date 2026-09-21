/**
 * 设置面板「读取预设」的接线验证。
 *
 * 覆盖：预设列表每行有「读取」按钮 → 点击后把该预设的 story 设定填回创作表单草稿
 * （不自动保存，用户点「保存」才生效），并且顶部 Tab 已改名「创作」。
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

const STORY_BOOK = {
  character: { name: '雨夜主角', profile: '便利店夜班', speech: '短句' },
  perspective: '冷静',
  world: { setting: '沿海小城', location: '便利店', supportingCast: '店长' },
  counterpart: { profile: '', initial: '陌生' },
  plot: { startingPoint: '某个雨夜', style: '日常', boundaries: '', keywords: [] },
}

function makeFetch(state) {
  const calls = []
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj })
  const fetchImpl = async (url, options = {}) => {
    const record = { url, options }
    calls.push(record)
    // 注意：`/presets`（复数，列表/保存）与 `/preset`（单数，读取）是不同端点，
    // 判断顺序必须先处理复数，否则 includes('/preset') 会误吞保存请求。
    if (url.includes('/presets') && options.method === 'PUT') {
      // 更新预设：记录 payload（id + 新 story）。
      const payload = JSON.parse(options.body ?? '{}')
      record.payload = payload
      const name = (state.presets ?? []).find(p => p.id === payload.id)?.name || '预设'
      return json({ ok: true, preset: { id: payload.id, name } })
    }
    if (url.includes('/presets') && options.method === 'POST') {
      // 新建预设：记录 payload（含草稿 story），并把新预设加进列表。
      const payload = JSON.parse(options.body ?? '{}')
      record.payload = payload
      const preset = { id: 'preset-hds-' + Math.random().toString(36).slice(2, 8), name: payload.name, description: '', createdAt: Date.now() }
      state.presets = [...(state.presets ?? []), preset]
      return json({ ok: true, preset })
    }
    if (url.includes('/presets')) {
      return json({ ok: true, presets: state.presets })
    }
    if (url.includes('/preset?')) {
      return json(state.presetResult)
    }
    if (url.includes('/status')) return json({ ok: true })
    if (!options.method || options.method === 'GET') {
      return json({ ok: true, value: state.config })
    }
    const payload = JSON.parse(options.body ?? '{}')
    record.payload = payload
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

/** 找到带 onDrop 且文本含指定文字的**最内层**节点（拖放方框）。 */
function findDropTarget(root, text) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return
    for (const child of node.children ?? []) walk(child)
    if (found) return
    if (typeof node.props?.onDrop === 'function' && collectText(node).includes(text)) found = node
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

async function mount(state) {
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
  const view = react.__install(Component)
  view.render()
  await sleep(60)
  return { view, calls }
}

async function goTab(view, label) {
  const btn = buttonByText(view.get(), label)
  assert.ok(btn, `找不到「${label}」Tab`)
  btn.props.onClick()
  view.render()
  await sleep(15)
  return view.get()
}

console.log('读取预设 + Tab 改名')

await check('顶部 Tab 已从「故事」改名为「创作」', async () => {
  const state = { config: {}, presets: [], presetResult: { ok: false, error: 'not found' } }
  const { view } = await mount(state)
  const tree = view.get()
  assert.ok(buttonByText(tree, '创作'), '应存在「创作」Tab')
  assert.ok(!buttonByText(tree, '故事'), '不应再有「故事」标签')
  assert.ok(buttonByText(tree, '节奏') && buttonByText(tree, '聊天') && buttonByText(tree, '预设/命令'), '其它 Tab 仍在')
  // 顶部说明行已删除：不应出现「四个分区」。
  assert.ok(!collectText(tree).includes('四个分区'), '顶部说明行应已删除')
})

await check('读取预设：创作页下拉选择预设 → 设定填回创作草稿', async () => {
  const state = {
    config: { timeZone: 'Asia/Shanghai', story: { character: { name: '旧主角', profile: '', speech: '' } } },
    presets: [{ id: 'preset-hds-abc', name: '雨夜来信', description: '', createdAt: 1 }],
    presetResult: { ok: true, story: STORY_BOOK },
  }
  const { view } = await mount(state)
  let tree = await goTab(view, '创作')

  // 创作页顶部应有「从预设载入」下拉，且预设 Tab 不再有「读取」按钮。
  const select = collectInputs(tree).find(i => i.tag === 'select')
  assert.ok(select, '创作页应有预设下拉')
  assert.equal(select.props.value, '', '默认未选中')
  const opts = (select.children ?? []).map(o => o.props?.value)
  assert.ok(opts.includes('preset-hds-abc'), '下拉应含已保存的预设')

  // 选中即读取。
  select.props.onChange({ target: { value: 'preset-hds-abc' } })
  await sleep(60)
  tree = view.get()

  const nameInput = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
  assert.ok(nameInput, '应找到主角名称输入框')
  assert.equal(nameInput.props.value, '雨夜主角', '预设的设定应填入草稿')
  const speechInput = collectInputs(tree).find(i => i.props?.placeholder === '说话风格与口头习惯。')
  assert.equal(speechInput.props.value, '短句', 'speech 也应填入')

  // 预设 Tab 不再有「读取」按钮（读取入口移到创作页）。
  const presetTab = await goTab(view, '预设/命令')
  assert.ok(!buttonByText(presetTab, '读取'), '预设页不应再有「读取」按钮')
  assert.ok(buttonByText(presetTab, '删除'), '预设页仍应有「删除」')
  // 机器人命令说明也在这页。
  assert.ok(collectText(presetTab).includes('/sessionlist'), '预设/命令页应有机器人命令说明')
})

await check('读取预设失败（读不到设定）→ 提示错误，不清空草稿', async () => {
  const state = {
    config: { timeZone: 'Asia/Shanghai', story: { character: { name: '旧主角', profile: '', speech: '' } } },
    presets: [{ id: 'preset-hds-xyz', name: '无快照', description: '', createdAt: 1 }],
    presetResult: { ok: false, error: '未找到该预设的设定' },
  }
  const { view } = await mount(state)
  let tree = await goTab(view, '创作')
  const select = collectInputs(tree).find(i => i.tag === 'select')
  select.props.onChange({ target: { value: 'preset-hds-xyz' } })
  await sleep(60)
  tree = view.get()
  const nameInput = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
  assert.equal(nameInput.props.value, '旧主角', '读取失败不应动草稿')
  assert.ok(collectText(tree).includes('读取预设失败'), '应提示失败原因')
})

await check('下拉含「＋ 新建预设」：选中后清空草稿，填写后再创建保存', async () => {
  const state = {
    config: { timeZone: 'Asia/Shanghai', story: { character: { name: '旧主角', profile: '', speech: '' } } },
    presets: [],
    presetResult: { ok: false, error: 'not found' },
  }
  const { view, calls } = await mount(state)
  let tree = await goTab(view, '创作')

  // 下拉应有「＋ 新建预设…」选项。
  const select = collectInputs(tree).find(i => i.tag === 'select')
  const optValues = (select.children ?? []).map(o => o.props?.value)
  assert.ok(optValues.includes('__new__'), '下拉应含「新建预设」选项')

  // 先编辑草稿（主角名称），再选中「＋ 新建预设」→ 草稿应被清空。
  const nameInput = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
  nameInput.props.onChange({ target: { value: '旧草稿角色' } })
  await sleep(15)
  tree = view.get()

  select.props.onChange({ target: { value: '__new__' } })
  await sleep(15)
  tree = view.get()
  const clearedName = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
  assert.equal(clearedName.props.value, '', '选择新建预设后草稿应被清空')

  // 从空白开始写新角色，再创建。
  clearedName.props.onChange({ target: { value: '新角色' } })
  await sleep(15)
  tree = view.get()

  const newNameInput = collectInputs(tree).find(i => i.props?.placeholder === '例如：雨夜来信')
  assert.ok(newNameInput, '选中新建后应出现名称输入框')
  newNameInput.props.onChange({ target: { value: '新角色预设' } })
  await sleep(15)
  tree = view.get()

  const createBtn = buttonByText(tree, '创建预设')
  assert.ok(createBtn, '应有「创建预设」按钮')
  createBtn.props.onClick()
  await sleep(60)

  const saveCall = calls.find(c => c.payload && c.payload.name === '新角色预设')
  assert.ok(saveCall, '应发出创建预设请求')
  assert.equal(saveCall.payload.story?.character?.name, '新角色', '应把（清空后新写的）草稿存进预设')
  assert.ok(collectText(view.get()).includes('已把当前草稿保存为预设'), '应提示保存成功')
})

/* ---------------------------------------------------------------- 导入 / 导出 */

// 导出依赖浏览器 API：注入最小 stub。
const downloads = []
URL.createObjectURL = (blob) => { downloads.push(blob); return 'blob:test' }
URL.revokeObjectURL = () => {}
globalThis.document = {
  createElement: () => ({ href: '', download: '', click() { downloads.push('download:' + this.download) }, remove() {} }),
  body: { appendChild() {} },
  getElementById: () => null,
}

function makeFakeFile(name, bytes, size) {
  return {
    name,
    size: size ?? bytes.byteLength ?? bytes.length,
    arrayBuffer: async () => (bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes),
  }
}

console.log('\n三、酒馆角色卡导入 / 导出')

{
  const state = {
    config: { timeZone: 'Asia/Shanghai', story: { character: { name: '旧主角', profile: '', speech: '' } } },
    presets: [],
    presetResult: { ok: false, error: 'not found' },
  }
  const { view, calls } = await mount(state)
  let tree = await goTab(view, '创作')

  await check('创作页有导出按钮与拖放导入方框', () => {
    assert.ok(buttonByText(tree, '导出 JSON 角色卡'), '应有导出按钮')
    const text = collectText(tree)
    assert.ok(text.includes('拖到这里'), '应有拖放方框文案')
    assert.ok(text.includes('导入 / 导出（兼容酒馆角色卡）'), '应有区块标题')
  })

  async function dropFile(viewRef, bytes, name) {
    const dropTarget = findDropTarget(viewRef.get(), '拖到这里')
    assert.ok(dropTarget, '应找到拖放方框')
    dropTarget.props.onDrop({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: { files: [makeFakeFile(name, bytes)] },
    })
    await sleep(60)
    return viewRef.get()
  }

  await check('拖入酒馆 JSON 卡 → 填入草稿并出现「导入为预设」确认条（默认角色名）', async () => {
    const card = {
      spec: 'chara_card_v2', spec_version: '2.0',
      data: { name: '苏念', description: '来自酒馆的角色。', personality: '温柔。', scenario: '初遇。' },
    }
    tree = await dropFile(view, new TextEncoder().encode(JSON.stringify(card)), 'sunian.tavern.json')
    const nameInput = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
    assert.equal(nameInput.props.value, '苏念', '主角名应来自导入卡')
    // 确认条：预设名输入框预填角色名。
    const presetName = collectInputs(tree).find(i => (i.props?.placeholder || '') === '' && i.props?.value === '苏念')
    assert.ok(presetName, '确认条应预填角色名')
    assert.ok(collectText(tree).includes('导入为预设'), '应显示确认条')
  })

  await check('点「导入并新建预设」→ 以角色名创建预设并选中', async () => {
    const btn = buttonByText(tree, '导入并新建预设')
    assert.ok(btn, '应有导入按钮')
    btn.props.onClick()
    await sleep(60)
    const postCall = calls.filter(c => c.payload && c.payload.name === '苏念').at(-1)
    assert.ok(postCall, '应 POST 创建名为「苏念」的预设')
    assert.equal(postCall.payload.story?.character?.name, '苏念', '预设 story 应为导入内容')
    assert.ok(collectText(view.get()).includes('已导入角色卡并新建预设「苏念」'), '应提示已新建预设')
  })

  await check('重名时默认名自动加 -2 后缀', async () => {
    // 已有同名「苏念」的预设 → 再导入同名角色 → 确认条默认名「苏念-2」。
    const { view: view2 } = await mount({
      config: { timeZone: 'Asia/Shanghai', story: { character: { name: 'x', profile: '', speech: '' } } },
      presets: [{ id: 'preset-hds-a', name: '苏念', description: '', createdAt: 1 }],
      presetResult: { ok: false, error: 'not found' },
    })
    let t2 = await goTab(view2, '创作')
    const card = { spec: 'chara_card_v2', data: { name: '苏念', description: '另一个' } }
    t2 = await dropFile(view2, new TextEncoder().encode(JSON.stringify(card)), 'sn.json')
    const presetName = collectInputs(t2).find(i => i.props?.value === '苏念-2')
    assert.ok(presetName, '重名应预填「苏念-2」')
  })

  await check('拖入 PNG 角色卡也能导入（同样出现确认条，默认角色名）', async () => {
    const { storyToTavernCard, buildPngCard } = await import('../lib/tavern-card.mjs')
    const png = buildPngCard(storyToTavernCard({
      character: { name: '阿澈', profile: 'png 角色', speech: '' },
    }))
    tree = await dropFile(view, new Uint8Array(png), 'ache.png')
    const nameInput = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
    assert.equal(nameInput.props.value, '阿澈', 'PNG 卡应导入主角名')
    const presetName = collectInputs(tree).find(i => (i.props?.placeholder || '') === '' && i.props?.value === '阿澈')
    assert.ok(presetName, 'PNG 导入应预填确认条预设名「阿澈」')
  })

  await check('非法文件 → 报错、不清空草稿', async () => {
    const bad = makeFakeFile('bad.json', new TextEncoder().encode('{"hello": 1}'))
    const dropTarget = findDropTarget(view.get(), '拖到这里')
    dropTarget.props.onDrop({
      preventDefault() {}, stopPropagation() {},
      dataTransfer: { files: [bad] },
    })
    await sleep(60)
    tree = view.get()
    const nameInput = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
    assert.equal(nameInput.props.value, '阿澈', '非法文件不应动草稿')
    assert.ok(collectText(tree).includes('导入失败'), '应提示失败')
  })

  await check('拖入 base64 编码的 JSON 卡也能导入（SillyTavern 部分分发形态）', async () => {
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '夜雨', description: 'base64 分发' } }
    const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64')
    tree = await dropFile(view, new TextEncoder().encode(b64), 'night.tavern.json')
    const nameInput = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
    assert.equal(nameInput.props.value, '夜雨', 'base64 JSON 卡应导入主角名')
  })

  await check('点「导出 JSON 角色卡」→ 触发下载（.tavern.json）', async () => {
    const btn = buttonByText(tree, '导出 JSON 角色卡')
    btn.props.onClick()
    await sleep(30)
    assert.ok(downloads.some(d => typeof d === 'string' && d.includes('.tavern.json')), '应触发文件下载')
    // setMessage 触发重渲染后，从 view 取最新树看提示。
    assert.ok(collectText(view.get()).includes('已导出酒馆角色卡'), '应提示导出成功')
  })
}

console.log('\n四、载入预设 → 修改 → 保存直接对该预设生效')

{
  const state = {
    config: { timeZone: 'Asia/Shanghai', story: { character: { name: '旧主角', profile: '', speech: '' } } },
    presets: [{ id: 'preset-hds-abc', name: '雨夜来信', description: '', createdAt: 1 }],
    // 读取该预设返回的 story（作为「载入」内容）。
    presetResult: { ok: true, story: { character: { name: '苏念', profile: '原设定', speech: '' } } },
  }
  const { view, calls } = await mount(state)
  let tree = await goTab(view, '创作')

  await check('载入预设 → 修改内容 → 点保存 → 发出 PUT 更新该预设', async () => {
    // 下拉选中预设 → 载入草稿。
    const select = collectInputs(tree).find(i => i.tag === 'select')
    select.props.onChange({ target: { value: 'preset-hds-abc' } })
    await sleep(60)
    tree = view.get()
    const nameInput = collectInputs(tree).find(i => i.props?.placeholder === '主角的称呼。')
    assert.equal(nameInput.props.value, '苏念', '应载入预设内容')

    // 修改主角名。
    nameInput.props.onChange({ target: { value: '改名苏念' } })
    await sleep(15)
    tree = view.get()

    // 保存 → 全局配置保存 + PUT 更新该预设。
    const save = buttonByText(tree, '保存')
    await save.props.onClick()
    await sleep(60)

    const putCall = calls.find(c => c.payload && c.payload.id === 'preset-hds-abc')
    assert.ok(putCall, '应发出 PUT 更新预设请求')
    assert.equal(putCall.payload.story?.character?.name, '改名苏念', '应把修改后的草稿写回预设')
    assert.ok(collectText(view.get()).includes('更新到预设「雨夜来信」'), '应提示已更新到预设')
  })

  await check('未载入预设时保存 → 不发 PUT', async () => {
    const { view: view2, calls: calls2 } = await mount({
      config: { timeZone: 'Asia/Shanghai', story: { character: { name: '旧主角', profile: '', speech: '' } } },
      presets: [],
      presetResult: { ok: false, error: 'not found' },
    })
    let t2 = await goTab(view2, '创作')
    const save = buttonByText(t2, '保存')
    await save.props.onClick()
    await sleep(60)
    assert.ok(!calls2.some(c => c.payload && c.payload.id), '没有选中预设就不该发 PUT')
  })
}

console.log('\n五、预设/命令页：预设管理（改名 / 删除，无保存新预设栏）')

{
  const state = {
    config: { timeZone: 'Asia/Shanghai', story: { character: { name: 'x', profile: '', speech: '' } } },
    presets: [{ id: 'preset-hds-a', name: '雨夜来信', description: '', createdAt: 1, updatedAt: 2 }],
    presetResult: { ok: false, error: 'not found' },
  }
  const { view, calls } = await mount(state)
  let tree = await goTab(view, '预设/命令')

  await check('预设管理：没有「保存当前设定为预设」栏；每行有改名/删除与更新时间', () => {
    assert.ok(!buttonByText(tree, '保存当前设定为预设'), '不应再有保存新预设的栏目')
    assert.ok(collectText(tree).includes('预设管理'), '应有预设管理标题')
    assert.ok(buttonByText(tree, '改名') && buttonByText(tree, '删除'), '每行应有改名与删除')
    assert.ok(collectText(tree).includes('更新于'), '应显示更新时间')
  })

  await check('点「改名」→ 输入新名 → 确定 → 发 PUT（只有 name，不动 story）', async () => {
    const rename = buttonByText(tree, '改名')
    assert.ok(rename, '应有改名按钮')
    rename.props.onClick()
    await sleep(15)
    tree = view.get()
    const inputs = collectInputs(tree).filter(i => i.props?.value === '雨夜来信')
    assert.ok(inputs.length >= 1, '重命名输入应预填当前名')
    inputs[0].props.onChange({ target: { value: '新名字' } })
    await sleep(15)
    tree = view.get()
    const okBtn = buttonByText(tree, '确定')
    assert.ok(okBtn, '应有确定按钮')
    okBtn.props.onClick()
    await sleep(60)
    const putCall = calls.find(c => c.payload && c.payload.id === 'preset-hds-a' && 'name' in c.payload && !('story' in c.payload))
    assert.ok(putCall, '应发重命名 PUT（只有 name、不带 story）')
    assert.equal(putCall.payload.name, '新名字')
  })
}

console.log(`\nclient-preset-load.test.mjs：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)
