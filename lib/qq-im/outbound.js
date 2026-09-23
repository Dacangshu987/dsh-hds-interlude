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
    enabled: source.enabled !== false,
    maxChars: Math.min(500, Math.max(1, Math.round(finiteOr(source.maxChars, DEFAULT_MAX_CHARS)))),
    maxMessages: Math.min(10, Math.max(1, Math.round(finiteOr(source.maxMessages, DEFAULT_MAX_MESSAGES)))),
    minIntervalMs: Math.min(10_000, Math.max(0, Math.round(finiteOr(source.minIntervalMs, DEFAULT_MIN_INTERVAL_MS)))),
  }
}

/** 解析配置里的投递超时（毫秒）。 */
export function resolveTimeout(config = {}) {
  const value = Math.round(finiteOr(config.timeoutMs, DEFAULT_TIMEOUT_MS))
  return Math.min(120_000, Math.max(1000, value))
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

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
 * @returns {Promise<{
 *   ok: boolean, sent: number, sentCount: number, total: number, degraded: number,
 *   error?: string, remaining?: object[], receipt: object,
 * }>}
 *   `sentCount` 是**已确认送达**的条数；`remaining` 是尚未送出的原文条目，
 *   调用方据此重发**同一批内容**（不重新生成）。
 */
export async function deliverMessages({
  send, targetId, messages, chunking = {}, timeoutMs, signal, reason, onImageError,
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

  let sentCount = 0
  let degraded = 0
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    // 已经送到几条，就把剩下的原样带回去——这是「重试不重新生成」的支点。
    // 注意 remaining 是**条目**，不是字符串：图片也要能原样重发。
    // 文字条目用外部形态（字符串）暴露，保持与既有调用方兼容。
    const partial = (error) => ({
      ok: false, sent: sentCount, sentCount, total: list.length, degraded, error,
      remaining: list.slice(index).map(toExternalItem), receipt: receipt(false, sentCount, error),
    })

    if (signal?.aborted) return partial('cancelled')
    if (sentCount > 0 && gap > 0) await delay(gap)

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
          if (retry?.sent === true) { sentCount += 1; continue }
        } catch { /* 降级也失败 → 按原错误整轮失败 */ }
        return partial(error?.code ?? error?.name ?? 'delivery-failed')
      }
      return partial(error?.code ?? error?.name ?? 'delivery-failed')
    }
    // 只有 { sent: true } 才算确认；静默返回值一律当作未确认，宁可重试也不假装送达。
    if (result?.sent !== true) return partial('delivery-not-confirmed')
    sentCount += 1
  }

  return {
    ok: true, sent: sentCount, sentCount, total: list.length, degraded,
    receipt: receipt(true, sentCount, null),
  }
}
