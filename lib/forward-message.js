/**
 * QQ 合并转发读取（移植自上游 `1.0.1-rc6` 的 `src/forward-message.ts`，
 * 188 行；设计文档 `docs/FORWARD_MESSAGE_READING_DESIGN.md`）。
 *
 * ## 它解决什么
 *
 * 合并转发（聊天记录打包）在入站时只是一个「资源 id」，正文不在消息体里。
 * 不读的话，模型只看到一句「[合并转发]」——用户精心打包的一段上下文凭空消失；
 * 读的话，必须**有预算**：转发可以嵌套、单个转发可以有几十个节点，
 * 无节制地展开会把上下文撑爆、还可能被用来注入。
 *
 * ## 预算（上游默认，逐字对齐）
 *
 * | 参数 | 默认 | 夹取范围 |
 * |---|---|---|
 * | `maxNodes` | 30 | 1–100 |
 * | `maxCharacters` | 8000 | 500–32000 |
 * | `maxDepth` | 3 | 0–8 |
 *
 * 节点与字符都用完即停，并在末尾追加
 * `[合并转发内容已按安全预算截断]`——**如实标注截断**，不让模型以为那就是全部。
 *
 * ## DSH 侧适配（唯一差别，已在文档记录）
 *
 * 上游用 OneBot 的 `internal._request('get_forward_msg', { id })` 取节点
 * （30 秒超时 + 逐层递归）。本仓的 QQ 通道是官方 SDK，**没有这个接口**，
 * 因此把取数做成**可注入的 fetcher**（与 `side-task.js` / `world-seeder.js` 同一模式）：
 * `readForwardContent({ content, fetchNodes })`。未注入 fetcher 时退回
 * 「只给占位」——也就是上游在读取失败时的降级形态，绝不把裸标记漏给模型。
 *
 * @module dsh-hds-interlude/forward-message
 */

/** 默认预算（上游 `DEFAULT_LIMITS`）。 */
export const DEFAULT_FORWARD_LIMITS = { maxNodes: 30, maxCharacters: 8000, maxDepth: 3 }

const clampInt = (value, min, max, fallback) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

/**
 * 规整读取预算（对齐上游 `forwardReadLimits`）。
 *
 * @param {object} [value] 用户配置。
 * @returns {{maxNodes: number, maxCharacters: number, maxDepth: number}}
 */
export function forwardReadLimits(value) {
  return {
    maxNodes: clampInt(value?.maxNodes, 1, 100, DEFAULT_FORWARD_LIMITS.maxNodes),
    maxCharacters: clampInt(value?.maxCharacters, 500, 32_000, DEFAULT_FORWARD_LIMITS.maxCharacters),
    maxDepth: clampInt(value?.maxDepth, 0, 8, DEFAULT_FORWARD_LIMITS.maxDepth),
  }
}

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/**
 * 从消息体里抽出合并转发的资源 id（对齐上游 `extractForwardIds`）。
 *
 * 兼容两种形态：
 *   - 元素形态 `<forward id="…"/>`（`attrs` 或 `data` 里带 id / res_id / forward_id）；
 *   - CQ 码形态 `[CQ:forward,id=…]`。
 *
 * 刻意**只做提取不做展开**——展开与否由预算与 fetcher 决定。
 *
 * @param {unknown} content 原始消息内容（字符串或结构化元素）。
 * @returns {string[]} 去重后的资源 id（长度上限 512）。
 */
export function extractForwardIds(content) {
  const ids = []
  const add = (value) => {
    const id = String(value ?? '').trim()
    if (id && id.length <= 512 && !ids.includes(id)) ids.push(id)
  }
  // 元素形态：递归找 type === 'forward'。
  const visit = (element) => {
    if (!element || typeof element !== 'object') return
    if (String(element.type ?? '').toLowerCase() === 'forward') {
      const attrs = { ...(asRecord(element.attrs)), ...(asRecord(element.data)) }
      add(attrs.id ?? attrs.res_id ?? attrs.forward_id)
    }
    for (const child of element.children ?? []) {
      if (Array.isArray(child)) for (const item of child) visit(item)
      else visit(child)
    }
  }
  if (Array.isArray(content)) for (const element of content) visit(element)
  else if (content && typeof content === 'object') visit(content)

  // CQ 码形态。
  const raw = typeof content === 'string' ? content : ''
  for (const match of raw.matchAll(/\[CQ:forward,([^\]]+)\]/gi)) {
    const fields = {}
    for (const field of match[1].split(',')) {
      const index = field.indexOf('=')
      if (index > 0) fields[field.slice(0, index).trim().toLowerCase()] = field.slice(index + 1).trim()
    }
    add(fields.id ?? fields.res_id ?? fields.forward_id)
  }
  // 标签形态的字符串（SDK 有时把富文本原文直接给成字符串）。
  // 上游这里走真实 HTML 解析器（`h.parse`）；本仓用标签正则覆盖同一批属性，
  // 免得「字符串里带 <forward id>」这条最常见的入站形态漏读。
  for (const match of raw.matchAll(/<forward\b[^>]*\/?>/gi)) {
    const attrs = match[0]
    const id = /(?:id|res_id|forward_id)\s*=\s*["']?([^"'\s/>]+)["']?/i.exec(attrs)?.[1]
    add(id)
  }
  return ids
}

/**
 * 把转发节点渲染成**有预算的纯文本**（对齐上游 `normalizeForwardMessages`）。
 *
 * 形态：首行 `[合并转发内容｜节点数 N]`，每个节点一行 `[节点 k｜昵称（QQ）｜类型]`，
 * 其后是各段的文字化；超预算即截断并追加显式标注。
 *
 * @param {unknown[]} messages 节点数组（OneBot `get_forward_msg` 的 `messages` 形态）。
 * @param {object} [limits] 预算。
 * @param {number} [depth] 当前递归深度。
 * @returns {{content: string, nodeCount: number, forwardCount: number, truncated: boolean, failed: boolean}}
 */
export function normalizeForwardMessages(messages, limits = {}, depth = 0) {
  const budget = forwardReadLimits(limits)
  const list = Array.isArray(messages) ? messages : []
  const lines = [`[合并转发内容｜节点数 ${list.length}]`]
  let used = lines[0].length
  let nodeCount = 0
  let forwardCount = 0
  let truncated = false
  let failed = false
  const append = (value) => {
    const remaining = budget.maxCharacters - used
    if (remaining <= 0) {
      truncated = true
      return false
    }
    const clipped = value.length > remaining ? `${value.slice(0, Math.max(0, remaining - 5))}[截断]` : value
    lines.push(clipped)
    used += clipped.length + 1
    if (clipped !== value) truncated = true
    return clipped === value
  }
  for (const rawNode of list) {
    if (nodeCount >= budget.maxNodes) {
      truncated = true
      break
    }
    const node = asRecord(rawNode)
    nodeCount += 1
    const sender = String(node.nickname ?? asRecord(node.sender).nickname ?? node.user_id ?? '未知发送者').trim() || '未知发送者'
    const userId = String(node.user_id ?? asRecord(node.sender).user_id ?? '').trim()
    const label = userId ? `${sender}（${userId}）` : sender
    const type = String(node.message_type ?? '').trim()
    append(`[节点 ${nodeCount}｜${label}${type ? `｜${type}` : ''}]`)
    const segments = Array.isArray(node.message) ? node.message : []
    const body = normalizeForwardSegments(segments, budget, depth)
    forwardCount += body.forwardCount
    failed ||= body.failed
    for (const line of body.lines) if (!append(line)) break
    if (body.truncated) truncated = true
  }
  if (truncated) append('[合并转发内容已按安全预算截断]')
  return { content: lines.join('\n'), nodeCount, forwardCount, truncated, failed }
}

/** 单节点内的段渲染（对齐上游 `normalizeForwardSegments`）。 */
function normalizeForwardSegments(segments, limits, depth) {
  const lines = []
  let forwardCount = 0
  const truncated = false
  const failed = false
  for (const raw of Array.isArray(segments) ? segments : []) {
    const segment = asRecord(raw)
    const type = String(segment.type ?? '').toLowerCase()
    const data = asRecord(segment.data)
    if (type === 'text') {
      const text = String(data.text ?? '').trim()
      if (text) lines.push(text)
    } else if (type === 'at') {
      const name = String(data.name ?? data.qq ?? data.user_id ?? '').trim()
      lines.push(name ? `[@${name}]` : '[@]')
    } else if (type === 'reply') {
      const id = String(data.id ?? '').trim()
      lines.push(id ? `[回复消息 ${id}]` : '[回复]')
    } else if (type === 'forward') {
      forwardCount += 1
      const id = String(data.id ?? data.res_id ?? data.forward_id ?? '').trim()
      if (depth >= limits.maxDepth) {
        lines.push(id ? `[嵌套合并转发，已达到深度上限｜${id}]` : '[嵌套合并转发，已达到深度上限]')
      } else {
        lines.push(id ? `[嵌套合并转发｜资源 ${id}；需要递归读取]` : '[嵌套合并转发；资源标识缺失]')
      }
    } else if (type === 'image' || type === 'img') lines.push('[图片]')
    else if (type === 'record' || type === 'audio') lines.push('[语音]')
    else if (type === 'video') lines.push('[视频]')
    else if (type === 'file') {
      const name = String(data.name ?? data.file ?? '').trim()
      lines.push(`[文件${name ? `：${name}` : ''}]`)
    } else if (type) lines.push(`[未支持的消息类型：${type}]`)
  }
  return { lines, forwardCount, truncated, failed }
}

/**
 * 读取合并转发正文（对齐上游 `readForwardContent`，取数改为可注入）。
 *
 * 上游用 OneBot `get_forward_msg` 递归取节点（30 秒超时、逐层受限）。
 * 本仓把它拆成 `fetchNodes(id)`——宿主注入后即可复用整套预算与递归逻辑。
 *
 * @param {object} options
 * @param {unknown} options.content 原始消息内容（用于提取 id）。
 * @param {(id: string) => Promise<unknown[]>} [options.fetchNodes] 取节点的执行器。
 * @param {object} [options.limits] 预算。
 * @param {string[]} [options.ids] 直接给出资源 id（跳过提取）。
 * @returns {Promise<object>} 读取结果：`{ok, content, ids, nodeCount, forwardCount, truncated, failed, error?}`。
 */
export async function readForwardContent({ content, fetchNodes, limits = {}, ids } = {}) {
  const budget = forwardReadLimits(limits)
  const resolvedIds = Array.isArray(ids) && ids.length ? ids.map(String) : extractForwardIds(content)
  if (!resolvedIds.length) return { ok: false, error: 'no-forward-id', ids: [], content: '' }
  if (typeof fetchNodes !== 'function') {
    // 没有取数通道：退回占位形态（上游读取失败时的降级），绝不把裸标记漏给模型。
    const placeholder = normalizeForwardMessages([], budget)
    return { ok: false, error: 'no-fetcher', ids: resolvedIds, ...placeholder, failed: true }
  }
  try {
    const nodes = await fetchForwardNodes(fetchNodes, resolvedIds[0], budget, 0)
    const result = normalizeForwardMessages(nodes, budget)
    return { ok: true, ids: resolvedIds, ...result }
  } catch (error) {
    const placeholder = normalizeForwardMessages([], budget)
    return { ok: false, error: error?.message ?? String(error), ids: resolvedIds, ...placeholder, failed: true }
  }
}

/**
 * 递归取节点（对齐上游 `fetchForwardNodes` 的预算语义）。
 *
 * 上游在这里解嵌套：节点里若还有 `forward` 段，就在**剩余预算**内继续取。
 * 本仓保留同一语义，只是把「发请求」换成注入的 `fetchNodes`。
 */
export async function fetchForwardNodes(fetchNodes, id, limits, depth) {
  const budget = forwardReadLimits(limits)
  const response = await fetchNodes(id)
  const record = asRecord(response)
  const messages = Array.isArray(record.messages) ? record.messages : (Array.isArray(response) ? response : [])
  if (depth >= budget.maxDepth) return messages
  let remaining = budget.maxNodes
  const out = []
  for (const rawNode of messages) {
    if (remaining <= 0) break
    remaining -= 1
    out.push(rawNode)
    const node = asRecord(rawNode)
    for (const segment of Array.isArray(node.message) ? node.message : []) {
      const seg = asRecord(segment)
      if (String(seg.type ?? '').toLowerCase() !== 'forward') continue
      const data = asRecord(seg.data)
      const nestedId = String(data.id ?? data.res_id ?? data.forward_id ?? '').trim()
      if (!nestedId || remaining <= 0) continue
      try {
        const nested = await fetchForwardNodes(fetchNodes, nestedId, { ...budget, maxNodes: Math.min(budget.maxNodes, 10) }, depth + 1)
        for (const item of nested) {
          if (remaining <= 0) break
          remaining -= 1
          out.push(item)
        }
      } catch { /* 嵌套读取失败不影响已取到的节点（上游同样只让 failed 标记） */ }
    }
  }
  return out
}
