/**
 * 确定性场景帧（Scene Frame）—— 从已有证据**投影**出当前场景，零模型调用。
 * 移植自上游 hds-interlude `src/script/scene-frame.ts`。
 *
 * ## 它解决什么问题
 *
 * 模型每轮都在重新"理解"现在是什么场景：在哪、谁在、在做什么、注意力在哪。
 * 但这件事**不该问模型**——证据早就在账本里了（在场名单、进行中的细节、
 * 行动窗口）。问模型只会引入一个新的幻觉来源，而且同一份证据每轮回答都不一样。
 *
 * 所以这里按规则**算**出来：每个字段都带 `sources`（它是从哪几条原文来的），
 * 算不出来的字段就**不出现**（而不是留个空串让模型自己填）。
 *
 * ## 三条铁律（改动前务必读完）
 *
 * 1. **绝不调用模型，也绝不用"过去了多久"来改变帧的身份**。
 *    上游原话：`never uses elapsed time to change frame or burst identity`。
 *    时间流逝不会让场景变成另一个场景——只有**结构性的交接**才会。
 *
 * 2. **每轮都从事实源重新投影，绝不在旧帧上增量修改**。
 *    上游踩过的坑：beta1 的帧里混进了散文尾巴，克隆它会把这个反馈回路一直传下去。
 *
 * 3. **没有溯源的字段一律不出现**。
 *    这是 `sceneFrameProvenanceErrors` 的精神——帧里每个非空字段都必须能说出
 *    「我是从哪条原文来的」。说不出来的字段进上下文就是纯噪声。
 *
 * @module dsh-hds-interlude/scene-frame
 */

import { createHash } from 'node:crypto'

/** 帧里所有可能出现的字段（顺序即提示词里的呈现顺序）。 */
export const SCENE_FRAME_FIELDS = [
  'place', 'presentPeople', 'ongoingActivity', 'postureOrMotion', 'attention',
  'deviceAccess', 'privacy', 'affectiveBaseline', 'openMotions', 'openTopics', 'narrativeFocus',
]

/** 溯源 id 的保留上限（上游 80）。 */
const MAX_SOURCE_IDS = 80

/**
 * 稳定 id：同样的输入永远得到同样的 id。
 *
 * **不用时间戳**：帧身份必须由结构决定，否则每轮都会"变成一个新帧"，
 * `dialogueBurst` 的连续性判定就会永远失败。
 *
 * @param {string} prefix 前缀（frame / burst / scope / topic）。
 * @param {...string} parts 组成成分。
 * @returns {string}
 */
export function stableId(prefix, ...parts) {
  const digest = createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 18)
  return `${prefix}:${digest}`
}

/** 去重、升序、裁到上限。 */
function unionIds(values) {
  const clean = (values ?? []).filter(v => Number.isSafeInteger(v) && v > 0)
  return [...new Set(clean)].sort((a, b) => a - b).slice(-MAX_SOURCE_IDS)
}

/** 去重、保留最后 N 个（最近的说的话更重要）。 */
function unionStrings(values, limit) {
  return [...new Set((values ?? []).filter(v => typeof v === 'string' && v))].slice(-limit)
}

/**
 * 给字段赋值，**并记录溯源**。没有溯源 id 时直接不赋值——这是铁律 3。
 *
 * @param {object} frame 帧（就地修改）。
 * @param {string} field 字段名。
 * @param {unknown} value 值。
 * @param {Array<number>} sourceIds 来源条目 id。
 */
function assign(frame, field, value, sourceIds) {
  const ids = unionIds(sourceIds)
  if (!ids.length) return
  const empty = Array.isArray(value) ? value.length === 0 : !(typeof value === 'string' && value.trim())
  if (empty) return
  frame[field] = value
  frame.sources[field] = ids
}

/**
 * 从已有证据**确定性投影**出当前场景帧。
 *
 * @param {object} input
 * @param {string} input.storyId 故事 id（参与帧身份计算）。
 * @param {number|string} [input.sceneId] 当前场景 id；缺省视为根场景。
 * @param {Array<object>} [input.scenePresence] 在场名单（`life-handoff` 维护）。
 * @param {Array<object>} [input.workingDetails] 进行中的细节。
 * @param {object|null} [input.agencyWindow] 主体行动窗口。
 * @param {object|null} [input.previousFrame] 上一帧（只用来继承 localBoundaryEntryId）。
 * @param {string} [input.now] 当前时间（ISO）。
 * @param {Array<number>} [input.visibleEntryIds] 有效条目 id；给了就要求字段的溯源在其中。
 * @returns {object} 场景帧。
 */
export function projectSceneFrame({
  storyId, sceneId, scenePresence, workingDetails, agencyWindow,
  previousFrame, now, visibleEntryIds,
} = {}) {
  // 帧身份只由「故事 + 场景」决定——**不含时间**（铁律 1）。
  const id = stableId('frame', String(storyId ?? ''), String(sceneId ?? 'root'))
  const frame = {
    id,
    presentPeople: [],
    openMotions: [],
    openTopics: [],
    sourceEntryIds: [],
    sources: {},
    updatedAt: typeof now === 'string' && now ? now : new Date().toISOString(),
  }
  // 场景边界在下游用来判断「本地占用是否已被顶掉」；跨轮继承。
  const boundary = previousFrame?.localBoundaryEntryId
  if (Number.isSafeInteger(boundary) && boundary > 0) frame.localBoundaryEntryId = boundary

  const visible = Array.isArray(visibleEntryIds) && visibleEntryIds.length
    ? new Set(visibleEntryIds)
    : undefined
  // 有可见集时，溯源必须落在其中——否则那条证据已经不在窗口里了。
  const grounded = ids => ids.length > 0 && (!visible || ids.some(x => visible.has(x)))

  const presence = Array.isArray(scenePresence) ? scenePresence : []
  const present = presence.filter(item => item?.status === 'present'
    && grounded(item.sourceEntryIds ?? [])
    // 早于本地边界的在场记录已经不适用了（她换了地方之后，旧名单作废）。
    && Math.max(...(item.sourceEntryIds ?? [0])) >= (frame.localBoundaryEntryId ?? 0))
  if (present.length) {
    assign(frame, 'presentPeople', present.map(item => item.name), present.flatMap(item => item.sourceEntryIds ?? []))
  }

  const details = Array.isArray(workingDetails) ? workingDetails : []
  const groundedDetails = details.filter(item => grounded(item.sourceEntryIds ?? []))
  if (groundedDetails.length) {
    // 进行中的细节渲染成「标签：值」，与上游一致。
    assign(frame, 'openMotions',
      groundedDetails.map(item => `${item.label}：${item.value}`),
      groundedDetails.flatMap(item => item.sourceEntryIds ?? []))
  }

  const agency = agencyWindow
  if (agency && Array.isArray(agency.sourceEntryIds) && agency.sourceEntryIds.length) {
    assign(frame, 'deviceAccess', agency.deviceAccess, agency.sourceEntryIds)
    assign(frame, 'privacy', agency.privacy, agency.sourceEntryIds)
    // 上游把「日程负荷」投影成 attention——这是「她现在留意着什么」的来源。
    assign(frame, 'attention', agency.activityLoad, agency.sourceEntryIds)
  }

  frame.sourceEntryIds = unionIds(Object.values(frame.sources).flatMap(ids => ids ?? []))
  return frame
}

/**
 * 检查帧里有没有「有值但没溯源」的字段。
 *
 * 这是**不变量守卫**，不是运行时修补：它应该永远返回空数组。
 * 一旦非空，说明投影逻辑漏了 `assign` 的溯源记录——那会让帧里的字段
 * 变成没有依据的断言，正是这套机制要防的东西。
 *
 * @param {object} frame 场景帧。
 * @returns {string[]} 违规字段名。
 */
export function sceneFrameProvenanceErrors(frame) {
  const errors = []
  if (!frame || typeof frame !== 'object') return ['frame is not an object']
  const sources = frame.sources ?? {}
  for (const field of SCENE_FRAME_FIELDS) {
    const value = frame[field]
    const populated = Array.isArray(value) ? value.length > 0 : typeof value === 'string' && !!value.trim()
    if (!populated) continue
    const ids = sources[field]
    if (!Array.isArray(ids) || !ids.length) errors.push(`${field} has no source entry`)
  }
  return errors
}

/**
 * 把帧渲染成提示词片段。
 *
 * **只渲染有值的字段**——没有证据的部分不出现，让模型自己去写，
 * 而不是给它一个空占位符去"填空"（那等于邀请它编）。
 *
 * @param {object|undefined} frame 场景帧。
 * @returns {string} 提示词片段；无可用内容时返回空串。
 */
export function renderSceneFrame(frame) {
  if (!frame || typeof frame !== 'object') return ''
  const lines = []
  if (frame.place) lines.push(`地点：${frame.place}`)
  if (Array.isArray(frame.presentPeople) && frame.presentPeople.length) {
    lines.push(`物理在场：${frame.presentPeople.join('、')}`)
  }
  if (frame.ongoingActivity) lines.push(`正在做：${frame.ongoingActivity}`)
  if (frame.postureOrMotion) lines.push(`姿态：${frame.postureOrMotion}`)
  if (frame.attention) lines.push(`注意力：${frame.attention}`)
  if (frame.deviceAccess) lines.push(`设备：${frame.deviceAccess}`)
  if (frame.privacy) lines.push(`隐私空间：${frame.privacy}`)
  if (Array.isArray(frame.openMotions) && frame.openMotions.length) {
    lines.push(`进行中：${frame.openMotions.join('；')}`)
  }
  if (Array.isArray(frame.openTopics) && frame.openTopics.length) {
    lines.push(`未结话题：${frame.openTopics.join('、')}`)
  }
  if (!lines.length) return ''
  return lines.join('\n')
}

/**
 * 从文本里取「话题键」——用于判断对话有没有**真的**换话题。
 *
 * 与 `recall.js` 同源：CJK 二字符 shingle + 字母数字词，再哈希成稳定键。
 * 哈希是刻意的：这些键会进持久状态，不该把私密原文留在里面。
 *
 * @param {string} text 文本。
 * @returns {string[]} 话题键（最多 12 个）。
 */
export function dialogueTopicKeys(text) {
  const normalized = String(text ?? '').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
  if (!normalized) return []
  const raw = /[\u3400-\u9fff]/u.test(normalized)
    ? Array.from({ length: Math.max(0, normalized.length - 1) }, (_, i) => normalized.slice(i, i + 2))
    : (String(text ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
  return unionStrings(raw.map(value => stableId('topic', value)), 12)
}

/**
 * 这看起来像不像「接着刚才那句说」。
 *
 * 上游的正则：以「那/这/所以/然后…」这类承接词开头。
 * 意义在于：**承接词开头的话题应该算同一段对话**，哪怕字面词元对不上
 * （「那今天呢」与上一句可能毫无共同词）。没有这一条，稍微换个说法就会被
 * 判成「换了话题」，对话突发被切得稀碎。
 *
 * @param {string} text 文本。
 * @returns {boolean}
 */
export function isConversationalFollowUp(text) {
  const normalized = String(text ?? '').trim()
  if (!normalized) return true
  return /^(那|这|所以|然后|但是|可是|怎么|为什么|你|我|刚才|昨天|前面|不是|对啊|嗯|啊)/u.test(normalized)
}

/** 两个话题键集合是否有交集。 */
function topicKeysOverlap(left, right) {
  const known = new Set(left ?? [])
  return (right ?? []).some(key => known.has(key))
}

/**
 * 解析「对话突发」（dialogue burst）——一次连续对话的边界。
 *
 * 作用：把「一连串来回」当成一个单元。只要话题没断、场景没换，
 * 就沿用同一个突发，而不是每轮都算新的一段。
 *
 * **边界只由结构决定**（`boundary: true` 来自一次已提交的场景转换），
 * 不由时间流逝决定（铁律 1）。
 *
 * @param {object} frame 当前场景帧。
 * @param {object|undefined} previous 上一次的突发状态。
 * @param {string} startedAt 本轮开始时间（ISO）。
 * @param {object} [signal]
 * @param {string} [signal.scope] 关系/群/生活分支（会被哈希后存储）。
 * @param {string} [signal.topicText] 当前外部事件文本（只存哈希键）。
 * @param {boolean} [signal.boundary] 是否发生了结构性转换。
 * @returns {object} 新的突发状态。
 */
export function resolveDialogueBurst(frame, previous, startedAt, signal = {}) {
  const scopeKey = signal.scope?.trim() ? stableId('scope', signal.scope.trim()) : undefined
  const nextTopicKeys = dialogueTopicKeys(signal.topicText ?? '')
  const sameScope = !scopeKey || !previous?.scopeKey || scopeKey === previous.scopeKey
  const sameTopic = !nextTopicKeys.length || !previous?.topicKeys?.length
    ? true
    : topicKeysOverlap(previous.topicKeys, nextTopicKeys) || isConversationalFollowUp(signal.topicText ?? '')

  if (!signal.boundary && previous?.frameId === frame?.id && sameScope && sameTopic) {
    return {
      ...previous,
      sourceEntryIds: unionIds([...previous.sourceEntryIds, ...(frame?.sourceEntryIds ?? [])]),
      ...(scopeKey ? { scopeKey } : {}),
      ...(nextTopicKeys.length
        ? { topicKeys: unionStrings([...(previous.topicKeys ?? []), ...nextTopicKeys], 12) }
        : {}),
    }
  }
  return {
    id: stableId('burst', frame?.id ?? '', String(startedAt ?? '')),
    frameId: frame?.id ?? '',
    startedAt: typeof startedAt === 'string' ? startedAt : new Date().toISOString(),
    sourceEntryIds: [...(frame?.sourceEntryIds ?? [])],
    ...(scopeKey ? { scopeKey } : {}),
    ...(nextTopicKeys.length ? { topicKeys: nextTopicKeys } : {}),
  }
}

/**
 * 渲染「对话突发」的提示词片段。
 *
 * @param {object|undefined} burst 突发状态。
 * @param {string} [nowIso] 当前时间。
 * @returns {string} 片段；无内容时返回空串。
 */
export function renderDialogueBurst(burst, nowIso) {
  if (!burst?.startedAt) return ''
  const started = Date.parse(burst.startedAt)
  const now = Date.parse(nowIso ?? '')
  if (!Number.isFinite(started)) return ''
  if (!Number.isFinite(now)) return `连续对话开始于 ${burst.startedAt}。`
  const minutes = Math.max(0, Math.round((now - started) / 60_000))
  return minutes >= 1 ? `这段连续对话已持续约 ${minutes} 分钟。` : ''
}
