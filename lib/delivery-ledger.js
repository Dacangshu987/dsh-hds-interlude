/**
 * 投递账本（Delivery Ledger）—— 移植自上游 `src/script/delivery-ledger.ts`
 * （1.0.0-beta3-m6 原位投递闭环；M6 异常边界修复并入 beta4-m7）。
 *
 * ## 它解决什么
 *
 * 上游把「每个已提交剧本行动」的**投递结果**按段记在同一笔账里：
 *   - 一个行动可能拆成多条气泡（分段消息）、本地媒体、原生表情、群反应；
 *   - 平台执行结果按段回写 `pending | delivered | partial | failed | cancelled`；
 *   - **成功结果不会被较晚的记账错误降级**——`delivered` 是终态；
 *   - `partial` 只表示「已有部分成功」；failed/cancelled 混合不再误报部分送达。
 *
 * DSH 形态下没有 ScriptCommit 单链，但**投递动作**同样存在：`deliverToIm` /
 * `deliverInteractiveSpeech` 把 `interlude_say` 的内容按条发到 QQ。这里的等价物是
 * **一次投递动作 = 一条账**，段 = 投递的消息条目。
 *
 * ## 刻意不做的事
 *
 * 不做第二发送器、不做 Outbox 表：账本只是**记账**，投递时机与重试仍由
 * `index.js` 现有路径负责（与上游 M6.1「本阶段不新增 Outbox 表」一致）。
 *
 * @module dsh-hds-interlude/delivery-ledger
 */

/** 行动级状态（与上游一致）。 */
export const DELIVERY_STATUSES = ['pending', 'delivered', 'partial', 'failed', 'cancelled']

/** 段级状态（与上游一致）。 */
export const SEGMENT_STATUSES = ['pending', 'delivered', 'failed', 'cancelled']

/** 账本默认保留条数。 */
export const DEFAULT_DELIVERY_LIMIT = 40

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

/**
 * 从一次投递的消息列表建段。
 *
 * 每个投递元素（字符串文本或 `{kind:'image',...}` 对象）成为一段；内容取
 * 可读摘要（文本截断、图片用占位），**不存完整正文**——账本只关心状态。
 *
 * @param {Array<unknown>} messages 投递的消息/条目。
 * @returns {Array<object>} 段列表 `{index, kind, content, status:'pending'}`。
 */
export function segmentsFromMessages(messages) {
  if (!Array.isArray(messages)) return []
  const segments = []
  for (const message of messages) {
    let kind = 'message'
    let content = ''
    if (message && typeof message === 'object' && message.kind === 'image') {
      kind = 'local-media'
      content = typeof message.assetId === 'string' ? message.assetId : 'image'
    } else if (typeof message === 'string') {
      content = message.slice(0, 200)
    } else if (message && typeof message === 'object') {
      content = String(message.text ?? message.content ?? '').slice(0, 200)
    }
    segments.push({ index: segments.length, kind, content, status: 'pending' })
  }
  return segments
}

/**
 * 汇总段状态 → 行动级状态（与上游 `aggregateDeliveryStatus` 逐行一致）。
 *
 * @param {Array<object>} segments 段列表。
 * @returns {string} `pending|delivered|partial|failed|cancelled`。
 */
export function aggregateDeliveryStatus(segments) {
  const list = Array.isArray(segments) ? segments : []
  if (!list.length || list.every((item) => item.status === 'pending')) return 'pending'
  if (list.every((item) => item.status === 'delivered')) return 'delivered'
  if (list.some((item) => item.status === 'delivered')) return 'partial'
  if (list.some((item) => item.status === 'pending')) return 'pending'
  if (list.some((item) => item.status === 'failed')) return 'failed'
  return 'cancelled'
}

/**
 * 新建一条投递账。
 *
 * @param {object} draft `{ id, entryId?, at, reason?, segments? }`。
 * @returns {object} 账对象。
 */
export function createDeliveryAction(draft) {
  const d = record(draft)
  const segments = Array.isArray(d.segments) ? d.segments : []
  const at = typeof d.at === 'string' && d.at ? d.at : new Date().toISOString()
  return {
    id: typeof d.id === 'string' || typeof d.id === 'number' ? d.id : String(Date.now()),
    ...(d.entryId !== undefined ? { entryId: d.entryId } : {}),
    ...(typeof d.participantId === 'string' ? { participantId: d.participantId } : {}),
    ...(typeof d.reason === 'string' ? { reason: d.reason.slice(0, 160) } : {}),
    status: aggregateDeliveryStatus(segments),
    segments,
    updatedAt: at,
  }
}

/**
 * 规范化一条盘上的账（防御读取）。
 *
 * @param {unknown} value 候选账。
 * @returns {object|undefined}
 */
export function normalizeDeliveryAction(value) {
  const r = record(value)
  const id = r.id
  if (id === undefined || id === null || id === '') return undefined
  const segments = Array.isArray(r.segments)
    ? r.segments
      .filter((item) => record(item).index !== undefined && typeof record(item).content === 'string')
      .map((item) => {
        const seg = record(item)
        return {
          index: Number.isSafeInteger(seg.index) ? seg.index : 0,
          kind: typeof seg.kind === 'string' ? seg.kind : 'message',
          content: String(seg.content ?? '').slice(0, 200),
          status: SEGMENT_STATUSES.includes(seg.status) ? seg.status : 'pending',
          ...(typeof seg.attemptedAt === 'string' ? { attemptedAt: seg.attemptedAt } : {}),
          ...(typeof seg.completedAt === 'string' ? { completedAt: seg.completedAt } : {}),
          ...(typeof seg.reason === 'string' ? { reason: seg.reason.slice(0, 160) } : {}),
        }
      })
    : []
  return {
    id,
    ...(typeof r.entryId === 'number' ? { entryId: r.entryId } : {}),
    ...(typeof r.participantId === 'string' ? { participantId: r.participantId } : {}),
    ...(typeof r.reason === 'string' ? { reason: r.reason.slice(0, 160) } : {}),
    status: DELIVERY_STATUSES.includes(r.status) ? r.status : aggregateDeliveryStatus(segments),
    segments,
    updatedAt: typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : new Date(0).toISOString(),
  }
}

/**
 * 规范化整个账本数组（防御读取，去重、按 id 升序、限量）。
 *
 * @param {unknown} value 盘上的数组。
 * @param {number} [limit] 保留条数。
 * @returns {Array<object>}
 */
export function normalizeDeliveries(value, limit = DEFAULT_DELIVERY_LIMIT) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const actions = []
  for (const item of value) {
    const action = normalizeDeliveryAction(item)
    if (!action || seen.has(action.id)) continue
    seen.add(action.id)
    actions.push(action)
  }
  return actions.slice(-Math.max(1, limit))
}

/**
 * 按引用更新一条投递账的段状态，并重算行动级状态。
 *
 * 与上游 `updateScriptDeliveryActions` 一致的不可变规则：
 *   - **delivered 是终态**：后续记账错误不得把已送达的话改回未发送；
 *   - 状态与原因都相同 → 幂等，不产生新版本；
 *   - 段首次尝试记 `attemptedAt`，终态记 `completedAt`。
 *
 * @param {Array<object>} current 当前账本数组。
 * @param {object} reference `{ id, segmentIndex }`。
 * @param {string} status 新段状态。
 * @param {number|Date|string} at 时间。
 * @param {string} [reason] 原因（提供则覆盖，未提供则清除）。
 * @returns {Array<object>|undefined} 更新后的数组；无变化返回 undefined（调用方据此
 *   决定要不要落盘）。
 */
export function updateDeliveryAction(current, reference, status, at, reason) {
  if (!Array.isArray(current)) return undefined
  const ref = record(reference)
  const targetStatus = SEGMENT_STATUSES.includes(status) ? status : 'pending'
  const timestamp = at instanceof Date ? at.toISOString() : new Date(at).toISOString()
  let changed = false
  const actions = current.map((raw) => {
    const action = normalizeDeliveryAction(raw)
    if (!action || action.id !== ref.id) return raw
    let actionChanged = false
    const segments = action.segments.map((segment) => {
      if (segment.index !== ref.segmentIndex) return segment
      if (segment.status === 'delivered') return segment
      if (segment.status === targetStatus && segment.reason === reason) return segment
      changed = true
      actionChanged = true
      const next = {
        ...segment,
        status: targetStatus,
        attemptedAt: segment.attemptedAt ?? timestamp,
        ...(targetStatus === 'pending' ? {} : { completedAt: timestamp }),
      }
      if (reason) next.reason = reason
      else delete next.reason
      return next
    })
    if (!actionChanged) return raw
    return { ...action, segments, status: aggregateDeliveryStatus(segments), updatedAt: timestamp }
  })
  return changed ? actions : undefined
}

/**
 * 追加一条投递账（幂等：同 id 已存在则跳过）。
 *
 * @param {Array<object>} current 当前账本数组（不可变；返回新数组）。
 * @param {object} action 新账。
 * @param {number} [limit] 保留条数。
 * @returns {Array<object>} 新数组。
 */
export function appendDeliveryAction(current, action, limit = DEFAULT_DELIVERY_LIMIT) {
  const list = normalizeDeliveries(current, limit)
  const normalized = normalizeDeliveryAction(action)
  if (!normalized) return list
  if (list.some((item) => item.id === normalized.id)) return list
  return [...list, normalized].slice(-Math.max(1, limit))
}
