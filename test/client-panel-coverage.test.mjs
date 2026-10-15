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
import fs from 'node:fs'
import { Config as ConfigSchema } from '../lib/schema.js'
import { panelDescriptor, mergeInto, PANEL_HIDDEN } from '../lib/panel-schema.js'

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
    // 面板描述符：服务端算好的 schema 投影（面板据此自动生成标准段）。
    if (url.includes('/panel-schema')) return json({ ok: true, value: panelDescriptor(ConfigSchema) })
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
    // 可配置提示词（对齐上游 rc50 四层结构）：非空值，用来验证面板确实读对了路径。
    mainPrompt: '主体叙事自定义',
    formatPrompt: '格式附加自定义',
    fixedPrompt: '固定指令自定义',
    stylePrompt: '文风自定义',
    // 剧本起点（对齐上游 StoryDefaults）：含两个上游新增的多条目字段。
    story: {
      character: { name: '江柚', profile: '设计师', speech: '爱用短句' },
      perspective: '单条价值观',
      perspectives: ['第一条独立价值观', '第二条独立价值观'],
      supplementaryFacts: ['她怕黑', '左耳有点背'],
      world: { setting: '2026 年杭州', location: '城西', supportingCast: '小鹿：同事' },
      counterpart: { profile: '老同学', initial: '熟悉但近来联系不多' },
      plot: { startingPoint: '刚搬完家', style: '克制写实', boundaries: '不提系统', keywords: ['加班'] },
    },
    im: {
      enabled: true,
      group: {
        willingnessPreset: 'auto',
        willingnessAuto: { busy: 'reserved', idle: 'eager', asleep: 'quiet' },
      },
      chunking: {
        // 气泡边界协议（对齐上游 rc36）：刻意用非默认值。
        splitReplyMessages: false,
        messageSeparator: '||',
        convertNewlineToSeparator: true,
        typingBaseDelaySeconds: 2,
        typingCharactersPerSecond: 12,
        typingMaxDelaySeconds: 8,
        typingJitterRatio: 0.1,
      },
      // 表情清单上限（对齐上游 Stickers 段）：刻意用非默认值。
      catalogLimit: 25,
      maxFileSizeMB: 7,
      // 原生表情结构化通道（对齐上游 ChatActions 段）：刻意用非默认值。
      allowedNativeFaces: ['smile', 'angry'],
      expressionThreshold: 0.55,
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
      // 节奏旋钮（对齐上游 rc50）：刻意用非默认值。
      conversationFollowUpMinutes: [5, 15],
      conversationFollowUpJitterMinutes: 3,
      minimumAdvanceMinutes: 45,
    },
    proactive: { duringSleep: true, duringSleepPromises: false },
    // 长线叙事催化器（实验，对齐上游 longHorizon 段）：刻意用非默认值。
    longHorizon: { enabled: true, triggerScore: 60, reviewIncrement: 120, intensity: 'moderate' },
    // 日志内容脱敏（对齐上游 Logging 段）：两个隐私开关**刻意打开**非默认值，
    // 这样面板读错（比如默认成 false）就会露馅。
    // 日志段已改由**生成式渲染**（内嵌在维护段里），读取的是**规范路径**
    // `logging.level`；夹具绕过插件路由的别名归一化，所以这里写规范路径。
    // 顶层 `logLevel`（旧别名）仍保留——面板还会写它，且 546 行那条断言钉着它。
    logging: { level: 'warn', verbosity: 'diagnostic', logScriptPreview: true, logMessageContent: true, previewLength: 1200 },
    // 失明模式（对齐上游 BlindMode）：刻意用非默认值（关卡 + 非默认间隔）。
    blindMode: { enabled: true, healthReportMinutes: 25 },
    // 运行时天气（生成式渲染的第一块）：刻意用**非默认值**——只断言「字段存在」
    // 抓不到路径写错那类 bug，必须断言**值**（盲区模式那块就是这么抓到的）。
    weather: {
      enabled: true, latitude: 31.23, longitude: 121.47,
      autoFromLocation: false, skipFantasyWorld: true, cadenceMinutes: 45,
    },
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

/* ─────────────────── A0. 创作页：剧本起点（对齐上游 StoryDefaults） ─────────────────── */

const storyTab = goTab('创作')
check('创作页读回旧嵌套形态的故事字段', () => {
  eq(controlNearLabel(storyTab, '主角名称').props.value, '江柚', 'character.name')
  eq(controlNearLabel(storyTab, '说话风格').props.value, '爱用短句', 'character.speech（本仓专有）')
  eq(controlNearLabel(storyTab, '世界设定').props.value, '2026 年杭州', 'world.setting')
  eq(controlNearLabel(storyTab, '当前故事文风').props.value, '克制写实', 'plot.style')
})

check('创作页有上游两个多条目字段，且按行读回（rc50 StoryDefaults）', () => {
  // perspectives 在「角色」组、supplementaryFacts 在「世界」组；都是每行一条。
  eq(
    controlNearLabel(storyTab, '价值观·多条独立条目').props.value,
    '第一条独立价值观\n第二条独立价值观',
    'perspectives 应按行读回',
  )
  eq(
    controlNearLabel(storyTab, '补充事实').props.value,
    '她怕黑\n左耳有点背',
    'supplementaryFacts 应按行读回',
  )
})

/* ─────────────────── A. 聊天页：打字节奏（与分条同段） ─────────────────── */

const chat = openAdvanced(goTab('聊天'))
check('聊天页有打字节奏四项，且读回配置里的值（rc21）', () => {
  eq(controlNearLabel(chat, '打字基础等待').props.value, 2, '基础等待')
  eq(controlNearLabel(chat, '打字速度').props.value, 12, '字/秒')
  eq(controlNearLabel(chat, '单条最长等待').props.value, 8, '最长等待')
  eq(controlNearLabel(chat, '等待的随机浮动').props.value, 0.1, '抖动')
})

check('聊天页有气泡边界协议三项，且读回配置里的值（rc36）', () => {
  // 分条开关：夹具里是 false（关闭），所以复选框应为未勾选。
  eq(checkboxNear(chat, '允许分条发送').props.checked, false, 'splitReplyMessages=false')
  eq(controlNearLabel(chat, '气泡分隔符').props.value, '||', '自定义分隔符')
  eq(checkboxNear(chat, '换行也当分条边界').props.checked, true, 'convertNewlineToSeparator=true')
})

check('聊天页有表情清单两个上限，且读回配置里的值（Stickers 段）', () => {
  const inputs = controlsNearLabel(chat, '表情包清单上限')
  eq(inputs.length, 2, '应当是「条数 + 体积」两个输入')
  eq(Number(inputs[0].props.value), 25, 'catalogLimit')
  eq(Number(inputs[1].props.value), 7, 'maxFileSizeMB')
})

check('节奏页有对话后续补写与手动推进下限，且读回配置里的值（rc50）', () => {
  const rhythm = goTab('节奏')
  // 三个字段此前**只在 schema 与逻辑里生效，没上面板**——用户在界面上配不了。
  eq(controlNearLabel(rhythm, '对话后续补写').props.value, '5, 15', '分钟列表按逗号分隔读回')
  eq(Number(controlNearLabel(rhythm, '补写时间随机浮动').props.value), 3, 'jitter')
  eq(Number(controlNearLabel(rhythm, '手动推进下限').props.value), 45, 'minimumAdvanceMinutes')
})

check('聊天页有原生表情结构化通道，且读回配置里的值（ChatActions 段）', () => {
  // 白名单是八个语义复选框：夹具里只勾了 smile 与 angry。
  const boxes = collectInputs(chat).filter(i => i.tag === 'input' && i.props?.type === 'checkbox')
  const checked = boxes.filter(i => i.props.checked).length
  assert.ok(checked >= 2, `夹具里至少勾了两个语义，实际勾了 ${checked} 个`)
  // 阈值读回。
  eq(Number(controlNearLabel(chat, '发原生表情的最低表达意愿').props.value), 0.55, 'expressionThreshold')
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

check('生成式渲染：长线叙事（自动生成）断言**值**，且无效字段**不被画出来**', () => {
  // 这一段已迁移到生成式渲染。两件事一起验：
  //  ① 断言**值**（不只是存在）——路径写错会红；
  //  ② 断言 `privateWeight` / `groupWeight` **没有**被渲染——它们在 schema 里只为
  //     读取旧配置而存在（实际权重固定 1.0 / 0.5），由服务端 PANEL_HIDDEN 挡掉。
  //     画出来就是假开关，而这正是本次搬迁要消灭的东西。
  const tab = goTab('扩展')
  const text = collectText(tab)
  assert.ok(text.includes('长线叙事【扩展 16】'), `应有自动生成的长线叙事段：${text.slice(0, 240)}`)
  eq(checkboxNear(tab, '启用长线叙事催化器').props.checked, true, '开关应读回 true')
  eq(Number(controlNearLabel(tab, '加权分数门槛').props.value), 60, 'triggerScore 应读回 60')
  eq(Number(controlNearLabel(tab, '积累多少分').props.value), 120, 'reviewIncrement 应读回 120')
  // 隐藏字段必须一个都不出现（连说明文字都不该在）。
  assert.ok(!text.includes('实际固定为 1.0'), 'privateWeight 不该被渲染（假开关）')
  assert.ok(!text.includes('兼容旧配置'), '权重兼容项不该被渲染')
})

check('扩展页有日志内容脱敏两项（对齐上游 Logging），且读回配置值', () => {
  // 夹具里两个隐私开关**都显式打开**——面板读错（例如把「默认关」写成默认开、
  // 或把 === true 写成 !== false）都会在这里露馅。
  // 该段已改为**内嵌生成式渲染**：标签来自 schema 描述，不再是手写文案。
  eq(checkboxNear(advanced, '是否输出本轮剧本内容').props.checked, true, 'logScriptPreview')
  eq(checkboxNear(advanced, '是否输出用户消息与主角可见消息内容').props.checked, true, 'logMessageContent')
  eq(controlNearLabel(advanced, '最大字符数').props.value, 1200, 'previewLength')
  eq(controlNearLabel(advanced, '运行信息密度').props.value, 'diagnostic', 'verbosity')
})

check('扩展页有失明模式（对齐上游 BlindMode），且读回配置值', () => {
  // 这一段已**迁移到生成式渲染**（2b 的第二块）：控件由服务端描述符画出，
  // 所以标签不再是手写文案，而是 **schema 里的 description**——这正是
  // 「面板与 schema 不再漂移」的体现：改 schema 的说明文字，界面跟着变。
  eq(checkboxNear(advanced, '启用沉浸运行').props.checked, true, '开关读回')
  eq(Number(controlNearLabel(advanced, '健康心跳间隔').props.value), 25, 'healthReportMinutes')
})
check('扩展页有世界事件播种器（rc23）并读回配置值', () => {
  // 该段已迁移到生成式渲染：标签来自 **schema 描述**，不再是手写文案。
  const cb = checkboxNear(advanced, '启用世界事件播种器')
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

check('扩展页有提示词四层（对齐上游 rc50）：四个字段读回配置值', () => {
  // 上游把提示词做成 Schema 字段并明确权限分层；本仓面板按同一结构暴露。
  eq(controlNearLabel(advanced, '主体叙事提示词（mainPrompt）').props.value, '主体叙事自定义', 'mainPrompt')
  eq(controlNearLabel(advanced, '输出格式附加说明（formatPrompt）').props.value, '格式附加自定义', 'formatPrompt')
  eq(controlNearLabel(advanced, '附加固定指令（fixedPrompt）').props.value, '固定指令自定义', 'fixedPrompt')
  eq(controlNearLabel(advanced, '文风（stylePrompt）').props.value, '文风自定义', 'stylePrompt')
})

check('扩展页有维护段（记忆窗口 / 休息时段 / 日志）并读回配置值', () => {
  eq(controlNearLabel(advanced, '历史上下文条数闸').props.value, 35, '条数闸')
  eq(controlNearLabel(advanced, '历史上下文时间窗').props.value, 45, '时间窗')
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
// 扩展页：改一个**数组字段**（拉黑名单）。必须真的编辑它——只断言播种结果是不够的：
// 不编辑就不会触发 onChange 里的数组转换（我第一版断言就是这样，证伪时没红）。
current = await setValue(controlNearLabel(current, '拉黑名单'), '小鹿, 老王')
current = await setValue(controlNearLabel(current, '模型名（用于自动推断）'), 'claude-sonnet')
// 聊天页：改跨群每轮上限
current = await setValue(controlNearLabel(goTab('聊天'), '每轮最多几次'), '3')
// 扩展页：改休息时段（两行 → 解析成两个窗口）
current = await setValue(controlNearLabel(goTab('扩展'), '休息时段'), '23:00-07:00\n13:00-14:00')
// 扩展页：改提示词四层（对齐上游 rc50）
current = await setValue(controlNearLabel(goTab('扩展'), '主体叙事提示词（mainPrompt）'), '新的主体叙事')
current = await setValue(controlNearLabel(current, '文风（stylePrompt）'), '新的文风')
// 创作页：把 perspectives 清空（验「送空数组」，否则深合并会把旧条目留下）
current = await setValue(controlNearLabel(goTab('创作'), '价值观·多条独立条目'), '')
// 节奏页：把对话后续补写列表清空（同样要送 []，= 关闭该回路）
current = await setValue(controlNearLabel(goTab('节奏'), '对话后续补写'), '')

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
    // 清空的多条目字段必须显式送 []（漏送 → 深合并把旧条目留下 → 用户「删不掉」）。
    // 键名已按上游改为 storyDefaults。
    eq(value.storyDefaults?.perspectives, [], 'storyDefaults.perspectives 清空后应送 []')
    // 没动过的那个照旧带上。
    eq(value.storyDefaults?.supplementaryFacts, ['她怕黑', '左耳有点背'], 'storyDefaults.supplementaryFacts')
    // 节奏：清空的补写列表也送 []（= 关闭该回路），没动的两项保持原值。
    eq(value.runtime?.conversationFollowUpMinutes, [], 'runtime.conversationFollowUpMinutes 清空后应送 []')
    eq(value.runtime?.conversationFollowUpJitterMinutes, 3, '未被漏写')
    eq(value.runtime?.minimumAdvanceMinutes, 45, '未被漏写')
  })
  check('未改动的相关字段仍在（没有被面板漏写而丢失）', () => {
    eq(value.im?.forwardLimits?.maxDepth, 1, 'im.forwardLimits.maxDepth')
    eq(value.im?.group?.willingnessPreset, 'auto', 'im.group.willingnessPreset')
    eq(value.im?.group?.willingnessAuto?.idle, 'eager', 'willingnessAuto.idle')
    // 气泡边界协议三项没改过，必须原样保留（面板漏写会把它们悄悄重置成默认值）。
    eq(value.im?.chunking?.splitReplyMessages, false, 'splitReplyMessages 未被漏写')
    eq(value.im?.chunking?.messageSeparator, '||', 'messageSeparator 未被漏写')
    eq(value.im?.chunking?.convertNewlineToSeparator, true, 'convertNewlineToSeparator 未被漏写')
    // 注意：blockedNames 本轮被**刻意编辑过**（验证数组类型往返），
    // 所以它在这里不是「未改动」那一类，期望值跟着变。
    eq(value.worldSeeder?.blockedNames, ['小鹿', '老王'], 'worldSeeder.blockedNames')
    eq(value.specialization?.mode, 'lite', 'specialization.mode')
    eq(value.im?.chunking?.typingJitterRatio, 0.1, 'typingJitterRatio 未被取整破坏')
  })
  check('维护段的改动也落对路径（含休息时段解析成两个窗口）', () => {
    eq(value.logLevel, 'warn', 'logLevel')
    // 提示词四层：改过的落新值，没改的保持原值（面板不能漏写）。
    eq(value.mainPrompt, '新的主体叙事', 'mainPrompt')
    eq(value.stylePrompt, '新的文风', 'stylePrompt')
    eq(value.formatPrompt, '格式附加自定义', 'formatPrompt 未被漏写')
    eq(value.fixedPrompt, '固定指令自定义', 'fixedPrompt 未被漏写')
    // 这两项已升为顶层 memory 段（字段名按上游改）。旧路径由 config-compat 兜住，
    // 但面板**写入**用的是新路径——这里断言的正是写入结果。
    // **断言类型**：数组字段必须往返为数组。生成器原先没有这一支，载荷里会是字符串
    // `"小鹿, 老王"`——路径对、类型错，而覆盖度不变量只看路径，查不出来。
    eq(value.worldSeeder?.blockedNames, ['小鹿', '老王'], 'blockedNames 应往返为字符串数组')
    eq(value.memory?.recentEntryLimit, 35, 'memory.recentEntryLimit')
    eq(value.memory?.factLimit, 12, 'memory.factLimit')
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

/* ─────────────── 系统性核查：schema 字段是否都上了面板 ─────────────── */

if (saveCall) {
  const value = saveCall.payload?.value ?? saveCall.payload
  /** 递归收集 schema 的叶子字段路径。 */
  const schemaLeaves = (schema, prefix, out) => {
    const dict = schema?.dict
    if (!dict) return
    for (const [key, child] of Object.entries(dict)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (child?.dict) schemaLeaves(child, path, out)
      else out.push(path)
    }
  }
  /** 递归收集 payload 对象里的叶子路径（数组按叶子算）。 */
  const payloadLeaves = (node, prefix, out) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) { if (prefix) out.add(prefix); return }
    const keys = Object.keys(node)
    if (!keys.length) { if (prefix) out.add(prefix); return }
    for (const key of keys) payloadLeaves(node[key], prefix ? `${prefix}.${key}` : key, out)
  }
  const schemaPaths = []
  schemaLeaves(ConfigSchema, '', schemaPaths)
  const payloadPaths = new Set()
  payloadLeaves(value, '', payloadPaths)

  /*
   * 未上界面的字段**必须显式登记**。
   *
   * 为什么要有这张表：面板是手写字段清单，新字段很容易只进 schema 与逻辑、
   * 忘了上面板——那种缺口**不报错**，只是用户在界面上找不到它
   * （本轮就是这样发现批 3 的三个节奏旋钮漏了）。有了这张表，
   * ① 每个缺口都有人写下的理由；② 新缺口会让测试变红，不会悄悄累积。
   *
   * 前缀写法：`im.worldSeeder.` 表示该前缀下所有字段。
   */
  /*
   * 「不渲染」登记**不再写在这里**——它已搬到服务端 `lib/panel-schema.js` 的
   * `PANEL_HIDDEN`（单一来源）。
   *
   * 为什么必须搬：这张表原先只在测试里，服务端描述符不知道它。于是把某段交给
   * 生成式渲染时，生成器会把那些**刻意不给控件**的字段全画出来——比如
   * `longHorizon.privateWeight`（实际权重固定 1.0，给输入框就是假开关）。
   * 现在描述符自带 `hidden` 标记：生成器跳过、测试也读同一份，两边不可能各说各话。
   */
  const NOT_EXPOSED = PANEL_HIDDEN
  const isAllowed = (path) => Object.keys(NOT_EXPOSED).some((key) => (
    key.endsWith('.') ? path.startsWith(key) : path === key
  ))

  // 待暴露项：确实该给用户、但还没做的，登记在此，下一轮补。
  // 目前为空——本轮把这批全补上了；留着这个机制是为了下次再发现缺口时有地方放。
  const PENDING = new Set([])
  const isPending = (path) => PENDING.has(path)

  /*
   * 反向校验：**登记了「不暴露」、实际却暴露了** 也要红。
   *
   * 这张表原先只有单向校验（没暴露却没登记 → 红），于是「假登记」永远没人发现：
   * 典型是 `alterSystem.` 这种**前缀登记**——它把整段都标成「高级调参不给控件」，
   * 而 `alterSystem.enabled` 其实由手写开关读写、确实在载荷里。
   *
   * 假登记的危害不是「多写一行」：它会让后来人以为那个字段没暴露，
   * 据此做判断（我就曾因为同类假登记把 `im.group.enabled` 误判为「惰性别名」，
   * 差点照着错的结论把它删掉）。
   */
  const falselyHidden = schemaPaths.filter(p => isAllowed(p) && payloadPaths.has(p))
  check('「未暴露」登记不得**假登记**（登记了不暴露、实际却在载荷里）', () => {
    eq(falselyHidden, [], `这些字段登记为「不暴露」但实际已暴露：${JSON.stringify(falselyHidden)}`)
  })

  const uncovered = schemaPaths.filter(p => !payloadPaths.has(p))
  const unexpected = uncovered.filter(p => !isAllowed(p) && !isPending(p))

  check('schema 字段要么上了面板、要么在「未暴露」清单里（防前端缺口悄悄累积）', () => {
    eq(unexpected, [], `以下 schema 字段既没上面板、也没登记理由：${JSON.stringify(unexpected)}`)
  })
  check('「待暴露」清单是真实存在的缺口（补完后本项会提醒你删掉登记）', () => {
    const stale = [...PENDING].filter(p => payloadPaths.has(p))
    eq(stale, [], `这些已经上了面板，应从待暴露清单移除：${JSON.stringify(stale)}`)
  })
  check('内联的 mergeDeep 与 node 侧 mergeInto **逐例一致**（防两份实现漂移）', () => {
  // 前端无法 require 本地文件，所以 mergeDeep 是一份**内联副本**；
  // 而 panel-schema.js 的 mergeInto 才是有单测的参考实现。
  // 两份实现分处两地、各自演化——这正是本仓反复踩过的坑（同一个东西写两遍）。
  // 所以拿一组边界逐例比对：哪天有人只改了一边，这里立刻红。
  const clientMerge = mod.__mergeDeep
  assert.equal(typeof clientMerge, 'function', '客户端应导出 __mergeDeep 供比对')
  const cases = [
    [{ a: { x: 1, y: 2 } }, { a: { y: 9 } }],
    [{ a: { x: 1 }, b: 2 }, { a: { z: 3 }, c: 4 }],
    [{ list: [1, 2, 3] }, { list: [9] }],
    [{ list: [{ a: 1 }] }, { list: [{ b: 2 }] }],
    [{ a: 42 }, { a: { b: 1 } }],
    [{ a: { b: 1 } }, { a: 42 }],
    [{}, { a: { b: { c: 1 } } }],
    [{ a: { b: { c: 1 } } }, {}],
    [undefined, { a: 1 }],
    [{ a: 1 }, undefined],
    [{ a: null }, { a: { b: 1 } }],
    [{ a: { b: 1 } }, { a: null }],
  ]
  cases.forEach(([base, patch], i) => {
    assert.deepEqual(clientMerge(base, patch), mergeInto(base, patch),
      `第 ${i} 例结果不一致：base=${JSON.stringify(base)} patch=${JSON.stringify(patch)}`)
    // 顺带钉一条语义：不得改动入参（React 靠引用判等）。
    const baseSnapshot = JSON.stringify(base)
    clientMerge(base, patch)
    assert.equal(JSON.stringify(base), baseSnapshot, `第 ${i} 例改动了入参`)
  })
})

check('生成式渲染：主动联系（首个**非扩展页**迁移）按页挂载且断言值', () => {
  // 这是第一个迁到非扩展页的段——用来验证「按页挂载」在真实迁移里成立。
  const rhythm = collectText(goTab('节奏'))
  assert.ok(rhythm.includes('主动联系'), `节奏页应有自动生成的主动联系段：${rhythm.slice(0, 240)}`)
  // 否定断言要用**只属于该段**的文案：「主动联系」这四个字在别处的说明文字里也有，
  // 拿它做否定断言会误报（这条我自己刚踩了一次）。
  assert.ok(!collectText(goTab('扩展')).includes('允许在休息时段主动开口'),
    '主动联系的字段不该出现在扩展页')
  // 断言**值**：夹具里 duringSleep 刻意是 true（默认 false），读错就露馅。
  eq(checkboxNear(goTab('节奏'), '允许在休息时段主动开口').props.checked, true, 'duringSleep 应读回 true')
  // 生成式比原手写更完整：原先手写只覆盖 10 个字段里的 7 个，现在 10 个都在。
  eq(!!controlNearLabel(goTab('节奏'), '模糊承诺'), true, '原先手写没覆盖的字段现在也在')
})

check('生成式段**按页挂载**：时间导演在节奏页，长线叙事在扩展页', () => {
  // 这条钉的是「段属于哪个页」。若统一挂在扩展页，迁移一个段就会把它挪页——
  // 例如时间导演本属节奏页（上游【节奏 8】），跑到扩展页就是错的。
  const rhythm = collectText(goTab('节奏'))
  const advancedTab = collectText(goTab('扩展'))
  assert.ok(rhythm.includes('时间导演【节奏 8】'),
    `时间导演应在节奏页（含上游编号）：${rhythm.slice(0, 240)}`)
  assert.ok(!advancedTab.includes('时间导演【节奏 8】'), '时间导演不该出现在扩展页')
  assert.ok(advancedTab.includes('长线叙事【扩展 16】'), '长线叙事应在扩展页')
  assert.ok(!rhythm.includes('长线叙事【扩展 16】'), '长线叙事不该出现在节奏页')
})

/* ───────── 生成式字段「真的被画出来」了吗（补上一轮暴露的盲区） ───────── */

/** 收集渲染树里所有带 data-hdsi-path 标记的路径。 */
function collectRenderedPaths(node, out = []) {
  if (!node || typeof node !== 'object') return out
  const marked = node.props && node.props['data-hdsi-path']
  if (marked) out.push(marked)
  const kids = node.children ?? []
  for (const k of kids) collectRenderedPaths(k, out)
  return out
}

check('内嵌段：字段**真的画出来了**（只进保存载荷不算——那是上一轮暴露的盲区）', () => {
  // 上一轮真出现过「字段被登记为内嵌、却没有任何地方渲染它」，而覆盖度不变量
  // 是**绿的**——因为它只看保存载荷，而载荷由手写映射写好，看不出界面上有没有。
  // 这条用渲染树补上：每个内嵌段的每个非隐藏字段，都必须能在界面上找到对应控件。
  const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const listOf = (name) => {
    const m = clientSrc.match(new RegExp('var ' + name + ' = \\[([^\\]]*)\\]'))
    return (m ? m[1] : '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  }
  const embedded = listOf('EMBEDDED_SECTIONS')
  const auto = listOf('AUTO_RENDERED_SECTIONS')
  // 两个清单不得重叠：一处独立渲染、一处内嵌，同时登记会画两遍。
  eq(embedded.filter((k) => auto.includes(k)), [], '同一段不得同时登记为独立渲染与内嵌渲染')
  if (!embedded.length) return

  // 走遍所有页，收齐渲染出来的路径。
  const rendered = new Set()
  for (const label of ['创作', '节奏', '聊天', '扩展', '预设/命令']) {
    for (const path of collectRenderedPaths(goTab(label))) rendered.add(path)
  }

  const desc = panelDescriptor(ConfigSchema)
  for (const key of embedded) {
    const section = desc.sections.find((s) => s.key === key)
    assert.ok(section, `内嵌段 ${key} 不在描述符里`)
    const want = []
    for (const f of section.fields) {
      if (f.hidden) continue
      want.push(f.path)
      for (const g of f.fields || []) if (!g.hidden) want.push(g.path)
    }
    assert.ok(want.length > 0, `内嵌段 ${key} 没有任何可渲染字段？`)
    const missing = want.filter((x) => !rendered.has(x))
    eq(missing, [], `${key} 的这些字段**登记为内嵌却没有被渲染**：${JSON.stringify(missing)}`)
  }
})

check('生成式渲染：描述符驱动画出「运行时天气」段（字段随 schema 走）', () => {
  // 这是 2b 的验收点：天气段已**从手写迁移到生成式**——面板不再为它逐字段写 JSX，
  // 而是照着服务端描述符画。以后 schema 给它加字段，界面自动多一项。
  const text = collectText(goTab('扩展'))
  const text2 = goTab('扩展')
  assert.ok(text.includes('运行时天气【扩展 19】'),
    `扩展页应出现自动生成的天气段（含上游档位编号）：${text.slice(0, 300)}`)
  assert.ok(text.includes('本区由 schema 自动生成'), '应标明该段由 schema 生成')
  // 折叠标记紧贴在标题前 —— 这条证明自动段**也走了 collapsibleSection**
  // （包装在 buildSections 里统一做，所以它自动获得了折叠与字段搜索）。
  assert.ok(text.includes('▸运行时天气【扩展 19】') || text.includes('▾运行时天气【扩展 19】'),
    `自动段应带折叠标记（说明它参与了折叠/搜索）：${text.slice(0, 200)}`)
  // 字段说明来自 schema：控件按类型画出来（布尔→复选、数字→数字框）。
  assert.ok(text.includes('观测点纬度'), `应出现纬度字段：${text.slice(0, 300)}`)
  assert.ok(text.includes('跳过天气注入'), '应出现跳过架空世界的开关')
  // 天气段的痕迹不该在别处再出现一次（手写那份已撤）。
  // **断言值**（不只是存在）：路径写错时这里会红。
  eq(checkboxNear(text2, '启用运行时天气').props.checked, true, '天气开关应读回 true')
  eq(Number(controlNearLabel(text2, '观测点纬度').props.value), 31.23, '纬度应读回 31.23')
  eq(Number(controlNearLabel(text2, '拉取间隔').props.value), 45, '拉取间隔应读回 45')
  const legacy = text.split('运行时天气【扩展 19】').length - 1
  assert.equal(legacy, 1, '天气段只应出现一次（手写那份已撤）')
})

console.log(`\n[核对] schema 叶子 ${schemaPaths.length}；已上界面 ${schemaPaths.length - uncovered.length}；`
    + `未暴露 ${uncovered.filter(isAllowed).length}（已登记理由）；待暴露 ${uncovered.filter(isPending).length}`)
}

check('面板段名带上游【档位 序号】编号（只标精确对应的段）', () => {
  // 对齐上游设置页的结构：上游给每个段一个「【档位 序号】名称」编号
  // （必填 1–3 / 结构 4 / 节奏 5–9 / 内在 10–13 / 扩展 14–19 / 维护 20–21）。
  // 上游 rc52 把 weather 插进【扩展 19】，维护段随之整体后移一位：
  // blindMode → 【维护 20】、logging → 【维护 21】。编号**跟上游走**（便于逐段对照），
  // 即使本仓还没实现 weather —— 本仓本来就允许「上游有、这里没有」的段。
  // 本仓面板是手写的，段名与上游不总是同名，所以只给**概念精确对应**的段加编号。
  const advanced = collectText(goTab('扩展'))
  assert.ok(advanced.includes('世界事件播种器【扩展 15】'), `扩展页应有世界播种器编号：${advanced.slice(0, 200)}`)
  assert.ok(advanced.includes('长线叙事【扩展 16】'), '扩展页应有长线叙事编号')

  const chat = collectText(goTab('聊天'))
  assert.ok(chat.includes('QQ 机器人【必填 3】'), `聊天页应有 QQ 接入编号：${chat.slice(0, 200)}`)

  const presets = collectText(goTab('预设/命令'))
  assert.ok(presets.includes('实时日志【维护 21】'), `预设页应有日志编号：${presets.slice(0, 200)}`)
})

check('自建段**不贴**上游编号（贴错的编号比不贴更糟）', () => {
  // 这几个段上游没有对应物，属于本仓自建；给它们编号会让用户以为上游也有。
  const chat = collectText(goTab('聊天'))
  assert.ok(chat.includes('合并转发读取'), '自建段仍在')
  assert.ok(!/合并转发读取【/.test(chat), '自建段不该带编号')
  const advanced = collectText(goTab('扩展'))
  assert.ok(!/跨群投递【/.test(advanced), '自建段不该带编号')
  // 约定说明要摆出来（否则用户不知道那个编号是什么意思）。
  // 它在**节奏**页的「功能开关」区块下面（与那几个悬停解释同处）。
  const rhythm = collectText(goTab('节奏'))
  assert.ok(rhythm.includes('沿用上游设置页编号'), `应有编号约定的说明：${rhythm.slice(-200)}`)
})

check('默认展开白名单的键**必须都是面板里真实存在的区 key**', () => {
  // 这条不变量来自一个真实踩过的坑：白名单按区 key 写（`载入预设` / `导入导出` /
  // `功能` …），而渲染时曾拿**标题文字**去查（`从预设载入` / `导入 / 导出（…）` /
  // `功能开关`）——十几处对不上，于是那些「常用区」一直是收起的。
  //
  // 现在查表用的是 key，但**另一头**同样会错：白名单里写了一个面板中不存在的
  // 键（改名、删区、手误），它就是一条**永远不生效**的配置，而且完全静默。
  // 所以两边都机械对一遍。
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  // 面板里真实的 section key：字面量 + 动态 group 列表。
  const literal = [...src.matchAll(/style: S\.section, className: 'hdsi-section', key: '([^']+)'/g)].map(m => m[1])
  const groups = (src.match(/var GROUPS = \[([^\]]+)\]/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  // **生成式段的 key 也算面板段**：它们不在源码里以字面量出现，运行时由描述符产生，
  // 但它们的 key 就是 schema 键名（ASCII）。漏掉这一项，白名单里写 ASCII key
  // （如 `proactive: true`）就永远校验不到——而那正是迁移之后的主要形态。
  const autoRendered = (src.match(/var AUTO_RENDERED_SECTIONS = \[([^\]]+)\]/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  const panelKeys = new Set([...literal, ...groups, ...autoRendered])

  // 白名单里列出的键。
  const block = src.slice(
    src.indexOf('var DEFAULT_OPEN_SECTIONS = {'),
    src.indexOf('/** 本地记住上次选的 Tab'),
  )
  assert.ok(block.length > 0, '应能定位 DEFAULT_OPEN_SECTIONS')
  // 键名允许 ASCII：迁移到生成式之后，白名单里的 key 就是 schema 键名。
  const listed = [...block.matchAll(/(?:^|[,{\s])([\w\u4e00-\u9fff]+):\s*(?:true|false)/g)].map(m => m[1])

  assert.ok(listed.length >= 10, `白名单应列出足够多的区，实际 ${listed.length}`)
  const unknown = listed.filter(k => !panelKeys.has(k))
  assert.deepEqual(unknown, [], `这些白名单键在面板里不存在（拼错或区已改名）：${JSON.stringify(unknown)}`)
  // 反向也看一眼：每个区的开合默认值都得能查到（否则「常用区」会静默不展开）。
  const unlisted = [...panelKeys].filter(k => !listed.includes(k))
  assert.deepEqual(unlisted, [], `这些区没在白名单里登记开合默认值：${JSON.stringify(unlisted)}`)
})

check('前端不再有裸 `r.json()`：一律走 readJson（响应非 JSON 时给人话）', () => {
  // 为什么是硬约束：DSH 的插件后端**启动时加载**，前端每次刷新都拿最新的。
  // 于是「新面板 + 旧后端」是常态中间态——面板调一条后端还不认识的路由，
  // 宿主返回纯文本 `not found`，裸 `r.json()` 就抛
  //   Unexpected token 'o', "not found" is not valid JSON
  // 用户看到的是一句毫无线索的英文。扫码那条链早踩过、写了局部兜底，
  // 但只兜了它自己那一处；上一轮把它提成通用件 readJson 并全线换用。
  // 这条不变量防止有人再写回裸调用。
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const bare = [...src.matchAll(/\.then\(function \(r\) \{ return r\.json\(\) \}\)/g)]
  assert.deepEqual(bare.map(m => m.index), [], `还有 ${bare.length} 处裸 r.json()，应改用 readJson`)
  assert.ok(src.includes('function readJson('), '应存在 readJson 通用兜底')
  // 兜底文案要能指导用户行动（重启 DSH），而不是只说「失败」。
  assert.ok(src.includes('插件后端可能还在跑旧代码'), '兜底文案要指出「后端可能是旧代码」')
  assert.ok(src.includes('请重启 DSH 后重试'), '兜底文案要给出可执行的下一步')
})

console.log(`\n配置面板覆盖度：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
