/**
 * 人格演化的多场景门控（Development Gating）。
 * 移植自上游 hds-interlude `src/script/development.ts`。
 *
 * ## 它解决什么问题
 *
 * Overlay（设定演化）记录的是**长期**的性格/关系变化。但模型很容易把一次
 * 单独的互动（甚至一句玩笑）就上升成「她的性格变了」——于是角色在几轮之内
 * 性格急变，长期一致性崩掉。
 *
 * 上游的规矩：**一次完成场景只贡献一次**，且必须**跨 ≥2 个不同场景**才能
 * 升级为正式 Overlay。这不是保守，而是「变化要被反复观察到才算数」。
 *
 * ## 词汇白名单
 *
 * 维度是**有限**的，不是随便写。这既防止模型发明维度（「她的星座观」），
 * 也让下游能稳定判断「这条 overlay 属于哪一类」。
 *
 * @module dsh-hds-interlude/development
 */

/** 允许的演化维度（上游 `dimensions`）。 */
export const DEVELOPMENT_DIMENSIONS = {
  character: ['traits', 'preferences', 'coping'],
  perspective: ['values', 'interpretation'],
  relationship: ['trust', 'closeness', 'boundaries'],
  world: ['established'],
}

/**
 * 把模型给的路径规范化成**白名单内**的维度名。
 *
 * 接受的写法：`traits`、`character.traits`、`development.character.traits`。
 * 不在白名单内一律返回 undefined——**不猜、不纠正**。
 *
 * @param {string} target 演化层（character/perspective/relationship/world）。
 * @param {string} path 维度路径。
 * @returns {string|undefined}
 */
export function developmentDimension(target, path) {
  const normalized = String(path ?? '').trim()
    .replace(/^(development|character|perspective|relationship|world)\./, '')
  const allowed = DEVELOPMENT_DIMENSIONS[target]
  return allowed?.includes(normalized) ? normalized : undefined
}

/**
 * 从条目里数出**完成了几个不同场景**。
 *
 * 判定依据是条目 metadata 里的 `sceneCheckpoint`（场景检查点，记录了该场景的
 * 条目 id 区间）与 `frameId`（场景帧 id）。两者都能用；检查点优先，因为它
 * 明确标注了场景边界。
 *
 * 老数据（没有场景溯源的行）**仍然可读，但不能靠时间戳去乘算置信度**——
 * 所以它们只按 frameId 计一次。
 *
 * @param {Array<object>} entries 条目（通常是候选的溯源条目）。
 * @returns {number} 不同场景的个数。
 */
export function developmentScenes(entries) {
  const list = Array.isArray(entries) ? entries : []
  // 收集所有检查点，便于按区间反查某个条目属于哪个场景。
  const checkpoints = list.flatMap(entry => {
    const cp = entry?.metadata?.sceneCheckpoint
    return cp && typeof cp === 'object' ? [cp] : []
  })
  const scenes = new Set()
  // 先建立 frameId → 场景 的映射：同一帧里可能只有检查点条目才带 sceneId。
  const frameScenes = new Map()
  for (const entry of list) {
    const cp = checkpoints.find(item => Number.isSafeInteger(item.sceneId)
      && entry.id >= item.firstEntryId && entry.id <= item.lastEntryId)
    const frame = entry?.metadata?.frameId
    if (cp && typeof frame === 'string') frameScenes.set(frame, `scene:${cp.sceneId}`)
  }
  for (const entry of list.filter(item => item?.kind === 'script')) {
    const cp = checkpoints.find(item => Number.isSafeInteger(item.sceneId)
      && entry.id >= item.firstEntryId && entry.id <= item.lastEntryId)
    const frame = entry?.metadata?.frameId
    if (cp) scenes.add(`scene:${cp.sceneId}`)
    else if (typeof frame === 'string' && frame) scenes.add(frameScenes.get(frame) ?? frame)
  }
  return scenes.size
}

/**
 * 这条演化提案**够不够格**进提示词。
 *
 * - `applied`（宿主已经正式采纳）→ 直接放行；
 * - 其余要跨 **≥2 个不同场景**才算数。
 *
 * 注意「一个场景只贡献一次」：同一场景里写十条观察，仍然只算一个场景。
 * 上游原话：`One completed scene contributes once regardless of prose length or turns.`
 *
 * @param {object} candidate 演化提案 `{ status, sourceEntryIds }`。
 * @param {Array<object>} entries 条目账本里的条目。
 * @returns {boolean}
 */
export function promptReadyDevelopment(candidate, entries) {
  if (!candidate) return false
  if (candidate.status === 'applied') return true
  const sources = new Set(candidate.sourceEntryIds ?? [])
  const cited = (Array.isArray(entries) ? entries : []).filter(entry => sources.has(entry.id))
  return developmentScenes(cited) >= 2
}

/**
 * 一次交互的完整证据链（用于「这次互动有没有真的支持一次演化」的复核）。
 *
 * 把「对方的反馈」「之前的沟通」「她随后的解读」「她随后的回应」串成一条链，
 * 交给宿主/模型判断这次互动是否**有据可依**。这里只负责把引用整理清楚，
 * **不做语义判定**。
 *
 * @param {Array<object>} entries 条目。
 * @returns {Array<object>} 每条用户反馈对应的证据链。
 */
export function interactionEvidence(entries) {
  const ordered = [...(Array.isArray(entries) ? entries : [])].sort((a, b) => a.id - b.id)
  return ordered.filter(entry => entry.kind === 'user-message').slice(-16).map(feedback => {
    // 只看**同一个分支**（同一参与者），否则会把别人的话算进来。
    const branch = ordered.filter(entry => entry.participantId === feedback.participantId)
    const next = branch.find(entry => entry.id > feedback.id && entry.kind === 'user-message')?.id ?? Infinity
    return {
      participantId: feedback.participantId,
      feedbackEntryId: feedback.id,
      priorCommunicationEntryId: branch.filter(entry => entry.id < feedback.id && entry.kind === 'character-message').at(-1)?.id,
      interpretationEntryIds: branch.filter(entry => entry.id > feedback.id && entry.id < next && entry.kind === 'script').map(entry => entry.id),
      responseEntryIds: branch.filter(entry => entry.id > feedback.id && entry.id < next && entry.kind === 'character-message').map(entry => entry.id),
    }
  })
}

/**
 * 复核一次演化提案是否真的被互动支持。
 *
 * 要求：明确 `outcome === 'supported'`，且引用的反馈与回应**都真实存在**、
 * 属于同一参与者、且回应**发生在反馈之后**。
 *
 * @param {object} draft 演化草案 `{ sourceEntryIds, interactionReview }`。
 * @param {Array<object>} entries 条目。
 * @param {string} participantId 参与者。
 * @returns {boolean}
 */
export function reviewedDevelopmentSupport(draft, entries, participantId) {
  const review = draft?.interactionReview
  if (!review || review.outcome !== 'supported') return false
  if (!Array.isArray(review.feedbackEntryIds) || !Array.isArray(review.responseEntryIds)) return false
  const cited = new Set(draft.sourceEntryIds ?? [])
  const list = Array.isArray(entries) ? entries : []
  const valid = (id, kind) => cited.has(id) && list.some(entry => entry.id === id
    && entry.kind === kind && entry.participantId === participantId)
  return review.feedbackEntryIds.length > 0 && review.responseEntryIds.length > 0
    && review.feedbackEntryIds.every(id => valid(id, 'user-message'))
    && review.responseEntryIds.every(id => valid(id, 'character-message'))
    // 回应必须在反馈**之后**——否则是拿着旧回应给新反馈背书。
    && review.responseEntryIds.some(id => id > Math.max(...review.feedbackEntryIds))
}

/**
 * 为一次演化审查拼出「查询串」。
 *
 * 安静的一轮也需要生活背景。这里只用**可见原文**做相关度查询，
 * 不当成新的观察证据、也不参与置信度计算。
 *
 * @param {string|undefined} userMessage 用户这条消息。
 * @param {string[]} dueSummaries 到期待办摘要。
 * @param {Array<object>} visibleEntries 可见条目。
 * @returns {string} 查询串。
 */
export function developmentContextQuery(userMessage, dueSummaries = [], visibleEntries = []) {
  if (typeof userMessage === 'string' && userMessage.trim()) return userMessage.trim()
  const lastScript = [...(Array.isArray(visibleEntries) ? visibleEntries : [])]
    .filter(entry => entry?.kind === 'script').at(-1)
  return [...(dueSummaries ?? []), lastScript?.content?.slice(-800) ?? '']
    .filter(Boolean).join('\n').slice(0, 1200)
}

/**
 * 供提示词使用的门控说明。
 *
 * 明确告诉模型「跨场景」这条规矩，比只在代码里拦要有效——
 * 它知道会被拦，就不会把一次互动包装成性格剧变。
 */
export const DEVELOPMENT_FRAME = 'DEVELOPMENT GATING: 性格与关系的长期变化必须**跨越至少两个不同场景**'
  + '才能升级为正式设定演化（一次互动最多只算一个场景，无论写了多长、来回多少轮）。'
  + '维度限于：character.traits/preferences/coping、perspective.values/interpretation、'
  + 'relationship.trust/closeness/boundaries、world.established。'
  + '提交演化时要同时给出依据（evidence）：是哪几条原文、哪一次互动支持了它。'
  + '一次单独的玩笑或一次情绪波动**不足以**改变长期设定——那只是当下的反应。'
