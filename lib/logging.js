/**
 * 日志配置与内容脱敏 —— 对齐上游 `1.0.1-rc50` 的 `Logging` 段（`src/logging.ts`）。
 *
 * ## 为什么值得单独一层
 *
 * 上游的日志段里有两项**隐私开关**，默认都是**关**：
 *   - `logScriptPreview`：是否输出本轮剧本内容；
 *   - `logMessageContent`：是否输出用户消息与主角可见消息内容。
 * 上游的描述写明「可能包含私聊信息」「涉及隐私，生产环境建议关闭」。
 *
 * 本仓此前在这两处**没有开关**：日志里会直接出现正文片段（例如「写了正文但未调
 * interlude_say」那条会打印 60 字正文）。那不是「调试方便」，而是把私聊内容写进
 * 了会被别人看到的日志里——所以这里按上游口径补上，**默认关**。
 *
 * ## 分层
 *
 * 本模块只做两件事：归一化配置、按配置产出**可写进日志的预览**。真正的日志
 * 出口（`ctx.logger`）由调用方决定，这里不持有任何 logger。
 *
 * @module dsh-hds-interlude/logging
 */

/** 上游默认值（逐字对齐）：级别 info、密度 standard、布局 layered、颜色/颜文字开、
 *  两个内容开关**关**、预览 500 字。 */
export const DEFAULT_LOGGING_CONFIG = {
  level: 'info',
  verbosity: 'standard',
  format: 'layered',
  colors: true,
  colorTheme: 'dark',
  kaomoji: true,
  logScriptPreview: false,
  logMessageContent: false,
  previewLength: 500,
}

const LEVELS = ['silent', 'error', 'warn', 'info', 'debug']
const VERBOSITIES = ['summary', 'standard', 'diagnostic']
const FORMATS = ['layered', 'compact', 'detailed']
const THEMES = ['dark', 'light']

/**
 * 归一化日志配置（对齐上游 `Logging` 段的范围与默认值）。
 *
 * 兼容本仓既有的顶层 `logLevel`（旧名）：`logging.level` 优先，其次 `logLevel`。
 * 上游的 `level` 多一个 `silent`；本仓旧值的四个级别都合法。
 *
 * @param {object} value 生效配置（整个 config 对象）。
 * @returns {object} 归一化后的日志配置。
 */
export function resolveLoggingConfig(value) {
  const cfg = value && typeof value === 'object' ? value : {}
  const raw = cfg.logging && typeof cfg.logging === 'object' ? cfg.logging : {}
  const pick = (list, input, fallback) => (list.includes(input) ? input : fallback)
  const level = pick(LEVELS, raw.level, pick(LEVELS, cfg.logLevel, DEFAULT_LOGGING_CONFIG.level))
  return {
    level,
    verbosity: pick(VERBOSITIES, raw.verbosity, DEFAULT_LOGGING_CONFIG.verbosity),
    format: pick(FORMATS, raw.format, DEFAULT_LOGGING_CONFIG.format),
    // 布尔项按「显式 false 才算关」以外的语义处理：上游默认 true，
    // 但用户显式写 false 必须生效——所以直接取 !== false（缺省即 true）。
    colors: raw.colors !== false,
    colorTheme: pick(THEMES, raw.colorTheme, DEFAULT_LOGGING_CONFIG.colorTheme),
    kaomoji: raw.kaomoji !== false,
    // 两个隐私开关反过来：**默认关**，只有显式 true 才开。
    logScriptPreview: raw.logScriptPreview === true,
    logMessageContent: raw.logMessageContent === true,
    previewLength: Math.max(50, Math.min(4000, Math.round(Number(raw.previewLength) || DEFAULT_LOGGING_CONFIG.previewLength))),
  }
}

/**
 * 产出**可写进日志**的内容预览。
 *
 * 三道处理，顺序固定：
 *   ① 开关关着 → 返回**空串**（调用方据此不打印内容片段）；
 *   ② 压平空白（换行会把一条日志拆成多行，读日志的人分不清哪行是哪条）；
 *   ③ 按 `previewLength` 截断并加省略号。
 *
 * @param {string} text 原始内容（正文 / 消息 / 剧本）。
 * @param {object} cfg 归一化后的日志配置（`resolveLoggingConfig` 的产出）。
 * @param {'script'|'message'} [kind] 内容种类：剧本走 `logScriptPreview`，
 *   消息走 `logMessageContent`。默认按消息处理（更严格的那个开关语义更贴切）。
 * @returns {string} 可直接拼进日志的片段；不该打印时是空串。
 */
export function logPreview(text, cfg, kind = 'message') {
  const allowed = kind === 'script' ? cfg?.logScriptPreview === true : cfg?.logMessageContent === true
  if (!allowed) return ''
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const limit = Math.max(50, Math.min(4000, Math.round(Number(cfg?.previewLength) || DEFAULT_LOGGING_CONFIG.previewLength)))
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * 组装一段「内容 + 可选预览」的日志文本。
 *
 * 用途：让调用点在**开关关着**时仍然记下「发生了什么」，只是不带内容——
 * 这比整条日志消失更有用（否则排查时看不到事件，只看到一片安静）。
 *
 * @param {string} head 事件描述（不含隐私内容）。
 * @param {string} text 内容。
 * @param {object} cfg 日志配置。
 * @param {'script'|'message'} [kind] 内容种类。
 * @returns {string} `head`，或 `head（预览：…）`。
 */
export function describeWithPreview(head, text, cfg, kind = 'message') {
  const preview = logPreview(text, cfg, kind)
  return preview ? `${head}（预览：${preview}）` : head
}
