/**
 * IM 投递支持 —— 把角色当场写的一段话，拆成「像真人发消息」的多条短消息。
 *
 * 为什么需要它：
 * dsh-im 把最终 assistant 文本整体投递（QQ 侧走 sendMarkdownReply，只在 4500 字
 * 才切分），所以一条 200 字的回复会变成一整块气泡。真人聊天不是这样的。
 * 这里做两件事：
 *   1. 去掉「不该出现在聊天窗口里的东西」——旁白、动作、内心独白、Markdown 标记；
 *   2. 按语义边界切成若干条短消息，并限制条数。
 *
 * 纯函数，无副作用，可单独测试。
 *
 * @module dsh-hds-interlude/im
 */

/**
 * 整行旁白/动作：（…） （...) 【…】 […] —— 这是模型写内心戏的典型形态。
 *
 * 导出给 story.js 复用：那边要判断「整段是不是全是旁白」，
 * 必须和这里「什么算旁白行」用同一个定义，否则会出现
 * 「清洗时判成旁白删掉、净化时又判成不是旁白放行」这种自相矛盾。
 */
export const NARRATION_LINE = /^\s*(?:[（(【\[][^）)】\]]*[）)】\]]|[（(【\[][^）)】\]]*$)\s*$/

/** 行内旁白/动作。限定长度，避免把正常引用的括号内容也吃掉。 */
const INLINE_NARRATION = /[（(【\[][^（(【\[）)】\]]{0,200}[）)】\]]/g

/** *动作描写*。 */
const ASTERISK_ACTION = /\*[^*\n]{0,200}\*/g

/** Markdown 块级前缀：标题、无序/有序列表、引用。 */
const MD_BLOCK_PREFIX = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s+)/

/** Markdown 行内标记与分隔线。 */
const MD_INLINE_MARK = /(\*\*|__|~~|`)/g
const MD_RULE = /^\s*[-—–*_]{3,}\s*$/

/**
 * 模型内部结构标记的标签名（`<timeline_plan>`、`<thinking>` 等）。
 *
 * 这些是**提示词协议**的一部分，不是角色说的话，出现在出站文本里必须整体丢掉
 * （连同内容）。线上事故（回复错乱）：`<timeline_plan>{"beats":[…]}</timeline_plan>`
 * 连同整段英文思考被当作台词逐行发进了 QQ。
 *
 * 每个标签单独一条正则（见 cleanImText）：多选分支 + 反向引用 `\1` 在实测中
 * 只删掉了标签、留下了中间的 JSON。
 */
const MODEL_INTERNAL_TAGS = [
  'timeline_plan',
  'thinking',
  'think',
  'scratchpad',
  'analysis',
  'reasoning',
  'plan',
]

/** 句子结束符（中文为主；不切英文句点，避免小数点与缩写被误切）。 */
const SENTENCE_END = '。！？!?…'
const FULL_STOP_LINE = /[。！？!?…]+$/

/** 软断点：切不动整句时退到这里。 */
const SOFT_BREAK = /[，,、；;：:）)】\]〕》」』\s]/

const DEFAULT_MAX_CHARS = 40
const DEFAULT_MAX_MESSAGES = 4
const DEFAULT_MIN_INTERVAL_MS = 400
const DEFAULT_TIMEOUT_MS = 15_000
/** 默认气泡分隔符（对齐上游 `messageSeparator` 的默认值）。 */
const DEFAULT_MESSAGE_SEPARATOR = '<sep/>'

/** 单行去掉首尾成对引号（模型常把台词包一层引号，聊天里不该出现）。 */
function stripQuotes(line) {
  const pairs = [['"', '"'], ['\u201c', '\u201d'], ['\u300c', '\u300d'], ['\u300e', '\u300f'], ["'", "'"]]
  for (const [open, close] of pairs) {
    if (line.length >= 2 && line.startsWith(open) && line.endsWith(close)) {
      const inner = line.slice(open.length, line.length - close.length).trim()
      if (inner) return inner
    }
  }
  return line
}

/**
 * 清理：删掉旁白、动作、Markdown，只留下「说出口的话」。
 * @param {string} input
 * @returns {string} 逐行清理后的文本；完全为空表示这一条不该出现在 IM 里。
 */
export function cleanImText(input) {
  if (typeof input !== 'string' || !input.trim()) return ''
  let text = input.replace(/\r\n?/g, '\n')
  
  // 模型内部结构标记整体丢掉：`<timeline_plan>{...JSON...}</timeline_plan>`、
  // `<thinking>…</thinking>` 等属于提示词协议，不是角色说的话。
  // 线上事故（回复错乱）：这类标记连同 JSON 被当作台词逐行发进了 QQ。
  //
  // 必须放在**最前面**：后面的 MD_INLINE_MARK 等规则会把 `<` `>` 去掉，
  // 只留中间那段 JSON 文本，那时就再也认不出它是结构块了。
  // 每个标签名单独一条正则（不用反向引用）：多选分支下的 `\1` 在某些引擎上
  // 匹配不到对应分支，实测会漏掉内容只删标签。
  for (const tag of MODEL_INTERNAL_TAGS) {
    text = text
      .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
      // 落单的开/闭标签本身也要删（闭合标签带 `/`，不能只写 `<tag…>`）。
      .replace(new RegExp(`<\\/?${tag}\\b[^>]*\\/?>`, 'gi'), '')
  }

  // 模型可能复述入站消息里的附件标记。可见回复是纯文本合约：
  // 标记一旦漏出会被适配器解析成真实附件发出去，导致发不出或发出损坏媒体。
  text = text
    .replace(/<\/?(?:file|img|image|audio|record|video|flash|mface)\b[^>]*\/?>/gi, '')
    .replace(/\[CQ:(?:file|image|record|video|flash|mface),[^\]]*\]/gi, '')
    .replace(/[\[【](?:表情包?|图片|动图|GIF)[\]】]/gi, '')
    // 这些文字表情在清洗后会被删掉，防止残留中括号
    .replace(/[\[【](?:流汗|微笑|笑哭|尴尬|爱心|惊讶|流泪|委屈)[\]】]/gi, '')

  // 代码块整体丢掉：它在聊天里是无意义的噪声（且太长）。
  text = text.replace(/```[\s\S]*?```/g, '')

  const lines = []
  for (const raw of text.split('\n')) {
    if (NARRATION_LINE.test(raw)) continue
    if (MD_RULE.test(raw)) continue
    let line = raw
      .replace(INLINE_NARRATION, '')
      .replace(ASTERISK_ACTION, '')
      .replace(MD_BLOCK_PREFIX, '')
      .replace(MD_INLINE_MARK, '')
      .trim()
    line = stripQuotes(line)
    if (line) lines.push(line)
  }
  return lines.join('\n').trim()
}

/** 按句末标点切句，标点保留在句尾。 */
function splitSentences(line) {
  const out = []
  let buffer = ''
  for (const ch of line) {
    buffer += ch
    if (SENTENCE_END.includes(ch)) {
      if (FULL_STOP_LINE.test(buffer)) { out.push(buffer); buffer = '' }
    }
  }
  if (buffer.trim()) out.push(buffer)
  return out
}

/** 解析出一个有限数字；不可用时回落到默认值（注意 0 是合法值）。 */
function finiteOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 在给定位置切分时，避免把一个代理对（emoji 等）劈成两半。 */
function safeSliceIndex(value, index) {
  if (index <= 0) return 1
  if (index >= value.length) return value.length
  const before = value.charCodeAt(index - 1)
  const after = value.charCodeAt(index)
  if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) {
    return index - 1
  }
  return index
}

/**
 * 把一段文本压到每条不超过 maxChars：优先在软标点处断开，退无可退才硬切。
 * @returns {string[]} 每片都可能带首尾空白，由调用方 trim。
 */
function splitByWidth(text, maxChars) {
  const width = Math.max(1, Math.floor(maxChars))
  if (text.length <= width) return [text]
  const out = []
  let index = 0
  while (index < text.length) {
    if (text.length - index <= width) { out.push(text.slice(index)); break }
    const limit = index + width
    let cut = -1
    for (let probe = limit; probe > index; probe -= 1) {
      if (SOFT_BREAK.test(text[probe - 1])) { cut = probe; break }
    }
    if (cut === -1) cut = limit
    cut = safeSliceIndex(text, cut)
    // 退化保护：safeSliceIndex 理论上不会小于 index+1，这里再兜一层，防止死循环。
    if (cut <= index) cut = Math.min(text.length, index + width)
    out.push(text.slice(index, cut))
    index = cut
  }
  return out
}

/**
 * 把逐条消息压到 maxMessages 以内。**不丢内容**：多余的字并进前面的消息里，
 * 宁可某一条长一点，也不要让角色「说了半句就没了」。
 */
function packMessages(messages, maxMessages) {
  const limit = Math.max(1, Math.floor(maxMessages))
  if (messages.length <= limit) return messages
  const perBucket = Math.ceil(messages.length / limit)
  const out = []
  for (let index = 0; index < messages.length; index += perBucket) {
    out.push(messages.slice(index, index + perBucket).join(''))
  }
  return out
}

/**
 * 把角色写的一段话拆成可以直接逐条发出去的短消息。
 *
 * ## 气泡边界（对齐上游 rc36 的协议）
 *
 * 上游口径：**换行不构成气泡边界，只有 `messageSeparator`（默认 `<sep/>`）才行**。
 * 模型把分隔符写在要说的话之间，表示「这里另起一条」。
 *
 * `convertNewlineToSeparator` 是给小模型留的补救：模型没写分隔符而是用换行
 * 分条时，把换行运行视作边界；**内容里已有显式分隔符时不转换**（避免两套
 * 边界混用把一条话切成碎块）。
 *
 * `splitReplyMessages: false` 时整段作为一条发出去（长度与节奏交给场景）。
 *
 * ## 为什么仍按宽度硬切
 *
 * 平台的单条字数上限是**硬约束**，不是文风偏好——超长会被平台截断或拒收。
 * 所以单条超过 `maxChars` 时仍然切：先按句末标点切（读起来完整），
 * 切不动再按软断点硬切。这只在「模型自己写的那一条太长」时发生。
 *
 * @param {string} input 模型写完的原始文本（可含旁白/Markdown）。
 * @param {object} [options]
 * @param {number} [options.maxChars=40] 单条目标字数。
 * @param {number} [options.maxMessages=4] 一次最多发几条。
 * @param {boolean} [options.splitReplyMessages] 是否分条（上游名）。
 * @param {boolean} [options.enabled] 兼容旧名：false = 不分条。
 * @param {string} [options.messageSeparator] 气泡分隔符字面量。
 * @param {boolean} [options.convertNewlineToSeparator] 换行是否也算边界。
 * @returns {string[]} 待发送的消息；空数组表示「这一条没有可发的内容」。
 */
export function splitImText(input, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS
  const maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : DEFAULT_MAX_MESSAGES
  // 分条开关：上游名优先；旧名 `enabled` 作为回退（两者都是 true = 分条）。
  const splitOn = typeof options.splitReplyMessages === 'boolean'
    ? options.splitReplyMessages
    : options.enabled !== false
  const separator = typeof options.messageSeparator === 'string' && options.messageSeparator
    ? options.messageSeparator
    : DEFAULT_MESSAGE_SEPARATOR
  const newlineAsSeparator = options.convertNewlineToSeparator === true

  const cleaned = cleanImText(input)
  if (!cleaned) return []
  // 关掉分条：整段一条（上游 splitReplyMessages:false 的语义）。
  if (!splitOn) return [cleaned]

  /*
   * 切分顺序很重要：**先按分隔符切，再逐段清洗**。
   *
   * 不能反过来。`cleanImText` 是逐行处理的，其中一步会剥掉「行首尾的成对引号」；
   * 而分隔符协议下每条气泡都在同一行里（`"甲"<sep/>"乙"`），
   * 先清洗就会把这一行当成「一个被引号包住的行」，把外层两个引号剥掉，
   * 得到 `甲"<sep/>"乙` —— 引号位置全乱。
   */
  const segments = (() => {
    // 显式分隔符优先。**已有分隔符时不再把换行当边界**（混用会把一条
    // 完整的话切成碎块）。
    if (input.includes(separator)) return String(input).split(separator)
    if (newlineAsSeparator) return String(input).split(/\n+/)
    // 既没有分隔符、也没开换行转换：换行照原样留在文内，整段算一条气泡。
    return [input]
  })()

  const messages = []
  for (const raw of segments) {
    const text = cleanImText(raw)
    if (!text) continue
    // 单条没超上限 → 原样一条（尊重模型给的气泡）。
    if (text.length <= maxChars) {
      messages.push(text)
      continue
    }
    // 超长才切：优先句末，再退软断点／硬切。
    for (const sentence of splitSentences(text)) {
      for (const piece of splitByWidth(sentence, maxChars)) {
        const value = piece.trim()
        if (value) messages.push(value)
      }
    }
  }
  return packMessages(messages, maxMessages)
}

/* ------------------------------------------------------------------ 服务访问 */

/**
 * 取 dsh-im 的投递服务。
 *
 * **必须用 `ctx.get('dshIm')`，不能用 `ctx.dshIm`。**
 *
 * Cordis 里 `ctx.<service>` 这种属性访问只认「**本插件自己 inject 声明的**服务名」
 * （`provide` 会把名字写进提供者的 `props`，属性访问查的正是本 fiber 的 props）。
 * dsh-im 是在它自己的 ctx 上 `provide('dshIm', …)` 的，所以对本插件来说
 * `ctx.dshIm` **永远抛错**——哪怕 dsh-im 加载得好好的、QQ 消息收得进来。
 *
 * 而 `ctx.get('dshIm')` 走的是 root 的 isolate 注册表（`provide` 里
 * `this.ctx.root[symbols.isolate][name] ??= Symbol(name)`），
 * 跨兄弟作用域都能查到，不需要写进 inject。
 *
 * 线上实测的故障就是踩了这个：dsh-im 的客户端模块在 boot manifest 里、
 * QQ 消息正常收发，而插件启动日志写「dsh-im 未加载」，
 * 到点的提醒全部退回被动分支、只留在 DSH 里，发不到 QQ。
 *
 * 注意 `get()` 的默认 `strict: true`：当提供者 fiber 还没进入 ACTIVE 时返回 undefined。
 * 这只会发生在**启动最初那一瞬**；投递发生在到点时刻（通常几分钟后），不受影响。
 * 但启动日志那一行仍可能误报，所以启动日志改为延迟一行播报。
 *
 * @returns {{send: Function}|undefined} 可用的投递服务
 */
export function resolveImService(ctx) {
  // ① 全局注册表查找：跨作用域可靠，这是线上的主路径。
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('dshIm') : undefined
    if (typeof viaGet?.send === 'function') return viaGet
  } catch {
    /* 查不到就继续兜底 */
  }
  // ② 同作用域时的属性访问（本插件若某天把 dshIm 写进 inject，这条就是快路径）。
  try {
    const viaProp = ctx?.dshIm
    if (typeof viaProp?.send === 'function') return viaProp
  } catch {
    /* 跨作用域 / 未 inject 都会抛，当作没有 */
  }
  return undefined
}

/**
 * 把一段文本投递给 IM。
 *
 * @param {object} options
 * @param {object} options.service dsh-im 服务（resolveImService 的结果）
 * @param {{botId: string, targetId: string}} options.binding 投递目标
 * @param {string[]} options.messages 已切分好的消息列表
 * @param {object} [options.chunking] 分条参数（用于 minIntervalMs）
 * @param {number} [options.timeoutMs] 单条投递超时
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @returns {Promise<{ok: boolean, sent: number, sentCount: number, error?: string}>}
 *          全部成功才 ok；失败时 sentCount 是**已确认送达**的条数。
 */
export async function deliverImChunks({
  service, binding, messages, chunking = {}, timeoutMs, signal,
}) {
  if (!binding?.botId || !binding?.targetId) return { ok: false, sent: 0, sentCount: 0, error: 'no-binding' }

  const send = typeof service?.send === 'function' ? service.send : null
  if (!send) return { ok: false, sent: 0, sentCount: 0, error: 'dsh-im-unavailable' }

  const list = Array.isArray(messages) ? messages.filter(text => typeof text === 'string' && text.trim()) : []
  if (list.length === 0) return { ok: false, sent: 0, sentCount: 0, error: 'no-messages' }

  const gap = Math.max(0, Math.floor(finiteOr(chunking.minIntervalMs, DEFAULT_MIN_INTERVAL_MS)))
  const timeout = Math.max(1000, Math.floor(finiteOr(timeoutMs, DEFAULT_TIMEOUT_MS)))

  let sentCount = 0
  for (const [index, text] of list.entries()) {
    // 已经送到几条，就把剩下的原样带回去。
    // 这是「重试不该重新生成内容」的支点：调用方据此重发**同一段文字**，
    // 而不是把待办放回 pending 让模型再写一遍（那既多花一次全量上下文，
    // 也可能写出一句不同的话，用户会看到前言不搭后语的重复）。
    const partial = error => ({
      ok: false, sent: sentCount, sentCount, error,
      remaining: list.slice(index),
    })
    if (signal?.aborted) return partial('cancelled')
    if (index > 0 && gap > 0) await delay(gap)

    // 每条独立超时：某一条卡住不该让后面全部陪葬更久。
    const timeoutSignal = AbortSignal.timeout(timeout)
    const combined = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal

    let result
    try {
      result = await send.call(service, binding.botId, binding.targetId, text, { signal: combined })
    } catch (error) {
      return partial(error?.code ?? error?.name ?? 'delivery-failed')
    }
    // 服务返回 { sent: true } 才算确认；静默返回值一律当作未确认，宁可重试也不假装送达。
    if (result?.sent !== true) {
      return partial('delivery-not-confirmed')
    }
    sentCount += 1
  }

  return { ok: true, sent: sentCount, sentCount }
}

/** 解析配置里的分条参数（缺省合并默认值）。 */
export function resolveImChunking(config = {}) {
  const source = config.chunking ?? {}
  return {
    // 上游名优先；旧名 `enabled` 作为回退。关闭时整段一条。
    splitReplyMessages: typeof source.splitReplyMessages === 'boolean'
      ? source.splitReplyMessages
      : source.enabled !== false,
    messageSeparator: typeof source.messageSeparator === 'string' && source.messageSeparator
      ? source.messageSeparator
      : DEFAULT_MESSAGE_SEPARATOR,
    convertNewlineToSeparator: source.convertNewlineToSeparator === true,
    maxChars: Math.min(500, Math.max(1, Math.round(finiteOr(source.maxChars, DEFAULT_MAX_CHARS)))),
    maxMessages: Math.min(10, Math.max(1, Math.round(finiteOr(source.maxMessages, DEFAULT_MAX_MESSAGES)))),
    minIntervalMs: Math.min(10_000, Math.max(0, Math.round(finiteOr(source.minIntervalMs, DEFAULT_MIN_INTERVAL_MS)))),
  }
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 解析生效的 IM 绑定：会话级绑定优先于配置默认值。
 *
 * @param {object} state 会话状态。
 * @param {object} config 生效配置。
 * @returns {{botId: string, targetId: string, source: 'session'|'config'}|undefined}
 */
export function resolveImBinding(state, config) {
  const session = state?.imBinding
  if (typeof session?.botId === 'string' && session.botId && typeof session?.targetId === 'string' && session.targetId) {
    return { botId: session.botId, targetId: session.targetId, source: 'session' }
  }
  const im = config?.im
  if (im?.enabled && typeof im.botId === 'string' && im.botId && typeof im.targetId === 'string' && im.targetId) {
    return { botId: im.botId, targetId: im.targetId, source: 'config' }
  }
  return undefined
}

