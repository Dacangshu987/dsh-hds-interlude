/**
 * 出站：分条 / 投递 / 回执 / 重试。
 *
 * dsh-im 把最终 assistant 文本整体投递（QQ 侧只在 4500 字才切分），
 * 所以一条 200 字的回复会变成一整块气泡。真人聊天不是这样的。
 *
 * 这里做三件事：
 *   1. 分条 —— 按语义边界切成若干条短消息，并限制条数（「一条一事」）；
 *   2. 投递 —— 逐条发送，**全部成功才算成功**；
 *   3. 回执 —— 记下成功条数 / 错误码 / 时间，供重试与自检。
 *
 * 分条与「投递记账」是纯函数（可单测）；`deliverMessages` 只依赖一个注入的
 * `send` 回调，因此不需要真实 QQ 连接也能验证失败、部分成功与重试语义。
 *
 * **重试原则**：失败保留原文，下一轮**重发同一段**，而不是重新生成。
 * 重新生成既多花一次全量上下文，也可能写出一句不同的话——
 * 用户会看到前言不搭后语的重复。
 *
 * ## 合并要点
 *
 * 分条**不再自己实现**，而是复用 `../im.js` 的 `splitImText`——
 * 那是 hds-interlude 一直在用的实现，行为必须与既有的主动投递路径一致。
 * 两套分条算法并存会让同一个角色在不同路径下发消息的节奏不一致。
 *
 * @module dsh-hds-interlude/qq-im/outbound
 */

import { splitImText } from '../im.js'

const DEFAULT_MAX_CHARS = 40
const DEFAULT_MAX_MESSAGES = 4
const DEFAULT_MIN_INTERVAL_MS = 400
const DEFAULT_TIMEOUT_MS = 15_000
/** 打字模拟默认值（上游 1.0.1 系列既有参数）。 */
const DEFAULT_TYPING_BASE_SECONDS = 1
const DEFAULT_TYPING_CPS = 8
const DEFAULT_TYPING_MAX_SECONDS = 12
const DEFAULT_TYPING_JITTER = 0.3

/* ------------------------------------------------------------------ 投递幂等 */

/**
 * 投递幂等（移植自上游 `1.0.1-rc33` 的 P1-1 修复）。
 *
 * ## 它解决什么
 *
 * 上游场景：桌面 worker 30s 超时后用**新 deliveryId** 重发同一条消息，而
 * 上游其实已经收到、只是回执迟到——用户收到两条一模一样的消息。
 * 修复：每条消息带一个**重试间稳定**的业务幂等键（`eventId:bubbleIndex`），
 * 宿主 outbox 据此跨 deliveryId 去重。
 *
 * 本仓等价场景：主动投递部分成功后，`pendingText/pendingRemaining` 会在下一轮
 * **重发同一批内容**。若失败原因是「超时 / 未确认」（消息可能已经到了 QQ，
 * 只是回执没回来），重发时已确认送达的那几条会被再次发送。
 *
 * ## 口径（与上游一致）
 *
 * **宁可少发一条，不给用户重复消息。** 两种失败要分开：
 *   - **确定失败**（连接被拒、无目标等）——消息一定没到，重发是安全的；
 *   - **歧义失败**（超时、未确认）——消息可能已经到了，重试按「疑似已送达」
 *     处理：同键的条目在后续投递中跳过。
 *
 * 窗口存活期覆盖主动重试链的长度（≥ 3 次尝试 × 扫描周期），过期自动作废
 * ——正常情况下用户几天内不会收到同一条消息，窗口只是防线不是账本。
 */

/** 「疑似已送达」窗口默认存活期（小时）。 */
const DEFAULT_INTENT_TTL_HOURS = 6
/** 窗口默认容量上限。 */
const DEFAULT_INTENT_MAX_ENTRIES = 500

/**
 * 判断一次投递失败是否属于「歧义」：消息可能已经送到了。
 *
 * 判据来自 `deliverMessages` 的既有错误分类：
 *   - `delivery-not-confirmed`：服务没有明确确认（最典型的歧义）；
 *   - `timeout` 系：本地等不到回执；
 *   - 抛出的错误没有结构化 code（网络层异常，结果不可知）。
 * 确定失败（no-target / no-messages / im-unavailable / cancelled 等）不在此列。
 *
 * @param {string|undefined} error 投递错误码。
 * @returns {boolean}
 */
export function isAmbiguousDeliveryError(error) {
  const code = String(error ?? '')
  if (!code) return true
  if (code === 'delivery-not-confirmed') return true
  if (code === 'cancelled') return false
  if (/timeout|timed?\s?out/i.test(code)) return true
  // 结构化错误码（SDK 的可重试/凭据分类等）视为确定失败。
  return false
}

/**
 * 为一批待发条目推导业务幂等键。
 *
 * 键稳定规则（重试间不变）：显式传入的 `item.intentKey` 优先；否则用
 * `intentPrefix + 序号`。序号锚定在**整批**上（`baseIndex + 位置`），这样
 * 「第一批 4 条送了 2 条、第二轮重发 remaining 2 条」时，重发条目的键与
 * 第一轮里它们原本的键一致——这正是跨尝试去重要求的稳定性。
 *
 * 传了 `remainingKeys`（续发模式）时以它为准；**比条目短的尾部一律给空串**
 * ——键对不上就宁可不去重，也绝不能用序号键瞎猜（那会与首轮的键碰撞，
 * 把没发过的条目误拦掉）。
 *
 * @param {Array<string|object>} items 待发条目（已归一化前的外部形态）。
 * @param {object} [options]
 * @param {string} [options.intentPrefix] 业务前缀（如意图 id）。
 * @param {number} [options.baseIndex=0] 本批在整次投递里的起始序号。
 * @param {string[]} [options.remainingKeys] 重发条目**原有的键**（与 items 对齐）。
 * @returns {string[]} 与 items 等长的键数组；无前缀且无显式键时返回空串占位。
 */
export function deriveItemKeys(items, { intentPrefix, baseIndex = 0, remainingKeys } = {}) {
  const list = Array.isArray(items) ? items : []
  const resume = Array.isArray(remainingKeys)
  return list.map((item, offset) => {
    const explicit = item && typeof item === 'object' && typeof item.intentKey === 'string' && item.intentKey
      ? item.intentKey
      : (resume && typeof remainingKeys[offset] === 'string' ? remainingKeys[offset] : '')
    if (explicit) return explicit
    if (resume) return '' // 续发模式下键必须来自上一轮，猜出来的键会碰撞
    if (!intentPrefix) return ''
    return `${intentPrefix}:${baseIndex + offset}`
  })
}

/**
 * 「已确认送达」窗口：业务键 → 确认时刻。
 *
 * 与入站的 `DedupeWindow` 同一形态（惰性清理 + 容量淘汰），但方向相反：
 * 入站窗口记「见过的消息 id」拦重复入站；这里记「确认送达的业务键」拦重复出站。
 */
export class DeliveredIntentWindow {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] 条目存活时长。
   * @param {number} [options.maxEntries] 容量上限。
   * @param {() => number} [options.now] 时钟注入（测试用）。
   */
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_INTENT_TTL_HOURS * 3_600_000
    this.maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : DEFAULT_INTENT_MAX_ENTRIES
    this.now = typeof options.now === 'function' ? options.now : Date.now
    /** @type {Map<string, number>} 业务键 → 确认时刻 */
    this.delivered = new Map()
  }

  /** 清掉过期条目（惰性）。 */
  prune() {
    const cutoff = this.now() - this.ttlMs
    for (const [key, at] of this.delivered) {
      if (at >= cutoff) break
      this.delivered.delete(key)
    }
    while (this.delivered.size >= this.maxEntries) {
      const oldest = this.delivered.keys().next()
      if (oldest.done) break
      this.delivered.delete(oldest.value)
    }
  }

  /**
   * 这个业务键近期已确认送达吗？
   * @param {string} key 业务键。
   */
  has(key) {
    if (typeof key !== 'string' || !key) return false
    const at = this.delivered.get(key)
    return at !== undefined && this.now() - at < this.ttlMs
  }

  /**
   * 记一次「确认送达」（ delivered 与「疑似已送达」共用一张表：窗口的语义是
   * 「这个键的消息已经到了用户那边」——无论是回执确认还是歧义保守认定）。
   * @param {string} key 业务键。
   */
  mark(key) {
    if (typeof key !== 'string' || !key) return
    this.prune()
    this.delivered.set(key, this.now())
  }

  /** 当前条目数（自检/测试用）。 */
  size() {
    return this.delivered.size
  }
}

/** 数值夹取（非有限值回退）。 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 解析出一个有限数字；不可用时回落到默认值（注意 0 是合法值）。 */
export function finiteOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 把要发的一段话拆成可以直接逐条发出去的短消息。
 *
 * 输入应当**已经**是 say.js 判定过的台词（已清洗）。`splitImText` 内部会再清洗
 * 一次——那是幂等的（已实测），所以重复调用不会丢字或改字，
 * 反而多了一层「万一上游漏洗」的保险。
 *
 * @param {string} input 待发送文本（可含多行）。
 * @param {object} [options]
 * @param {number} [options.maxChars=40] 单条目标字数。
 * @param {number} [options.maxMessages=4] 一次最多发几条。
 * @returns {string[]} 待发送的消息；空数组表示「没有可发的内容」。
 */
export function splitOutboundText(input, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS
  const maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : DEFAULT_MAX_MESSAGES
  return splitImText(input, { maxChars, maxMessages })
}

/* ------------------------------------------------------------------ 媒体条目 */

/** 允许作为图片来源的 URL 协议。刻意排除 file:/data: —— 见 normalizeImageSource。 */
const IMAGE_URL_PROTO = /^https?:\/\//i

/** 允许的图片扩展名（与 SDK 的 isImageFile 白名单一致）。 */
const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|bmp)$/i

/**
 * 归一化一条「要发的东西」，得到投递链统一消费的条目。
 *
 * 两种条目：
 *   - `{ kind: 'text', text }`   —— 一条文字消息；
 *   - `{ kind: 'image', source }` —— 一张图片，source 为 `{ url }` 或 `{ localPath }`。
 *
 * 为什么要有这个统一形态：图片和文字必须能**按模型调用顺序交错**发出
 * （先发张图逗一下、再补一句话，是真人聊天的常态）。若把文字和图片分成
 * 两条队列各自投递，顺序就丢了。
 *
 * @param {object} raw 原始条目。
 * @returns {object|null} 归一化后的条目；无法识别返回 null。
 */
export function normalizeItem(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? { kind: 'text', text } : null
  }
  if (!raw || typeof raw !== 'object') return null
  if (raw.kind === 'image' || raw.image !== undefined) {
    const source = normalizeImageSource(raw.image ?? raw.source ?? raw)
    return source ? { kind: 'image', source } : null
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  return text ? { kind: 'text', text } : null
}

/**
 * 校验并归一化一个图片来源。
 *
 * 接受两种来源（SDK 的 `uploadMedia` 原生支持两者）：
 *   - `localPath` —— 本地文件路径；
 *   - `url`       —— http(s) 网络地址。
 *
 * **只放行 http/https**：`file:` / `data:` / 其它协议一律拒绝。
 * 理由不是洁癖——`url` 会被原样交给 QQ 服务器去拉取，放行 `file:` 等于把
 * 本机文件读取变成一次远程请求；`data:` 则会把任意大小的 base64 塞进请求体。
 * 本地文件有 `localPath` 这条正路，不需要借 `url` 绕。
 *
 * @param {object|string} raw 图片描述对象，或直接给路径/URL 字符串。
 * @returns {{url: string}|{localPath: string}|null} 归一化来源；非法返回 null。
 */
export function normalizeImageSource(raw) {
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (!value) return null
    return IMAGE_URL_PROTO.test(value) ? { url: value } : { localPath: value }
  }
  if (!raw || typeof raw !== 'object') return null

  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (url) return IMAGE_URL_PROTO.test(url) ? { url } : null

  const localPath = typeof raw.localPath === 'string' ? raw.localPath.trim()
    : typeof raw.file_path === 'string' ? raw.file_path.trim()
      : typeof raw.filePath === 'string' ? raw.filePath.trim() : ''
  if (localPath) return { localPath }

  // 只给了裸字符串字段就退化成字符串处理。
  const bare = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (bare) return IMAGE_URL_PROTO.test(bare) ? { url: bare } : { localPath: bare }

  return null
}

/** 图片来源是否指向一张「看起来像图片」的本地文件（URL 来源不检查扩展名）。 */
export function looksLikeImageSource(source) {
  if (!source) return false
  if (source.url) return true
  return typeof source.localPath === 'string' && IMAGE_EXT.test(source.localPath)
}

/**
 * 把归一化条目还原成「外部可见」的形态。
 *
 * 文字条目还原成**字符串**，图片条目保持对象。这是刻意的向后兼容：
 * `deliverMessages` 的既有调用方（分条路径、投递记账、测试替身）都按
 * 「传进来是字符串、`remaining` 也是字符串数组」写的。若统一暴露成
 * `{kind:'text'}` 对象，所有老调用点都会静默变成「发不出内容」。
 *
 * @param {object} item 归一化条目。
 * @returns {string|object} 文字 → 字符串；图片 → 对象。
 */
export function toExternalItem(item) {
  return item?.kind === 'text' ? item.text : item
}

/**
 * 生成一条投递回执（供调用方落盘）。
 *
 * @param {object} result {@link deliverMessages} 的返回值。
 * @param {object} [extra] 附加字段（绑定、来源等）。
 */
export function buildReceipt(result, extra = {}) {
  return {
    at: new Date().toISOString(),
    ok: result?.ok === true,
    sentCount: result?.sentCount ?? 0,
    total: result?.total ?? 0,
    error: result?.error ?? null,
    ...extra,
  }
}

/** 解析配置里的分条参数（缺省合并默认值，并夹到合法范围）。 */
export function resolveChunking(config = {}) {
  const source = config.chunking ?? config ?? {}
  return {
    // 气泡边界协议（对齐上游 rc36）：分隔符字面量 / 换行是否算边界 / 是否分条。
    splitReplyMessages: typeof source.splitReplyMessages === 'boolean'
      ? source.splitReplyMessages
      : source.enabled !== false,
    messageSeparator: typeof source.messageSeparator === 'string' && source.messageSeparator
      ? source.messageSeparator
      : '<sep/>',
    convertNewlineToSeparator: source.convertNewlineToSeparator === true,
    enabled: source.enabled !== false,
    maxChars: Math.min(500, Math.max(1, Math.round(finiteOr(source.maxChars, DEFAULT_MAX_CHARS)))),
    maxMessages: Math.min(10, Math.max(1, Math.round(finiteOr(source.maxMessages, DEFAULT_MAX_MESSAGES)))),
    minIntervalMs: Math.min(10_000, Math.max(0, Math.round(finiteOr(source.minIntervalMs, DEFAULT_MIN_INTERVAL_MS)))),
    // 打字模拟（移植自上游 1.0.1-rc21 所沿用的既有参数；上游默认 1s / 8 字每秒 / 12s / 0.3）。
    typingBaseDelaySeconds: clampNumber(source.typingBaseDelaySeconds, 0, 60, DEFAULT_TYPING_BASE_SECONDS),
    typingCharactersPerSecond: clampNumber(source.typingCharactersPerSecond, 1, 100, DEFAULT_TYPING_CPS),
    typingMaxDelaySeconds: clampNumber(source.typingMaxDelaySeconds, 0, 120, DEFAULT_TYPING_MAX_SECONDS),
    typingJitterRatio: clampNumber(source.typingJitterRatio, 0, 0.5, DEFAULT_TYPING_JITTER),
  }
}

/**
 * 模拟「她在打字」的等待时长（移植自上游 `typingDelay`）。
 *
 * 算法（逐字对齐上游）：
 *   `delay = clamp(基础延迟 + 字数 / 每秒字数, 0, 最长延迟)`，
 *   再乘 `(1 + jitter × (2r − 1))`，即 ±jitter 比例的随机浮动。
 *
 * @param {string|number} text 本条消息（或字数）。
 * @param {object} chunking `resolveChunking` 的结果。
 * @param {() => number} [random] 随机源（便于测试）。
 * @returns {number} 毫秒。
 */
export function typingDelayMs(text, chunking = {}, random = Math.random) {
  const chars = typeof text === 'number' ? Math.max(0, text) : String(text ?? '').length
  const base = clampNumber(chunking.typingBaseDelaySeconds, 0, 60, DEFAULT_TYPING_BASE_SECONDS)
  const cps = clampNumber(chunking.typingCharactersPerSecond, 1, 100, DEFAULT_TYPING_CPS)
  const max = clampNumber(chunking.typingMaxDelaySeconds, 0, 120, DEFAULT_TYPING_MAX_SECONDS)
  const jitter = clampNumber(chunking.typingJitterRatio, 0, 0.5, DEFAULT_TYPING_JITTER)
  const raw = Math.min(max, Math.max(0, base + chars / cps))
  const roll = typeof random === 'function' ? random() : 0.5
  return Math.max(0, Math.round(raw * (1 + jitter * (roll * 2 - 1)) * 1000))
}

/**
 * 首条发言的**打字时间下限**（移植自上游 `1.0.1-rc21`）。
 *
 * 语义（与上游一致）：以叙事请求发起时刻为基准，模型耗时不足
 * `typingDelay(首条字数)` 时补足等待再发；耗时已超过则立即发送。
 * 只对**当前对话参与者的首条**生效，每次投递至多应用一次；
 * 等待期间新用户消息仍可经 `signal` 打断（上游 `shouldCancel`）。
 *
 * @param {string} text 首条内容。
 * @param {number|undefined} requestStartedAt 叙事请求发起时刻（毫秒）。
 * @param {object} chunking `resolveChunking` 的结果。
 * @param {number} [now] 当前时刻。
 * @param {() => number} [random] 随机源。
 * @returns {number} 还需等待的毫秒数（0 = 立即发）。
 */
export function firstMessageTypingFloorMs(text, requestStartedAt, chunking = {}, now = Date.now(), random = Math.random) {
  if (!Number.isFinite(requestStartedAt)) return 0
  const target = typingDelayMs(text, chunking, random)
  // 防御：起点时间戳异常（时钟偏差）不会反向放大等待——elapsed 以 0 为下限。
  const elapsed = Math.max(0, now - requestStartedAt)
  return Math.max(0, target - elapsed)
}

/** 解析配置里的投递超时（毫秒）。 */
export function resolveTimeout(config = {}) {
  const value = Math.round(finiteOr(config.timeoutMs, DEFAULT_TIMEOUT_MS))
  return Math.min(120_000, Math.max(1000, value))
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 可打断的等待：`signal` 中止时**立即**返回（不把这段等待耗完）。
 *
 * 上游语义（rc21）：首条打字下限与分段等待期间到达的新用户消息可以打断投递，
 * 调用方据 `shouldCancel` 放弃这一批。
 */
function interruptibleDelay(ms, signal) {
  if (typeof signal?.addEventListener !== 'function') return delay(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener?.('abort', onAbort); resolve() }, ms)
    function onAbort() { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 逐条投递，**全部成功才算成功**。
 *
 * 条目可以是文字，也可以是图片，**按数组顺序交错发出**——顺序就是模型调用
 * 发言工具的顺序。某一条失败时立刻停下并返回 `remaining`（含失败的那一条及
 * 其后所有条目），调用方据此重发**同一批内容**而不是重新生成。
 *
 * 图片失败是**可容忍**的：`onImageError` 给出降级文案时，该条会被替换成一句
 * 文字继续投递，而不是让整轮发言失败。理由：模型想发表情包却发不出去时，
 * 对方会**完全收不到任何回应**（比文字丢失严重得多）；退化成一句「[图片发送失败]」
 * 至少让对话能继续。降级与否由调用方决定（它才知道该不该提这件事）。
 *
 * @param {object} options
 * @param {(targetId: string, item: object, extra?: object) => Promise<{sent?: boolean, id?: string}>} options.send
 *   单条发送回调。收到的是**归一化后的条目**（`{kind:'text'}|{kind:'image'}`）。
 *   返回 `{ sent: true }` 才算确认送达。
 * @param {string} options.targetId 投递目标（openid）。
 * @param {Array<string|object>} options.messages 已切分好的条目（字符串按文字处理）。
 * @param {object} [options.chunking] 分条参数（用 minIntervalMs）。
 * @param {number} [options.timeoutMs] 单条投递超时。
 * @param {AbortSignal} [options.signal] 外部取消信号。
 * @param {(error: any, item: object) => string|undefined} [options.onImageError]
 *   图片投递失败时的降级回调。返回字符串则把它当作一条文字消息继续发；
 *   返回 undefined/空串则视为不可降级，整轮按失败处理。
 * @param {string[]} [options.intentKeys] 与 messages 对齐的**业务幂等键**
 *   （重试间稳定；见「投递幂等」段）。与 `deliveredWindow` 配合启用去重。
 * @param {DeliveredIntentWindow} [options.deliveredWindow] 已确认送达窗口。
 *   提供时：键命中的条目**直接视为已送达**（计数进 sentCount、不真正发送）。
 * @returns {Promise<{
 *   ok: boolean, sent: number, sentCount: number, total: number, degraded: number,
 *   error?: string, remaining?: object[], receipt: object,
 *   sentKeys?: string[], remainingKeys?: string[], ambiguous?: boolean,
 * }>}
 *   `sentCount` 是**已确认送达**的条数；`remaining` 是尚未送出的原文条目，
 *   调用方据此重发**同一批内容**（不重新生成）。`sentKeys`/`remainingKeys`
 *   是与两者对齐的业务键（无键时为空串占位）；`ambiguous` 标记这次失败
 *   是否属于「消息可能已经到了」的歧义失败。
 */
export async function deliverMessages({
  send, targetId, messages, chunking = {}, timeoutMs, signal, reason, onImageError, requestStartedAt,
  intentKeys, deliveredWindow,
}) {
  // 先归一化再过滤：字符串 → 文字条目，对象 → 文字/图片条目。
  // 归一化不了的（空串、无效图片来源）直接丢弃——它们本来就没有可发的内容。
  const list = (Array.isArray(messages) ? messages : [])
    .map(normalizeItem)
    .filter(Boolean)
  const at = () => new Date().toISOString()

  const receipt = (ok, sentCount, error) => ({
    at: at(), reason: reason ?? null, ok, sentCount, total: list.length, error: error ?? null,
  })

  if (typeof targetId !== 'string' || !targetId) {
    return { ok: false, sent: 0, sentCount: 0, total: list.length, degraded: 0, error: 'no-target', receipt: receipt(false, 0, 'no-target') }
  }
  if (typeof send !== 'function') {
    return { ok: false, sent: 0, sentCount: 0, total: list.length, degraded: 0, error: 'im-unavailable', receipt: receipt(false, 0, 'im-unavailable') }
  }
  if (list.length === 0) {
    return { ok: false, sent: 0, sentCount: 0, total: 0, degraded: 0, error: 'no-messages', receipt: receipt(false, 0, 'no-messages') }
  }

  const gap = Math.max(0, Math.floor(finiteOr(chunking.minIntervalMs, DEFAULT_MIN_INTERVAL_MS)))
  const timeout = Math.max(1000, Math.floor(finiteOr(timeoutMs, DEFAULT_TIMEOUT_MS)))

  // 投递幂等（rc33 P1-1）：键与条目按**归一化后**的位置对齐。归一化会丢弃
  // 空串等不可发条目，所以键也要过滤——否则 remaining 的键会错位。
  // 窗口用鸭子类型判别：测试替身不必继承 DeliveredIntentWindow。
  const windowOn = Boolean(deliveredWindow)
    && typeof deliveredWindow.has === 'function'
    && typeof deliveredWindow.mark === 'function'
  const keys = Array.isArray(intentKeys)
    ? list.map((_, i) => (typeof intentKeys[i] === 'string' ? intentKeys[i] : ''))
    : list.map(() => '')
  const sentKeys = []
  let sentCount = 0
  let degraded = 0
  /** 组装成功/部分失败返回值（幂等字段在有键时附带）。 */
  const withKeyFields = (base) => {
    if (!keys.some(Boolean)) return base
    return {
      ...base,
      sentKeys: [...sentKeys],
      remainingKeys: keys.slice(sentKeys.length),
      ...(base.ok === false ? { ambiguous: isAmbiguousDeliveryError(base.error) } : {}),
    }
  }
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    // 已经送到几条，就把剩下的原样带回去——这是「重试不重新生成」的支点。
    // 注意 remaining 是**条目**，不是字符串：图片也要能原样重发。
    // 文字条目用外部形态（字符串）暴露，保持与既有调用方兼容。
    //
    // 歧义失败（超时/未确认）：在发的那条**可能已经到了**。按上游口径
    // 「宁可少发一条，不给用户重复消息」，把它的键标进窗口——续发时
    // 这一条会被幂等闸拦下，后面的条目照常发。
    const partial = (error) => {
      if (windowOn && keys[index] && isAmbiguousDeliveryError(error)) deliveredWindow.mark(keys[index])
      return withKeyFields({
        ok: false, sent: sentCount, sentCount, total: list.length, degraded, error,
        remaining: list.slice(index).map(toExternalItem), receipt: receipt(false, sentCount, error),
      })
    }

    // 幂等闸（在一切节奏与发送之前）：这个键的业务消息近期已确认送达
    // ——直接视为已送达，不再真发（口径：宁可少发一条，不给用户重复消息）。
    // 注意放行 cancel 检查之前先计数，保证 sentKeys 与 sentCount 对齐。
    if (windowOn && keys[index] && deliveredWindow.has(keys[index])) {
      sentCount += 1
      sentKeys.push(keys[index])
      continue
    }

    if (signal?.aborted) {
      // 取消是「确定没发」：当前条目不标疑似已送达，整批原样退回。
      return withKeyFields({
        ok: false, sent: sentCount, sentCount, total: list.length, degraded, error: 'cancelled',
        remaining: list.slice(index).map(toExternalItem), receipt: receipt(false, sentCount, 'cancelled'),
      })
    }

    // 节奏（移植自上游 1.0.1-rc21 与既有的打字模拟）：
    //   首条：以**叙事请求发起时刻**为基准补足打字时间下限——模型回得快也先"打一会儿"；
    //        耗时已超过下限则立即发；等待期间可用 signal 打断。
    //   后续分段：等待打字时长（按本条字数），并以本地 `minIntervalMs` 作为下限
    //        （上游没有这一层，是本仓为防平台限流保留的额外保护）。
    const textOf = (entry) => (typeof entry === 'string' ? entry : String(entry?.text ?? ''))
    if (sentCount === 0) {
      // 首条：补足打字下限（等待期间可被新用户消息打断）。
      const floor = firstMessageTypingFloorMs(textOf(item), requestStartedAt, chunking)
      // 首条：补足打字下限。**只有这一层可被打断**（上游 rc21 明确：
      // 「等待期间到达的新用户消息仍可经 shouldCancel 打断」）——被打断则
      // 首条不发、整批作废（用户已经又说话了，这一轮改由新回合处理）。
      if (floor > 0) {
        await interruptibleDelay(floor, signal)
        if (signal?.aborted) return partial('cancelled')
      }
    } else {
      // 分段：等待打字时长与本地 `minIntervalMs` 的较大者。
      //
      // **图片不参与打字模拟**：它不是「打出来的」内容，若按空文本回落到基础延迟
      // （默认 1 秒）会把「图 + 文」的投递整体拖慢，甚至把图片推出调用方的等待窗口。
      // 图片只受本地 `minIntervalMs`（防平台限流）约束。
      //
      // 分段等待刻意**不**受 signal 影响——保持本函数原有语义（每条开头检查一次中止），
      // 否则外层 signal 在打字期间被中止会把整批剩余内容（含图片）一起丢掉。
      const wait = item?.kind === 'image' ? gap : Math.max(gap, typingDelayMs(textOf(item), chunking))
      if (wait > 0) await delay(wait)
    }

    // 每条独立超时：某一条卡住不该让后面全部陪葬更久。
    const timeoutSignal = AbortSignal.timeout(timeout)
    const combined = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal

    let result
    try {
      result = await send(targetId, toExternalItem(item), { signal: combined, kind: item.kind })
    } catch (error) {
      // 图片失败 → 问调用方能不能降级成文字；不能才整轮失败。
      const fallback = item.kind === 'image' && typeof onImageError === 'function'
        ? onImageError(error, item)
        : undefined
      if (fallback) {
        degraded += 1
        try {
          // 降级消息同样要按真实投递记账——它也是一条发出去的消息。
          const retry = await send(targetId, String(fallback), { signal: combined, kind: 'text' })
          if (retry?.sent === true) {
            sentCount += 1
            // 降级文字同样按原键入账——对用户而言它顶替了那条图片。
            if (windowOn && keys[index]) deliveredWindow.mark(keys[index])
            sentKeys.push(keys[index])
            continue
          }
        } catch { /* 降级也失败 → 按原错误整轮失败 */ }
        return partial(error?.code ?? error?.name ?? 'delivery-failed')
      }
      return partial(error?.code ?? error?.name ?? 'delivery-failed')
    }
    // 只有 { sent: true } 才算确认；静默返回值一律当作未确认，宁可重试也不假装送达。
    if (result?.sent !== true) return partial('delivery-not-confirmed')
    sentCount += 1
    // 确认送达 → 记入窗口（「疑似已送达」已在 partial 里按歧义口径处理）。
    if (windowOn && keys[index]) deliveredWindow.mark(keys[index])
    sentKeys.push(keys[index])
  }

  return withKeyFields({
    ok: true, sent: sentCount, sentCount, total: list.length, degraded,
    receipt: receipt(true, sentCount, null),
  })
}
