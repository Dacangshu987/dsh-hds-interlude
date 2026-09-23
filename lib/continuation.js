/**
 * 续写书签与复用诊断（移植自上游 `src/script/continuation.ts`）。
 *
 * ## 续写书签解决什么
 *
 * 续写时模型需要知道「从哪儿接着写」。最直觉的做法是「把最近写过的原文再贴一份」，
 * 但那会引入一个隐蔽的坏处：**同一段对话在上下文里出现两遍**，模型容易把它当成
 * 「又发生了一次」，于是重复回答同一个问题。
 *
 * 上游的做法是**指针**而不是副本：书签只说「写到哪了」（条目 id + 字符偏移），
 * 原文仍然只在 `recentScript` 里出现一次。新增的用户消息也**只记 id**，
 * 由引用去解析——这样短的追问他能保留它真正在回应的是哪一个问题。
 *
 * ## 复用诊断解决什么
 *
 * 模型有时会成段照抄上一轮的散文。这**不是**该直接判错的事：
 * 「在吗」这种短句本来就该重复。所以这里只做**观测**（给出复用比例），
 * 交给上层判断，绝不在这里拒绝。
 *
 * @module dsh-hds-interlude/continuation
 */

/** 引用记录里保留的字段（够定位即可，不搬原文）。 */
function reference(entry) {
  return {
    entryId: entry.id,
    kind: entry.kind,
    participantId: entry.participantId,
    occurredAt: entry.occurredAt,
  }
}

/**
 * 生成一个指向可见原文的**书签**。
 *
 * @param {object} args
 * @param {Array<object>} args.entries 条目账本里的条目（已按 id 升序）。
 * @param {number} args.from 上一段散文的结束时刻（epoch ms）。
 * @param {number} args.now 当前时刻（epoch ms）。
 * @returns {object} 书签。
 */
export function continuationBookmark({ entries, from, now }) {
  const list = Array.isArray(entries) ? entries : []
  const at = entry => {
    const time = Date.parse(entry.occurredAt ?? '')
    return Number.isFinite(time) ? time : 0
  }
  const visible = list.filter(entry => at(entry) <= now)
  // 「写到哪了」= from 之前的最后一条散文（script）。
  const lastScript = visible.filter(entry => entry.kind === 'script' && at(entry) <= from).at(-1)
  const bookmark = {
    establishedThrough: new Date(from).toISOString(),
    writingStart: 'after-last-completed-passage',
  }
  if (lastScript) {
    bookmark.lastScript = reference(lastScript)
    // 字符偏移让它能精确接着写，而不必把上一段再贴一遍。
    bookmark.originalEndpoint = { entryId: lastScript.id, characterOffset: String(lastScript.content ?? '').length }
  }
  // 新增的用户消息**只给 id**：它们由引用解析，不复制到书签里。
  // 这样短追问能保留「它真正在回应哪一个问题」。
  bookmark.newEventEntryIds = visible
    .filter(entry => entry.kind === 'user-message' && at(entry) > from)
    .map(entry => entry.id)
  // 近期沟通：能让「刚进来的这句」找到它回应的是哪条。
  // 用户消息只取 from 之前的（from 之后已经在 newEventEntryIds 里了，避免两处重复）。
  bookmark.recentCommunications = visible
    .filter(entry => (entry.kind !== 'user-message' || at(entry) <= from)
      && ['user-message', 'character-message', 'character-group-message'].includes(entry.kind))
    .slice(-4)
    .map(reference)
  return bookmark
}

/**
 * 把书签渲染成提示词片段。
 *
 * 刻意**只给出指针**：原文在 `recentScript` 里已经有一份，这里再说一遍
 * 就是在制造重复上下文。
 *
 * @param {object|undefined} bookmark 书签。
 * @returns {string} 片段；无内容时返回空串。
 */
export function renderContinuationBookmark(bookmark) {
  if (!bookmark?.establishedThrough) return ''
  const lines = ['续写位置：接着上面最后一段已完成的原文继续，不要重述它。']
  if (bookmark.originalEndpoint) {
    lines.push(`- 上一条原文是 entry:${bookmark.originalEndpoint.entryId}，写到第 ${bookmark.originalEndpoint.characterOffset} 个字符。`)
  }
  if (Array.isArray(bookmark.newEventEntryIds) && bookmark.newEventEntryIds.length) {
    lines.push(`- 这期间新进来的消息：${bookmark.newEventEntryIds.map(id => `entry:${id}`).join('、')}（正文见上，不要当作新事件重述）。`)
  }
  const recent = Array.isArray(bookmark.recentCommunications) ? bookmark.recentCommunications : []
  if (recent.length) {
    lines.push(`- 可引用的近期沟通：${recent.map(item => `entry:${item.entryId}`).join('、')}。`)
  }
  return lines.join('\n')
}

/**
 * 观测「这一轮比上一轮照抄了多少」。
 *
 * ## 为什么只是观测
 *
 * 上游原话：`Diagnostic only: long literal reuse is evidence to inspect, not a
 * literary rejection rule. Identical short questions must never be treated as a fault.`
 *
 * 「在吗」这种短句重复是**正常**的；只有成段的长文本复用才值得看一眼。
 * 所以这里有两条底线：
 *   - 任一段短于 `width` 就直接返回 0（短句不参与统计）；
 *   - 返回值只表示**比例**，不表示"错"——判定权在调用方。
 *
 * 算法用滑窗找出 `next` 中被 `previous` 覆盖的字符比例（**不重复计**同一段命中）。
 *
 * @param {string} previous 上一段散文。
 * @param {string} next 这一轮写的散文。
 * @param {number} [width=40] 滑窗宽度（低于它的文本不参与）。
 * @returns {number} 0–1 的覆盖比例。
 */
export function proseReuseObservation(previous, next, width = 40) {
  const a = typeof previous === 'string' ? previous : ''
  const b = typeof next === 'string' ? next : ''
  if (a.length < width || b.length < width) return 0
  const spans = new Set()
  for (let i = 0; i <= a.length - width; i += 1) spans.add(a.slice(i, i + width))
  let covered = 0
  let end = 0
  for (let i = 0; i <= b.length - width; i += 1) {
    if (!spans.has(b.slice(i, i + width))) continue
    // 只累计**新覆盖**的部分：重叠的窗口不重复计。
    covered += Math.max(0, i + width - Math.max(end, i))
    end = i + width
  }
  return covered / b.length
}

/**
 * 这条复用观测值得提醒模型吗？
 *
 * 把阈值判断收在这里，免得调用方各自发明一个数。取 0.5（半数以上是照抄）
 * 作为「值得看一眼」的门槛——低于它的重合多半是正常的承接用语。
 *
 * @param {number} ratio {@link proseReuseObservation} 的结果。
 * @param {number} [threshold=0.5] 门槛。
 * @returns {boolean}
 */
export function shouldWarnProseReuse(ratio, threshold = 0.5) {
  return Number.isFinite(ratio) && ratio >= threshold
}
