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
export const PANEL_SECTIONS = {
  story: { upstream: 'storyDefaults', label: '故事档案', tier: '结构' },
  runtime: { upstream: 'runtime', label: '对话节奏', tier: '节奏' },
  proactive: { upstream: 'runtime', label: '主动联系', tier: '节奏', own: true },
  agency: { upstream: 'agency', label: '行动窗口', tier: '节奏' },
  alterSystem: { upstream: 'alterSystem', label: '情绪偏移', tier: '内在' },
  schedulePreplan: { upstream: 'schedulePreplan', label: '日程预排', tier: '节奏' },
  urge: { upstream: 'urge', label: 'Urge 弹性推进', tier: '节奏' },
  timelineDirector: { upstream: 'timelineDirector', label: '时间导演', tier: '节奏' },
  longHorizon: { upstream: 'longHorizon', label: '长线叙事', tier: '扩展' },
  logging: { upstream: 'logging', label: '日志', tier: '维护' },
  blindMode: { upstream: 'blindMode', label: '盲区模式', tier: '维护' },
  presetSync: { upstream: 'presetSync', label: '预设同步', tier: '扩展' },
  weather: { upstream: 'weather', label: '运行时天气', tier: '扩展' },
  mainPrompt: { upstream: 'mainPrompt', label: '主提示词', tier: '必填' },
  // ── 本仓自建（上游无对应段，不贴编号）──
  enabled: { upstream: null, label: '总开关', tier: null },
  timeZone: { upstream: null, label: '时区', tier: null },
  gapNoticeMinutes: { upstream: null, label: '间隔提示', tier: null, own: true },
  alwaysReportTime: { upstream: null, label: '每次报时', tier: null, own: true },
  rules: { upstream: null, label: '行为规则', tier: null, own: true },
  formatPrompt: { upstream: null, label: '格式提示词', tier: null, own: true },
  fixedPrompt: { upstream: null, label: '固定提示词', tier: null, own: true },
  stylePrompt: { upstream: null, label: '文风提示词', tier: null, own: true },
  blackBox: { upstream: null, label: '旧名兼容（blackBox）', tier: null, own: true },
  im: { upstream: 'onebot', label: 'QQ 通道', tier: '必填' },
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
      fields: describeFields(node, maxDepth - 1),
    })
  }
  return sections
}

/** 递归描述一个 object 节点下的字段。 */
function describeFields(node, depth) {
  if (!node?.dict || depth < 0) return []
  const fields = []
  for (const [key, child] of Object.entries(node.dict)) {
    const control = CONTROL_BY_TYPE[child?.type] ?? 'text'
    const field = {
      key,
      path: key,
      type: child?.type,
      control: control === 'group' && depth <= 0 ? 'group' : control,
      description: String(child?.meta?.description ?? ''),
      default: defaultOf(child),
    }
    const options = optionsOf(child)
    if (options) field.options = options
    if (control === 'group') field.fields = describeFields(child, depth - 1)
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
