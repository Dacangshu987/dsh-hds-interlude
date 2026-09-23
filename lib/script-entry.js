/**
 * 剧本条目账本（Script Entry Ledger）—— DSH 侧的 `interlude_script_entry` 等价物。
 *
 * ## 为什么需要它
 *
 * 上游 hds-interlude 的整套「溯源」机制都建立在一张表上：`interlude_script_entry`。
 * 每条记录有一个**全局单调递增的整型 id**，于是：
 *   - `scene-frame` 要 `sourceEntryIds` 才能把「在场的人」「正在做的事」说清来源；
 *   - `knowledge-evidence` 要 `entry.content.includes(quote)` 逐字校验，确认这句话
 *     真是对方说的，而不是角色单方面以为的；
 *   - `life-handoff` 要 `prose.includes(quote)` 才能说「她确实换了地方」；
 *   - `development` 要数「跨了几个场景」才能放行人格演化。
 *
 * DSH 侧原先只有会话日志（`session.eventAt(i)`）和一份折叠后的状态，**没有 id 体系**，
 * 所以上面这些机制一条都落不了地。这个模块补的就是这一层。
 *
 * ## 关键设计决定（都为了对齐上游语义，改动前请先读完）
 *
 * 1. **id 全局单调递增，且只增不减**。上游靠的是数据库自增主键。这里用
 *    `state.entryCursor` 自己发号，落盘保存。**绝不重用**已删条目的 id——
 *    重用会让旧的 `sourceEntryIds` 指向另一条内容，溯源直接变成谎言。
 *
 * 2. **条目不是日志派生物，必须独立落盘**。日志会被压缩/重置
 *    （见 `state.js` 的 `foldFromLog` 回退分支）。若把条目当成「日志的投影」，
 *    一次压缩就会让所有 `sourceEntryIds` 悬空。所以账本进 state 文件，
 *    并在日志回退时**原样保留**（与 intents/facts 同级）。
 *
 * 3. **写入要幂等**。DSH 的 `foldFromLog` 是「把日志推进到最新」，同一段日志
 *    可能被折叠多次（每个 pre-step / 工具调用都会调）。因此追加时用一个
 *    `sessionSeq` 去重游标，保证「一条日志事件最多变成一条条目」。
 *
 * 4. **容量有界**。账本不能无限长。保留最近 N 条，但**裁剪不影响 id 游标**——
 *    被裁掉的 id 只是查不到，绝不回收给别人用。
 *
 * @module dsh-hds-interlude/script-entry
 */

/** 上游认得的条目类型（见 `knowledge-evidence.ts` 的 `delivered` 判定）。 */
export const ENTRY_KINDS = [
  'script',
  'user-message',
  'character-message',
  'group-message',
  'character-group-message',
]

/** 墓碑类型：purge 范围软删后条目变为该类型，读取路径一律跳过（上游 `kind='redacted'`）。 */
export const REDACTED_KIND = 'redacted'

/**
 * 会被「投递」的条目类型——即「另一方真实说出的话」。
 *
 * 这个区分是认知证据的地基：**叙述散文里的一句引号不能确认另一个人的行为**。
 * `knowledge-evidence` 判断 `confirmed` 时要求「一方提案 + 另一方确认」，
 * 且两条都得是 `delivered` 类型、来自不同 `kind`。
 */
export const DELIVERED_KINDS = ['user-message', 'character-message', 'group-message', 'character-group-message']

/** 账本默认保留条数。够回溯若干轮幕间，又不至于把 state 文件撑爆。 */
export const DEFAULT_LEDGER_LIMIT = 400

/** 单条正文的硬上限（防止模型一次写出超长正文把状态撑爆）。 */
const MAX_CONTENT = 8000

/** 单条 metadata 序列化后的硬上限。 */
const MAX_METADATA_BYTES = 4000

/**
 * 这个 kind 是否属于「真实说出的话」（可参与 confirmed 判定）。
 *
 * @param {string} kind 条目类型。
 * @returns {boolean}
 */
export function isDeliveredKind(kind) {
  return DELIVERED_KINDS.includes(kind)
}

/**
 * 从 0 建一个空账本。
 *
 * @returns {{cursor: number, nextId: number, entries: Array<object>}}
 */
export function createLedger() {
  return { cursor: 0, nextId: 1, entries: [] }
}

/**
 * 把任意（可能来自旧版本、可能损坏的）值规范化成合法账本。
 *
 * 与 `loadState` 的其它字段一致：**任何异常都降级成空账本，绝不抛错**，
 * 因为持久化问题不该打断一个回合。
 *
 * @param {unknown} value 磁盘上读到的值。
 * @param {number} [limit] 保留条数上限。
 * @returns {{cursor: number, nextId: number, entries: Array<object>}}
 */
export function normalizeLedger(value, limit = DEFAULT_LEDGER_LIMIT) {
  const raw = value && typeof value === 'object' ? value : {}
  const source = Array.isArray(raw.entries) ? raw.entries : []
  const entries = []
  for (const item of source) {
    const entry = normalizeEntry(item)
    if (entry) entries.push(entry)
  }
  // 按 id 升序（上游的游标分页依赖这个顺序）。
  entries.sort((left, right) => left.id - right.id)
  const kept = entries.slice(-Math.max(1, limit))
  // 游标与发号器**不因裁剪而回退**：取「盘上的值和保留条目里最大 id」的较大者。
  const maxKept = kept.length ? kept[kept.length - 1].id : 0
  const nextId = Math.max(1, safeInt(raw.nextId) ?? 1, maxKept + 1)
  const cursor = Math.max(0, safeInt(raw.cursor) ?? 0)
  return { cursor, nextId, entries: kept }
}

/**
 * 单条目的规范化。字段不认识就丢掉；正文为空则整条丢弃。
 *
 * @param {unknown} value 候选条目。
 * @returns {object|undefined}
 */
export function normalizeEntry(value) {
  if (!value || typeof value !== 'object') return undefined
  const id = safeInt(value.id)
  if (id === undefined || id < 1) return undefined
  const content = typeof value.content === 'string' ? value.content.slice(0, MAX_CONTENT) : ''
  if (!content.trim()) return undefined
  // 墓碑条目（purge 软删后）保留原 id 但不保留正文——引用它的溯源随正文一起失效。
  const kind = ENTRY_KINDS.includes(value.kind) ? value.kind
    : value.kind === REDACTED_KIND ? REDACTED_KIND
      : 'script'
  return {
    id,
    kind,
    // 上游：世界/系统事件没有参与人，因此允许空串。
    participantId: typeof value.participantId === 'string' ? value.participantId.slice(0, 128) : '',
    actor: typeof value.actor === 'string' ? value.actor.slice(0, 128) : '',
    content,
    occurredAt: typeof value.occurredAt === 'string' && value.occurredAt ? value.occurredAt : new Date(0).toISOString(),
    metadata: normalizeMetadata(value.metadata),
  }
}

/**
 * metadata 只做「能安全放进 JSON 且不超预算」的裁剪，不解释其含义。
 *
 * @param {unknown} value 候选 metadata。
 * @returns {object}
 */
export function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  let json
  try {
    json = JSON.stringify(value)
  } catch {
    // 循环引用等：宁可丢掉 metadata，也不要让整次落盘失败。
    return {}
  }
  if (typeof json !== 'string') return {}
  if (json.length > MAX_METADATA_BYTES) return {}
  return JSON.parse(json)
}

/**
 * 追加一条条目（**唯一的写入口**）。
 *
 * @param {object} ledger 账本（会被就地修改并返回）。
 * @param {object} draft 条目草案 `{ kind, content, participantId?, actor?, occurredAt?, metadata? }`。
 * @returns {object|undefined} 追加成功的条目；内容为空/类型非法则返回 undefined。
 */
export function appendEntry(ledger, draft) {
  if (!ledger || typeof ledger !== 'object') return undefined
  const content = typeof draft?.content === 'string' ? draft.content.trim() : ''
  if (!content) return undefined
  const kind = ENTRY_KINDS.includes(draft?.kind) ? draft.kind : 'script'
  const id = Math.max(1, safeInt(ledger.nextId) ?? 1)
  const entry = {
    id,
    kind,
    participantId: typeof draft?.participantId === 'string' ? draft.participantId.slice(0, 128) : '',
    actor: typeof draft?.actor === 'string' ? draft.actor.slice(0, 128) : '',
    content: content.slice(0, MAX_CONTENT),
    occurredAt: typeof draft?.occurredAt === 'string' && draft.occurredAt
      ? draft.occurredAt
      : new Date().toISOString(),
    metadata: normalizeMetadata(draft?.metadata),
  }
  ledger.entries = Array.isArray(ledger.entries) ? ledger.entries : []
  ledger.entries.push(entry)
  // 发号只增不减——**绝不**复用已删条目的 id（复用会让旧溯源指向别的内容）。
  ledger.nextId = id + 1
  return entry
}

/**
 * 单条是否为墓碑（purge 范围软删后的条目）。
 *
 * 墓碑只保留 id 与类型、不保留正文；**读取路径一律跳过**（与上游
 * `recentEntries`/timeline-range 过滤 `kind='redacted'` 一致），
 * 引用它的旧溯源也随之失效。
 *
 * @param {object} entry 条目。
 * @returns {boolean}
 */
export function isRedactedEntry(entry) {
  return Boolean(entry && (entry.kind === REDACTED_KIND || entry.metadata?.redacted === true))
}

/**
 * 按 id 取一条。
 *
 * @param {object} ledger 账本。
 * @param {number} id 条目 id。
 * @returns {object|undefined}
 */
export function entryById(ledger, id) {
  const target = safeInt(id)
  if (target === undefined) return undefined
  return (ledger?.entries ?? []).find(entry => entry.id === target)
}

/**
 * 取 id 大于 `cursor` 的条目（升序）——上游的历史回填游标分页用的就是这个语义。
 *
 * 墓碑条目（redacted）不进入结果。
 *
 * @param {object} ledger 账本。
 * @param {number} cursor 游标（不含）。
 * @param {number} [limit] 最多取几条。
 * @returns {Array<object>}
 */
export function entriesAfter(ledger, cursor, limit = 128) {
  const from = safeInt(cursor) ?? 0
  return (ledger?.entries ?? [])
    .filter(entry => entry.id > from && !isRedactedEntry(entry))
    .sort((left, right) => left.id - right.id)
    .slice(0, Math.max(0, limit))
}

/**
 * 取最近 N 条（**按 id 降序**，与上游的 `sort: { id: 'desc' }` 一致）。
 *
 * 墓碑条目（redacted）不进入结果。
 *
 * @param {object} ledger 账本。
 * @param {number} [limit] 最多取几条。
 * @returns {Array<object>}
 */
export function recentEntries(ledger, limit = 64) {
  return [...(ledger?.entries ?? [])]
    .filter(entry => !isRedactedEntry(entry))
    .sort((left, right) => right.id - left.id)
    .slice(0, Math.max(0, limit))
}

/**
 * 取全部有效 id 的集合（**排除墓碑**）。
 *
 * 这是所有溯源校验的入口：`agency.js` 的 `validSourceEntryIds`、
 * `knowledge-evidence` 的逐字校验都先要这份集合，用来判断「这个 id 还存不存在」。
 * 被 purge 软删的条目从集合中消失——引用它的旧溯源随之失效（与上游删除
 * memory/fact 的行为一致）。
 *
 * @param {object} ledger 账本。
 * @returns {Set<number>}
 */
export function validEntryIds(ledger) {
  return new Set((ledger?.entries ?? [])
    .filter(entry => !isRedactedEntry(entry))
    .map(entry => entry.id))
}

/**
 * 按时间范围把条目软删为墓碑（**不回收 id、不删记录**）。
 *
 * 与上游 `purgeStoryRange` 的语义一致：
 *   - 范围内条目改为 `redacted` 类型、正文替换为占位符（不再进入任何读取路径）；
 *   - 游标（`cursor`）与发号器（`nextId`）不动——被删的 id 绝不回收给别人用；
 *   - 返回被软删的条目 id 列表，调用方据此清理引用它们的 facts/intents。
 *
 * @param {object} ledger 账本（就地修改）。
 * @param {object} range `{ from: number, to: number }`（毫秒时间戳，含两端）。
 * @returns {number[]} 被软删的条目 id。
 */
export function redactRange(ledger, { from, to }) {
  if (!ledger || !Array.isArray(ledger.entries)) return []
  const fromMs = Number(from)
  const toMs = Number(to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return []
  const tombstoned = []
  for (const entry of ledger.entries) {
    if (isRedactedEntry(entry)) continue
    const occurredAt = Date.parse(entry.occurredAt)
    if (!Number.isFinite(occurredAt)) continue
    if (occurredAt < fromMs || occurredAt > toMs) continue
    entry.kind = REDACTED_KIND
    entry.content = '[管理员已删除剧本内容]'
    entry.metadata = { ...(entry.metadata ?? {}), redacted: true }
    tombstoned.push(entry.id)
  }
  return tombstoned
}

/**
 * 逐字引用校验——**认知证据与生活交接的共同地基**。
 *
 * 上游的规矩：任何「谁说了什么」「谁在哪」的声明，都必须引用散文里的**原文片段**，
 * 而且要能在该条目正文里**逐字找到**。这样做的意义不是语义理解，而是
 * **来源可查**：模型不能凭空编一句「她说她答应了」，必须指出哪条记录里的哪几个字。
 *
 * 刻意不做的事：不做同义判断、不做模糊匹配、不纠正错别字。引用对不上就是
 * 对不上——宁可判为「无证据」，也不要替模型圆场。
 *
 * @param {object} ledger 账本。
 * @param {number} entryId 被引用的条目 id。
 * @param {string} quote 引用的原文片段。
 * @param {object} [options]
 * @param {number} [options.maxLength=800] 单条引文长度上限（上游为 800）。
 * @returns {{ok: boolean, reason?: string, entry?: object}}
 */
export function verifyQuote(ledger, entryId, quote, { maxLength = 800 } = {}) {
  const entry = entryById(ledger, entryId)
  if (!entry) return { ok: false, reason: 'entry-not-found' }
  if (typeof quote !== 'string' || !quote.trim()) return { ok: false, reason: 'empty-quote' }
  if (quote.length > maxLength) return { ok: false, reason: 'quote-too-long' }
  if (!entry.content.includes(quote)) return { ok: false, reason: 'quote-not-in-entry' }
  return { ok: true, entry }
}

/**
 * 过滤出一组**真实存在**的 id（去重、升序、限量）。
 *
 * 与 `agency.js` 里那份 `positiveIds` 同源，但以账本为准绳——那是「格式合法」，
 * 这是「确实存在」。
 *
 * @param {object} ledger 账本。
 * @param {unknown} ids 候选 id 数组。
 * @param {number} [limit=20] 上限（上游取 `slice(-20)`，即保留最大的 20 个）。
 * @returns {number[]}
 */
export function groundedIds(ledger, ids, limit = 20) {
  if (!Array.isArray(ids)) return []
  const valid = validEntryIds(ledger)
  const clean = ids
    .map(value => safeInt(value))
    .filter(value => value !== undefined && value >= 1 && valid.has(value))
  return [...new Set(clean)].sort((left, right) => left - right).slice(-Math.max(1, limit))
}

/**
 * 裁剪账本到保留上限。**只删条目，不动 `nextId`**。
 *
 * @param {object} ledger 账本。
 * @param {number} [limit] 保留条数。
 * @returns {number} 被裁掉的条数。
 */
export function pruneLedger(ledger, limit = DEFAULT_LEDGER_LIMIT) {
  if (!ledger || !Array.isArray(ledger.entries)) return 0
  const keep = Math.max(1, limit)
  if (ledger.entries.length <= keep) return 0
  ledger.entries.sort((left, right) => left.id - right.id)
  const removed = ledger.entries.length - keep
  ledger.entries = ledger.entries.slice(-keep)
  return removed
}

/** 非负安全整数；否则 undefined。 */
function safeInt(value) {
  const num = Number(value)
  return Number.isSafeInteger(num) && num >= 0 ? num : undefined
}

/* =========================================================================
 * 记录器：把会话事件流变成条目
 * ========================================================================= */

/**
 * 从日志事件里抽出可读正文（复用与 index.js 一致的取法：只取 text 块）。
 *
 * @param {unknown} content 事件的 content 数组。
 * @returns {string}
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

/**
 * 一次事件 → 至多一条条目。
 *
 * ## 幂等性（这是本函数最重要的性质）
 *
 * `foldFromLog` 是「把日志推进到最新」，同一个事件**可能被折叠多次**（每个
 * pre-step、每次工具调用都会触发折叠）。所以绝不能「见到事件就追加」——
 * 那会让同一句话在账本里出现很多遍，逐字校验虽然仍成立，但条目数会爆炸，
 * 且 `recentEntries` 不再反映真实的时间线。
 *
 * 做法：账本上记一个 `cursor`（已处理到的事件序号），只有 `seq > cursor` 才处理。
 *
 * @param {object} ledger 账本（就地修改）。
 * @param {object} event 会话事件。
 * @param {object} options
 * @param {number} options.seq 该事件的序号（用于去重游标）。
 * @param {string} [options.participantId] 参与人（会话绑定到的账号）。
 * @param {string} [options.actor] 事件作者。
 * @returns {object|undefined} 追加的条目。
 */
export function recordEvent(ledger, event, { seq, participantId = '', actor = '' } = {}) {
  if (!ledger || typeof ledger !== 'object') return undefined
  const cursor = safeInt(ledger.cursor) ?? 0
  const position = safeInt(seq)
  if (position === undefined || position <= cursor) return undefined

  const draft = draftFromEvent(event, { participantId, actor })
  // 无论是否产生条目，游标都要推进——否则一个「不产生条目」的事件
  //（比如 turn/end）会让之后的每个事件都被反复重扫。
  ledger.cursor = position
  if (!draft) return undefined

  const occurredAt = Number.isFinite(Number(event?.time))
    ? new Date(Number(event.time)).toISOString()
    : new Date().toISOString()
  return appendEntry(ledger, { ...draft, occurredAt })
}

/**
 * 把一个事件翻译成条目草案。返回 undefined 表示「这个事件不进账本」。
 *
 * 刻意**不记录**的事件：
 *   - `turn/end` 这类纯控制事件：没有正文，记了只是噪声；
 *   - 插件自己的注入（`source.kind === 'plugin'`）：那是系统提示，不是谁说的话。
 *     把它记成 `user-message` 会让「用户说过」变成假的。
 *
 * ## 为什么 `assistant/message` 记成 `script` 而不是 `character-message`
 *
 * DSH 里「角色写出的正文」与「发出去的话」是**两件事**：
 *   - `assistant/message` = 她写的故事（旁白、动作、想法、可能还有没发出去的台词）；
 *   - `interlude_say` 工具调用 = 她**真的**发出去的那几句。
 *
 * 上游的 `script` 与 `character-message` 正是这个区分，而它是认知证据的地基：
 * 散文里的一句引号**不能**确认另一个人的行为。所以这里严格分开——
 * 只有 `interlude_say` 的参数才算「真实说出的话」。
 *
 * @param {object} event 会话事件。
 * @param {object} context 参与人/作者。
 * @returns {object|undefined}
 */
export function draftFromEvent(event, { participantId = '', actor = '' } = {}) {
  const type = event?.type
  if (type === 'user/message') {
    const source = event?.data?.source
    // 插件注入不是「用户说话」——记进去会让溯源说谎。
    if (source?.kind === 'plugin') return undefined
    const content = textOfContent(event?.data?.content) || textOfContent(event?.data?.message?.content)
    if (!content) return undefined
    return { kind: 'user-message', content, participantId, actor: actor || 'user' }
  }
  if (type === 'assistant/message') {
    const content = textOfContent(event?.data?.message?.content)
    if (!content) return undefined
    // 角色写出的正文即「剧本」。它是叙事权威，但**不是**投递给对方的话——
    // 这个区分由 kind 承载，认知证据靠它判断 confirmed。
    return { kind: 'script', content, participantId, actor: actor || 'character' }
  }
  // 工具调用里**唯一**算「真实说出的话」的：interlude_say。
  if (type === 'tool/call') {
    const toolName = event?.data?.name
    if (toolName !== 'interlude_say') return undefined
    const raw = event?.data?.arguments
    let parsed
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      return undefined
    }
    const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
    if (!text) return undefined
    return { kind: 'character-message', content: text, participantId, actor: actor || 'character' }
  }
  return undefined
}

/**
 * 触发一次账本记账（幂等），并按上限裁剪。
 *
 * 调用方只需在「日志已推进」之后调一次；重复调用不会产生重复条目。
 *
 * @param {object} state 会话状态。
 * @param {object} options
 * @param {number} options.seq 当前处理到的事件序号。
 * @param {number} [options.total] 日志总长度（用于把游标推到最新）。
 * @param {string} [options.participantId]
 * @param {string} [options.actor]
 * @param {Function} [options.eventAt] `(index) => event` 取事件。
 * @param {number} [options.limit] 保留条数上限。
 * @returns {Array<object>} 本次新增的条目。
 */
export function recordFromLog(state, { total, participantId = '', actor = '', eventAt, limit = DEFAULT_LEDGER_LIMIT } = {}) {
  if (!state || typeof state !== 'object') return []
  state.ledger = normalizeLedger(state.ledger, limit)
  const ledger = state.ledger
  const end = safeInt(total)
  if (end === undefined || typeof eventAt !== 'function') return []
  const created = []
  // 只扫「比游标新」的那一段；游标本身由 recordEvent 推进。
  for (let seq = (safeInt(ledger.cursor) ?? 0) + 1; seq <= end; seq += 1) {
    const event = eventAt(seq - 1)
    if (!event) continue
    const entry = recordEvent(ledger, event, { seq, participantId, actor })
    if (entry) created.push(entry)
  }
  pruneLedger(ledger, limit)
  return created
}
