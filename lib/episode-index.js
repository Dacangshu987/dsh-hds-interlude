/**
 * 情节索引（移植自上游 `src/script/episode-index.ts`）。
 *
 * ## 它解决什么问题
 *
 * 记忆检索需要知道「哪几条原文属于同一段情节」。天真的做法是按时间间隔或
 * 消息条数切——但那两个都不对：隔了一夜接着聊同一件事仍是**同一个场景**，
 * 而同一分钟里插进来的另一件事不是。
 *
 * 上游的口径：**场景帧（frame）标识一个场景；时间间隔与消息条数都不切分它。**
 * 所以这里按 `frameId`（或场景检查点）分组，老数据没有帧的就各自成为一个单点锚。
 *
 * ## 为什么可重建
 *
 * 索引完全从条目派生，不存任何额外状态。也就是说它**丢掉也不要紧**——
 * 随时能重新算出来。这避免了「索引与原文不一致」这类最麻烦的故障。
 *
 * @module dsh-hds-interlude/episode-index
 */

import { indexOriginal, scoreOriginal, originalWindow } from './recall.js'

/**
 * 建立「条目 id → 同属一个情节的条目 id 列表」映射。
 *
 * @param {Array<object>} entries 条目（含 `metadata.frameId` / `metadata.sceneCheckpoint`）。
 * @returns {Map<number, number[]>} 索引。
 */
export function buildEpisodeIndex(entries) {
  const rows = (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && Number.isSafeInteger(entry.id))
    .sort((a, b) => a.id - b.id)
  // 收集场景检查点，用于按 id 区间反查「这条属于哪个场景」。
  const checkpoints = rows
    .map(entry => entry.metadata?.sceneCheckpoint)
    .filter(item => item && Number.isSafeInteger(item.sceneId)
      && Number.isSafeInteger(item.firstEntryId) && Number.isSafeInteger(item.lastEntryId))
  const groups = new Map()
  for (const row of rows) {
    const checkpoint = checkpoints.find(item => row.id >= item.firstEntryId && row.id <= item.lastEntryId)
    const frameId = row.metadata?.frameId
    // 分组键：参与者 + 场景（检查点优先，其次 frameId，最后退化成单点）。
    // 带上参与者是必要的：群里两个人各自的场景不该被并成一段情节。
    const sceneKey = checkpoint ? `scene:${checkpoint.sceneId}` : (frameId || `entry:${row.id}`)
    const key = JSON.stringify([row.participantId ?? '', sceneKey])
    const ids = groups.get(key) ?? []
    ids.push(row.id)
    groups.set(key, ids)
  }
  const byEntry = new Map()
  for (const ids of groups.values()) for (const id of ids) byEntry.set(id, ids)
  return byEntry
}

/**
 * 从一段情节里取出一段**带预算**的摘录。
 *
 * 取法：以命中条目为锚，先带最近的邻居（+1 / -1 / +2 / -2），
 * 直到预算用尽。每条都标注**归属**（谁写的）与**是否为节选**——
 * 后者很重要：节选不能让下游以为「这就是完整的记录」。
 *
 * @param {Array<object>} entries 条目。
 * @param {number} anchorId 命中的条目 id。
 * @param {object} [options]
 * @param {number} [options.budget=4000] 字符预算。
 * @param {string[]} [options.queryKeys] 查询词元（用于把窗口收到命中处）。
 * @returns {{sourceEntryIds: number[], content: string}|undefined}
 */
export function episodeExcerpt(entries, anchorId, { budget = 4000, queryKeys = [] } = {}) {
  const rows = (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && Number.isSafeInteger(entry.id))
    .sort((a, b) => a.id - b.id)
  const position = rows.findIndex(entry => entry.id === anchorId)
  if (position < 0) return undefined

  const selected = new Map()
  let remaining = budget
  // 顺序即优先级：先命中本身，再前后最近的邻居。
  for (const index of [position, position + 1, position - 1, position + 2, position - 2]) {
    const row = rows[index]
    if (!row || remaining < 40) continue
    const content = String(row.content ?? '')
    // 邻居塞不下就跳过——不要为了凑数把它切得只剩半句。
    if (index !== position && content.length + 100 > remaining) continue
    const owner = row.kind === 'user-message' ? '对方发来的消息'
      : row.kind === 'script' ? '主角叙述'
        : row.kind === 'group-message' ? '群成员发言' : '主角发出的消息'
    const spans = indexOriginal(content)
    const hit = scoreOriginal(queryKeys, spans)
    const window = originalWindow(content, spans, hit.index, Math.max(0, remaining - 180), queryKeys)
    const partial = window.start > 0 || window.end < content.length
    const text = `[${row.occurredAt ?? ''}；${owner}；entry:${row.id}`
      + `${partial ? `；节选 UTF-16 [${window.start},${window.end})/${content.length}，不是完整记录` : ''}] ${window.content}`
    if (index !== position && text.length > remaining) continue
    selected.set(row.id, text)
    remaining -= text.length + 1
  }
  const ordered = rows.filter(entry => selected.has(entry.id))
  return {
    sourceEntryIds: ordered.map(entry => entry.id),
    content: ordered.map(entry => selected.get(entry.id)).join('\n'),
  }
}

/**
 * 过滤出「逐字落在原文里」的标签。
 *
 * 标签是**字面导航片段**，不是生成的摘要或事实——所以每个都必须能在原文里
 * 找到，否则它就是个凭空贴的标签，检索时会误导。
 *
 * @param {string} content 原文。
 * @param {object} draft 模型给的标签草案 `{ people: [], places: [], ... }`。
 * @returns {object} 过滤后的标签。
 */
export function groundedEpisodeTags(content, draft) {
  const text = typeof content === 'string' ? content : ''
  const result = {}
  for (const key of ['people', 'places', 'objects', 'topics', 'commitments', 'outcomes', 'dates']) {
    const values = draft?.[key]
    if (!Array.isArray(values)) continue
    const grounded = [...new Set(values.filter(value => typeof value === 'string'
      && value.trim().length >= 2 && value.length <= 100 && text.includes(value)))].slice(0, 8)
    if (grounded.length) result[key] = grounded
  }
  return result
}

/**
 * 标签与查询的匹配分。
 *
 * 上游的取法很直接：查询里出现了某个标签就算命中（0.8），否则 0。
 * 这是个**高精度低召回**的判据——标签是逐字落地的，所以一旦命中就相当可信。
 *
 * @param {string} query 查询串。
 * @param {string[]} [tags] 标签。
 * @returns {number} 0 或 0.8。
 */
export function episodeTagScore(query, tags = []) {
  const text = typeof query === 'string' ? query : ''
  return tags.some(tag => text.includes(tag)) ? 0.8 : 0
}
