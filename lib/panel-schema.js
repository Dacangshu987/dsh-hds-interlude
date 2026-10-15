/**
 * 配置面描述 —— 面板「生成式」引擎的底座（rc52 面板重设计，第 1 阶段）。
 *
 * ## 为什么要这一层
 *
 * 上游的面板是 Console **从 Schema 自动生成**的：加一个 schema 字段，页面
 * 自动多一项，永远不漂移。本仓的面板原先**手写**（1700+ 行 JSX），于是同一件事
 * 要维护两遍——漏字段、放错位置、写成自己的名字，全都无人拦。实测表现：
 * 按上游**档位编号**数「15/20 段具备」，按**顶层 key** 数就大面积对不上。
 *
 * 这一层把 schema 变成**可渲染的描述**（段 → 字段 → 控件类型/默认值/说明），
 * 面板只负责把描述画出来。「面板 vs schema」的漂移从此在结构上不可能发生。
 *
 * ## 分层
 *
 *   - `describeConfig(schema)`：纯自省，把 schemastery 的 `.dict` 树摊成
 *     「段 → 字段」描述。不引入任何面板知识。
 *   - `PANEL_SECTIONS`：**呈现层**的映射（上游段名、档位序号、分页归属）。
 *     与 schema 解耦：改呈现不动 schema，加 schema 字段不改呈现。
 *   - `planPanel(described)`：把两者拼起来 → 面板可直接消费的结构；
 *     **任何字段没被映射到就抛错**，不允许静默丢掉一个配置项。
 *
 * @module dsh-hds-interlude/panel-schema
 */

/**
 * 上游 rc52 的顶层段顺序（Console 页面顺序）。
 *
 * 用途有二：① 面板按它排段，视觉上与上游一致；② 它同时是**差距清单**——
 * 本仓没有的段也留在这里，好让「上游有、这里没有」是显式的而不是被忘记。
 */
export const UPSTREAM_SECTION_ORDER = [
  'storyDefaults', 'model', 'onebot', 'sharedStory', 'runtime', 'urge',
  'schedulePreplan', 'timelineDirector', 'agency', 'chatActions', 'stickers',
  'memory', 'alterSystem', 'browser', 'worldSeeder', 'longHorizon', 'qzone',
  'presetSync', 'weather', 'blindMode', 'logging', 'mainPrompt', 'chatRhythm',
]

/**
 * 本仓段 → 呈现信息。
 *
 * `upstream` 指本段在**上游**对应哪个顶层段（用于取上游段名与顺序）；
 * 为 `null` 表示本仓自建、上游没有对应段（这类**不贴档位编号**，
 * 贴错的编号比不贴更糟——这是既有约定）。
 *
 * `tier` 是上游的档位分组（必填/结构/节奏/内在/扩展/维护），用于分组标题。
 */
/**
 * 段所属的**页**（内部 id）。生成式渲染必须按页挂载——否则迁移一个段就会把它
 * 挪到别的页去（例如「主动联系」本属节奏页，若统一挂在扩展页就是错的）。
 *
 * 取值是内部 tab id：`story` 创作 / `rhythm` 节奏 / `chat` 聊天 /
 * `advanced` 扩展 / `presets` 预设·命令。
 */
export const PANEL_SECTIONS = {
  storyDefaults: { upstream: 'storyDefaults', label: '故事档案', tier: '结构', tab: "story" },
  worldSeeder: { upstream: 'worldSeeder', label: '世界事件播种器', tier: '扩展', tab: "advanced" },
  // 表情包库：界面目前**手写**在聊天页的 im 段里（含目录选择器），所以不给它编号、
  // 也不进 AUTO_RENDERED_SECTIONS——但映射必须有，否则 planPanel 会拒绝构建描述符。
  stickers: { upstream: 'stickers', label: '表情包库', tier: '扩展', tab: "chat", own: true },
  runtime: { upstream: 'runtime', label: '对话节奏', tier: '节奏', tab: "rhythm" },
  proactive: { upstream: 'runtime', label: '主动联系', tier: '节奏', own: true, tab: "rhythm" },
  agency: { upstream: 'agency', label: '行动窗口', tier: '节奏', tab: "rhythm" },
  alterSystem: { upstream: 'alterSystem', label: '情绪偏移', tier: '内在', tab: "rhythm" },
  schedulePreplan: { upstream: 'schedulePreplan', label: '日程预排', tier: '节奏', tab: "rhythm" },
  urge: { upstream: 'urge', label: 'Urge 弹性推进', tier: '节奏', tab: "rhythm" },
  timelineDirector: { upstream: 'timelineDirector', label: '时间导演', tier: '节奏', tab: "rhythm" },
  longHorizon: { upstream: 'longHorizon', label: '长线叙事', tier: '扩展', tab: "advanced" },
  logging: { upstream: 'logging', label: '日志', tier: '维护', tab: "advanced" },
  blindMode: { upstream: 'blindMode', label: '盲区模式', tier: '维护', tab: "advanced" },
  presetSync: { upstream: 'presetSync', label: '预设同步', tier: '扩展', tab: "presets" },
  weather: { upstream: 'weather', label: '运行时天气', tier: '扩展', tab: "advanced" },
  mainPrompt: { upstream: 'mainPrompt', label: '主提示词', tier: '必填', tab: "advanced" },
  // ── 本仓自建（上游无对应段，不贴编号）──
  enabled: { upstream: null, label: '总开关', tier: null, tab: "story" },
  timeZone: { upstream: null, label: '时区', tier: null, tab: "story" },
  gapNoticeMinutes: { upstream: null, label: '间隔提示', tier: null, own: true, tab: "story" },
  alwaysReportTime: { upstream: null, label: '每次报时', tier: null, own: true, tab: "story" },
  rules: { upstream: null, label: '行为规则', tier: null, own: true, tab: "story" },
  formatPrompt: { upstream: null, label: '格式提示词', tier: null, own: true, tab: "advanced" },
  fixedPrompt: { upstream: null, label: '固定提示词', tier: null, own: true, tab: "advanced" },
  stylePrompt: { upstream: null, label: '文风提示词', tier: null, own: true, tab: "advanced" },
  blackBox: { upstream: null, label: '旧名兼容（blackBox）', tier: null, own: true, tab: "advanced" },
  im: { upstream: 'onebot', label: 'QQ 通道', tier: '必填', tab: "chat" },
}

/** 控件类型：把 schemastery 的 type 收敛成面板认识的那几种。 */
const CONTROL_BY_TYPE = {
  boolean: 'checkbox',
  number: 'number',
  string: 'text',
  array: 'list',
  union: 'select',
  object: 'group',
}

/** 取一个 schema 节点的默认值（坏节点返回 undefined）。 */
function defaultOf(node) {
  const d = node?.meta?.default
  if (typeof d === 'function') { try { return d() } catch { return undefined } }
  return d
}

/** 取 union 的可选值；拿不到就不猜（返回 undefined，面板退化成文本框）。 */
function optionsOf(node) {
  const list = node?.list ?? node?.meta?.options
  if (Array.isArray(list)) return list.map((v) => (typeof v === 'object' && v !== null ? v.value : v)).filter((v) => v !== undefined)
  return undefined
}

/**
 * 自省：把 schema 摊成「段 → 字段」的描述。
 *
 * 递归到 `maxDepth` 层（默认 2：段 → 字段 → 子字段），再深的作为 `group`
 * 整块交给自定义区块处理——本仓最深的段（`im`）有 3 层，全自动渲染表格
 * 反而比手写难用。
 *
 * @param {object} schema schemastery 的 object schema（通常是 `Config`）。
 * @param {object} [options]
 * @param {number} [options.maxDepth=2] 递归深度。
 * @returns {Array<object>} 段描述数组。
 */
export function describeConfig(schema, { maxDepth = 2 } = {}) {
  const sections = []
  for (const [key, node] of Object.entries(schema?.dict ?? {})) {
    sections.push({
      key,
      type: node?.type,
      description: String(node?.meta?.description ?? ''),
      default: defaultOf(node),
      fields: describeFields(node, maxDepth - 1, key),
    })
  }
  return sections
}

/** 递归描述一个 object 节点下的字段。 */
function describeFields(node, depth, prefix = '') {
  if (!node?.dict || depth < 0) return []
  const fields = []
  for (const [key, child] of Object.entries(node.dict)) {
    const control = CONTROL_BY_TYPE[child?.type] ?? 'text'
    // **路径必须带父段前缀**：前端是拿 path 去配置里取值的，
    // 只写 key 的话 `blindMode.enabled` 会变成 `enabled`，取值永远 undefined
    // ——表现为「控件画出来了、但值是空的」，而且不报错。
    const path = prefix ? prefix + '.' + key : key
    const field = {
      key,
      path,
      // 命中「不渲染」登记：带上理由，前端据此跳过（不给假开关）。
      ...(hiddenReasonFor(path) ? { hidden: hiddenReasonFor(path) } : {}),
      type: child?.type,
      control: control === 'group' && depth <= 0 ? 'group' : control,
      description: String(child?.meta?.description ?? ''),
      default: defaultOf(child),
    }
    const options = optionsOf(child)
    if (options) field.options = options
    if (control === 'group') field.fields = describeFields(child, depth - 1, path)
    fields.push(field)
  }
  return fields
}

/**
 * 把自省结果与呈现映射拼成面板结构。
 *
 * **任何段没被 `PANEL_SECTIONS` 映射就抛错**：这是这一层的核心不变量——
 * 允许「上游有、这里没有」，但不允许「schema 里有、面板悄悄不画」。
 * 静默丢一个配置项，用户是永远看不出来的。
 *
 * @param {Array<object>} described `describeConfig` 的结果。
 * @param {object} [map] 呈现映射（默认 `PANEL_SECTIONS`）。
 * @returns {Array<object>} 面板段（已按上游顺序排序，未映射的排最后）。
 */
export function planPanel(described, map = PANEL_SECTIONS) {
  const unmapped = described.filter((s) => !map[s.key]).map((s) => s.key)
  if (unmapped.length) {
    throw new Error(`这些 schema 段没有面板映射（会静默消失）：${unmapped.join('、')}`)
  }
  const orderOf = (key) => {
    const up = map[key].upstream
    const i = up ? UPSTREAM_SECTION_ORDER.indexOf(up) : -1
    return i < 0 ? UPSTREAM_SECTION_ORDER.length : i
  }
  return described
    .map((s) => ({
      ...s,
      ...map[s.key],
      // 档位编号只给**精确对应上游**的段；自建段不给编号。
      numbered: map[s.key].upstream !== null && map[s.key].own !== true,
      order: orderOf(s.key),
    }))
    .sort((a, b) => (a.order - b.order) || a.key.localeCompare(b.key))
}

/**
 * **不该渲染到面板上的配置路径**（带理由）——单一来源。
 *
 * ## 为什么这张表必须在服务端
 *
 * 它原先只存在于**测试**里（测试用它来判定「未暴露的字段有没有登记理由」），
 * 而服务端描述符**不知道**这件事。后果：一旦把某段交给生成式渲染，
 * 生成器会把那些**刻意不给控件**的字段全都画出来——例如 `longHorizon.privateWeight`
 * 在 schema 里只为读取旧配置而存在，实际权重固定 1.0，给它一个输入框就是**假开关**。
 *
 * 搬到服务端后：描述符自带 `hidden` 标记 → 生成器天然不会画假开关；
 * 测试与描述符**共用同一份来源**（原先两边各写一份，正是漂移的温床）。
 *
 * 前缀写法：键以 `.` 结尾表示该前缀下所有路径（`agency.` = 整个 agency 段）。
 */
export const PANEL_HIDDEN = {
  // 宿主层开关：由 DSH 的插件启停承担，插件面板不再重复给一个开关。
  enabled: '由宿主插件启停承担',
  // 旧字段名/内部机制：面板只暴露当前规范名，避免同时出现两个同名开关。
  'im.logLevel': '旧别名，面板用顶层 logLevel',
  'im.botId_legacy': '旧字段名，面板用 im.bots',
  'im.targetId': '旧单目标字段，面板用 im.bots',
  // 集成细节：改了只会把通道弄坏，不是用户该调的旋钮。
  'im.sayTool': '工具名内部约定',
  'im.imageTool': '工具名内部约定',
  'im.exposeService': '兼容出口开关（默认不占用该服务名）',
  'im.migrateLegacyBindings': '一次性迁移开关',
  'im.autoDiscover': '自动发现机制内部',
  'im.botCommands': 'Bot 命令开关内部',
  'im.markdownSupport': '平台能力探测结果',
  'im.waitForTurnMs': '回合等待超时内部',
  'im.timeoutMs': '投递超时内部',
  'im.keepPassive': '被动回复窗口内部',
  'im.dedupe.': '去重窗口容量内部',
  'im.autoCreateSession': '标准功能（默认开），描述里已注明改 yaml',
  // 更多旧嵌套别名：面板暴露的是顶层规范名或新名，避免出现两个同名开关。
  // 注意：这条**不是**惰性别名——面板确实在读 im.group（见 client.js 的读回），
  // 只是不在界面上给控件（默认开启的标准功能）。上一轮我把它错记成「旧嵌套别名」，已改正。
  'im.group.enabled': '标准功能（默认开），界面不给控件；需要关闭时在 settings.yaml 显式写',
  'im.chunking.enabled': '旧别名，面板用 im.chunking.splitReplyMessages',
  // 高级调参：默认值已经调好，暴露出来只会让人误调；需要时改 yaml。
  'agency.': '高级调参（沿用默认）',
  'alterSystem.': '高级调参（沿用默认）',
  'schedulePreplan.': '高级调参（沿用默认）',
  'urge.advanced.': '高级调参（沿用默认）',
  'urge.frequency': '高级调参（沿用默认）',
  'urge.proactiveWillingnessThreshold': '高级调参（沿用默认）',
  // 冲突键：world 是同一个键，schema 的 union 只接受字符串或对象其一，面板按对象读写。
  'storyDefaults.world': '与对象形态同键，面板按对象读写',
  // 尚未接线的上游同名项：留着是为了与上游配置对齐，进来之前不该给用户一个假开关。
  'storyDefaults.storyTimezone': '上游同名项，本仓统一用顶层 timeZone（尚未接线）',
  'runtime.userMessageDebounceSeconds': '本版本不生效：连输入的合并由 DSH 宿主处理',
  // 上游固定值：这两项在 schema 里只为**读取旧配置**而存在，实际权重固定 1.0 / 0.5。
  'longHorizon.privateWeight': '上游固定 1.0（权重契约），配置不生效',
  'longHorizon.groupWeight': '上游固定 0.5（权重契约），配置不生效',
  // 终端渲染项：DSH 的日志由宿主 logger 输出，插件无法控制 ANSI 颜色、布局与颜文字。
  'logging.format': '宿主 logger 决定布局，插件不控制',
  'logging.colors': '宿主 logger 决定着色，插件不控制',
  'logging.colorTheme': '宿主 logger 决定配色，插件不控制',
  'logging.kaomoji': '宿主 logger 决定前缀，插件不控制',
}

/**
 * 某个配置路径是否被登记为「不渲染」；命中则返回理由。
 *
 * @param {string} path 全路径（如 `im.dedupe.ttlMinutes`）。
 * @returns {string|undefined} 理由；未登记则 undefined。
 */
export function hiddenReasonFor(path) {
  for (const [key, reason] of Object.entries(PANEL_HIDDEN)) {
    if (key.endsWith('.')) { if (path.startsWith(key)) return reason } else if (path === key) return reason
  }
  return undefined
}

/**
 * 自定义区块白名单 —— 这些**必须手写**，schema 表达不了。
 *
 * 判据：它需要的不是「一个值」，而是**交互**——二维码轮询、实时日志流、
 * 文件目录选择、扫码结果三环、分享码预览/应用、机器人列表增删。
 * 生成器画得出来的只有「值 → 控件」，画不出这些。
 *
 * 白名单是显式的：**没列在这里、又没被 schema 描述的区块不存在**——
 * 想加一个手写区块，就得先在这里登记，于是「手写」始终是一个受控的少数。
 */
export const CUSTOM_SECTIONS = [
  '载入预设', '导入导出', '扫码绑定', '连接状态', '通道设置', '机器人列表',
  '实时日志', '预设管理', '分享码预览', '目录选择器', '提示词高级',
]

/**
 * 服务端 → 客户端的**面板描述符**（可直接 JSON 传输）。
 *
 * ## 为什么由服务端算、而不是前端自己读 schema
 *
 * 前端 `lib/client.js` 是浏览器模块，实测只用 `require('react')`、**没有本地相对
 * require 的先例**，把它 require 进 `panel-schema.js` 是在赌加载器行为。更稳的做法：
 * 服务端算好描述符、经路由发给前端，前端只当**哑渲染器**。
 *
 * 好处不止于稳：schema 改了面板**自动跟着变**，连前端重新构建都不需要——
 * 这正是「面板不再与 schema 漂移」的落实方式（上游 Console 也是这个形态）。
 *
 * @param {object} schema schemastery 的 object schema。
 * @param {Array<string>} [customSections] 自定义区块名（默认 `CUSTOM_SECTIONS`）。
 * @returns {{version: number, upstreamOrder: string[], custom: string[], sections: Array<object>}}
 */
export function panelDescriptor(schema, customSections = CUSTOM_SECTIONS) {
  return {
    version: 1,
    upstreamOrder: [...UPSTREAM_SECTION_ORDER],
    custom: [...customSections],
    sections: planPanel(describeConfig(schema)),
  }
}

/* ─────────────────── 路径读写（生成式渲染要用） ─────────────────── */

/**
 * 按路径取值：`getAt(cfg, 'weather.latitude')`。
 *
 * 前端是**哑渲染器**：它拿到的描述符里每条字段都有一个 `path`，
 * 于是读写配置只需要这一对函数，不需要为每个字段写一遍样板。
 * （原先手写面板的样板就是漂移的温床：加一个字段要在默认值、读回、
 * 保存三处各写一遍，漏一处就静默不生效。）
 *
 * @param {object} root 根对象。
 * @param {string} path 点分路径。
 * @returns {*} 取到的值；中途断了返回 undefined。
 */
export function getAt(root, path) {
  let node = root
  for (const part of String(path ?? '').split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

/**
 * 按路径写值，**返回新对象**（不改原对象，便于 React 判等）。
 *
 * 中间层不存在时自动建对象——描述符里的路径一定来自 schema，所以这是安全的。
 *
 * @param {object} root 根对象。
 * @param {string} path 点分路径。
 * @param {*} value 新值。
 * @returns {object} 新根对象。
 */
export function setAt(root, path, value) {
  const parts = String(path ?? '').split('.')
  const clone = (node) => (node && typeof node === 'object' && !Array.isArray(node) ? { ...node } : {})
  const head = parts[0]
  const next = clone(root)
  if (parts.length === 1) {
    next[head] = value
    return next
  }
  next[head] = setAt(next[head], parts.slice(1).join('.'), value)
  return next
}

/**
 * 把 `patch` 深合并进 `base`（返回新对象）。数组**整体替换**，不做逐项合并。
 *
 * 保存时用：生成式渲染的那部分（`autoDraft`）合并进手写部分构建出的 payload。
 * 两边理论上不会撞同一个键——撞了以 `patch` 为准并留痕更安全，但这里选择
 * 让调用方自己保证不重叠（生成器只渲染「未手写段」）。
 *
 * @param {object} base 基础对象。
 * @param {object} patch 覆盖层。
 * @returns {object} 合并结果。
 */
export function mergeInto(base, patch) {
  const out = { ...(base && typeof base === 'object' ? base : {}) }
  for (const [key, value] of Object.entries(patch ?? {})) {
    const both = out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
      && value && typeof value === 'object' && !Array.isArray(value)
    out[key] = both ? mergeInto(out[key], value) : value
  }
  return out
}

/**
 * 描述符里**没有手写实现**的段（交给生成式渲染）。
 *
 * @param {object} descriptor `panelDescriptor` 的结果。
 * @param {Iterable<string>} handWritten 已手写实现的段 key 集合。
 * @returns {Array<object>} 需要自动渲染的段。
 */
export function autoSections(descriptor, handWritten) {
  const done = new Set(handWritten ?? [])
  return (descriptor?.sections ?? []).filter((s) => !done.has(s.key))
}
