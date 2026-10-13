/**
 * 长线叙事引导（Long-Horizon Narrative Guidance / Narrative Attractor）——
 * 移植自上游 `1.0.1-rc50` 的 `src/long-arc.ts`（495 行）。
 *
 * ## 上游的分层纪律（照搬）
 *
 * 上游把这个特性切成两半，并在文件头写明：
 *   - **本文件只有累计器与判定纯函数**——不碰数据库、不调模型、不写主叙事；
 *   - **宿主**（service.ts）根据 `ScriptEntry.kind/actor/metadata` 决定哪些条目
 *     算数、权重多少；
 *   - 长线模型**只消费**宿主给出的分数与证据，**不自行判断哪些行算数**。
 *
 * 这条纪律正是它能被移植的原因：纯函数层不依赖上游的 SQLite 与 JSON 合约，
 * 本仓可以原样接过来，由 `lib/index.js` 提供条目与状态。
 *
 * ## 本仓移植了什么、没移植什么
 *
 * **已移植（纯函数核心，逐字对齐语义）**：
 *   `DEFAULT_LONG_HORIZON_CONFIG` / `resolveLongHorizonConfig` /
 *   `isEligibleNarrativeEntry` / `resolveConversationKind` /
 *   `resolveConversationWeight` / `calculateLongHorizonScore` /
 *   `shouldTriggerLongHorizon`
 *
 * **未移植（需要生成通道或持久化表）**：
 *   `normalizeLongArcDecision` / `normalizeLongArcGuidance`（校验长线模型的
 *   结构化输出——本仓没有那条侧端通道）、进度/行辅助（上游的
 *   `LongArcGuidanceRow` / `LongArcProgressRow` 是数据库行形状）。
 *   提示词接线（上游把 guidance 注入 systemPrompt）也待做。
 *
 * @module dsh-hds-interlude/long-arc
 */

/** 默认配置（逐字对齐上游）。`enabled` 默认**关**——上游也是关的。 */
export const DEFAULT_LONG_HORIZON_CONFIG = {
  enabled: false,
  /** 首次进入催化生成窗口的加权分数门槛。 */
  triggerScore: 25,
  /** 上次催化生成后再积累多少分触发下一次机会审查。 */
  reviewIncrement: 40,
  privateWeight: 1.0,
  groupWeight: 0.5,
  intensity: 'subtle',
  /** 同一故事同时持有的 active 指导上限（第一版固定 1）。 */
  maxActiveGuidance: 1,
}

/**
 * 归一化配置（对齐上游 `resolveLongHorizonConfig`）。
 *
 * 上游的两处刻意设计，照搬：
 *   - `privateWeight` / `groupWeight` **不接受配置覆盖**。上游注释说明这是
 *     「隐私/关系权重契约」，即使保留读取旧键也**绝不让配置削弱或放大它**；
 *   - `maxActiveGuidance` 固定 1（第一版）。
 *
 * @param {unknown} value 原始配置。
 * @returns {object} 归一化后的配置。
 */
export function resolveLongHorizonConfig(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const num = (input, fallback) => {
    const parsed = Number(input)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  const clamp = (input, fallback) => Math.max(10, Math.min(500, num(input, fallback)))
  return {
    enabled: record.enabled === true,
    triggerScore: clamp(record.triggerScore, DEFAULT_LONG_HORIZON_CONFIG.triggerScore),
    reviewIncrement: clamp(record.reviewIncrement, DEFAULT_LONG_HORIZON_CONFIG.reviewIncrement),
    privateWeight: DEFAULT_LONG_HORIZON_CONFIG.privateWeight,
    groupWeight: DEFAULT_LONG_HORIZON_CONFIG.groupWeight,
    intensity: ['subtle', 'moderate', 'strong'].includes(record.intensity) ? record.intensity : 'subtle',
    maxActiveGuidance: 1,
  }
}

/* ───────────────────────────── 有效条目判定与权重 ───────────────────────────── */

/**
 * 具有叙事意义、可为人物/关系发展提供证据的条目 kind 白名单（逐字对齐上游）。
 *
 * 注：`character-group-message` / `character-platform-action` / `friend-feed` /
 * `qzone-post` 是上游平台特性的条目类型，本仓目前不会产生——保留在表里是为了
 * 与上游一致，将来补上那些特性时无需再改这里。
 */
const ELIGIBLE_KINDS = new Set([
  'user-message',
  'character-message',
  'character-group-message',
  'script',
  'character-platform-action',
  'world-event',
  'friend-feed',
  'qzone-post',
])

/**
 * 纯导航或技术性 kind，永远不计入（上游表 + 本仓的两个控制项）。
 *
 * 本仓补充的两个：
 *   - `admin-note`：管理员注记是**指令**，不是人物/关系发展的证据；
 *   - `advance`：推进标记是控制信号，没有叙事内容。
 * 上游没有这两类是因为它的条目类型集合不同；语义上它们与 `system` 同类。
 */
const INELIGIBLE_KINDS = new Set([
  'system',
  'compaction',
  'delivery-failure',
  'retry',
  'technical',
  'admin-note',
  'advance',
])

/** 纯格式控制（分隔符、空白、占位符）不算叙事证据（逐字对齐上游）。 */
const FORMAT_ONLY = /^(?:<sep\/>|\s|…|\.{3}|—|-)+$/

/**
 * 判定一条剧本条目是否为有效叙事证据。
 *
 * 上游注释：**宿主（而非长线模型）拥有此裁决权**——这是该特性设计文档 §4.1
 * 的核心约束。也就是说「哪些行算数」永远由本仓决定，不由模型自述。
 *
 * @param {{kind?: string, actor?: string, content?: string, metadata?: object}} entry 条目。
 * @returns {boolean}
 */
export function isEligibleNarrativeEntry(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {}
  const kind = String(safe.kind ?? '')
  if (INELIGIBLE_KINDS.has(kind)) return false
  if (!ELIGIBLE_KINDS.has(kind)) return false
  const content = String(safe.content ?? '').trim()
  if (!content) return false
  if (FORMAT_ONLY.test(content)) return false
  return true
}

/**
 * 解析条目的会话来源（private/group/unknown），逐字对齐上游的优先级：
 *   ① `metadata.conversationKind` 显式标注
 *   ② `metadata.channel.conversationKind` 通道标注
 *   ③ 按 kind 反推（历史回填路径）
 *   ④ 无法确认 → unknown
 *
 * @param {{kind?: string, metadata?: object}} entry 条目。
 * @returns {'private'|'group'|'unknown'}
 */
export function resolveConversationKind(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {}
  const metadata = safe.metadata && typeof safe.metadata === 'object' ? safe.metadata : undefined
  const direct = metadata?.conversationKind
  if (direct === 'private' || direct === 'group' || direct === 'unknown') return direct
  const channel = metadata?.channel
  if (channel?.conversationKind === 'private' || channel?.conversationKind === 'group') {
    return channel.conversationKind
  }
  const kind = String(safe.kind ?? '')
  if (kind === 'script') {
    // 一条 script 行是一次渲染好的提交，可能同时含私聊与群聊投递事件。
    // 优先看事件账本，免得把群提交误算成私聊条目。
    const events = Array.isArray(metadata?.scriptEvents) ? metadata.scriptEvents : []
    const hasGroup = events.some(event => event?.kind === 'group-message')
    const hasPrivate = events.some(event => event?.kind === 'outgoing-message')
    if (hasGroup && hasPrivate) return 'unknown'
    if (hasGroup) return 'group'
    if (hasPrivate) return 'private'
    // 旧版 script 行没有事件账本，按约定算私聊。
    return 'private'
  }
  if (kind.includes('group')) return 'group'
  if (kind === 'user-message' || kind === 'character-message') return 'private'
  return 'unknown'
}

/**
 * 计算单条条目的加权分数（对齐上游 `resolveConversationWeight`）。
 *
 * unknown **保守给 0 分**——不确定来源的证据不参与累计。
 *
 * @param {object} entry 条目。
 * @param {{privateWeight: number, groupWeight: number}} config 权重。
 * @returns {number}
 */
export function resolveConversationWeight(entry, config) {
  if (!isEligibleNarrativeEntry(entry)) return 0
  const kind = resolveConversationKind(entry)
  if (kind === 'private') return config.privateWeight
  if (kind === 'group') return config.groupWeight
  return 0
}

/**
 * 计算一组条目的加权有效叙事分数（对齐上游 §4.2 的核心公式）：
 *
 *   weightedScore = Σ(私聊有效条目 × privateWeight) + Σ(群聊有效条目 × groupWeight)
 *
 * @param {ReadonlyArray<object>} entries 条目集合。
 * @param {{privateWeight: number, groupWeight: number}} config 权重。
 * @returns {{totalScore: number, privateCount: number, privateScore: number,
 *   groupCount: number, groupScore: number, unknownCount: number, latestEligibleEntryId: number}}
 */
export function calculateLongHorizonScore(entries, config) {
  let privateCount = 0
  let privateScore = 0
  let groupCount = 0
  let groupScore = 0
  let unknownCount = 0
  let latestEligibleEntryId = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isEligibleNarrativeEntry(entry)) continue
    const kind = resolveConversationKind(entry)
    const id = Number(entry?.id) || 0
    if (id > latestEligibleEntryId) latestEligibleEntryId = id
    if (kind === 'private') {
      privateCount += 1
      privateScore += config.privateWeight
    } else if (kind === 'group') {
      groupCount += 1
      groupScore += config.groupWeight
    } else {
      unknownCount += 1
    }
  }
  return {
    totalScore: privateScore + groupScore,
    privateCount,
    privateScore,
    groupCount,
    groupScore,
    unknownCount,
    latestEligibleEntryId,
  }
}

/* ─────────────────────────────── 触发判定 ─────────────────────────────── */

/**
 * 判定是否应触发生成/复审任务（对齐上游 `shouldTriggerLongHorizon`）：
 *
 *   - 无 active（或已 paused/expired/completed）且达到 `triggerScore`
 *     → `first-trigger`（此前从没有过指导）/ `no-active`（有过但已失效）
 *   - 有 active 且距上次生成**增量** ≥ `reviewIncrement` → `review-due`
 *   - 其余 → `not-due`
 *
 * @param {{totalScore: number}} score 评分结果。
 * @param {{status?: string}|undefined} activeGuidance 当前 active 指导。
 * @param {number|undefined} lastGenerationScore 上次生成时的分数基线。
 * @param {{triggerScore: number, reviewIncrement: number}} config 配置。
 * @returns {{trigger: boolean, reason: 'first-trigger'|'review-due'|'no-active'|'not-due'}}
 */
export function shouldTriggerLongHorizon(score, activeGuidance, lastGenerationScore, config) {
  const total = Number(score?.totalScore) || 0
  const hasActive = activeGuidance?.status === 'active'
  if (!hasActive) {
    if (total >= config.triggerScore) {
      return { trigger: true, reason: activeGuidance ? 'no-active' : 'first-trigger' }
    }
    return { trigger: false, reason: 'not-due' }
  }
  const baseline = Number.isFinite(Number(lastGenerationScore)) ? Number(lastGenerationScore) : 0
  if (total - baseline >= config.reviewIncrement) return { trigger: true, reason: 'review-due' }
  return { trigger: false, reason: 'not-due' }
}

/* ══════════ 生成结果 → 指导载荷（上游 `normalizeLongArc*`）══════════ */

/** 单行文本：去空白、换行压成空格、截断（对齐上游 `text`）。 */
function longArcText(value, limit) {
  return typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ').slice(0, limit) : ''
}

/** 字符串数组：丢掉空项、逐项 trim（对齐上游 `stringList`）。 */
function longArcStringList(value, limit) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()).slice(0, limit)
    : []
}

/**
 * 证据条目 id 过滤（对齐上游 `normalizeEvidenceIds`）。
 *
 * **只认清单里真实存在的 id**：模型可能编 id，编的一律丢掉——
 * 一道「凭空引用」的防线，且上限 30 条。
 */
function normalizeEvidenceIds(value, validEvidenceIds) {
  if (!Array.isArray(value)) return []
  const valid = validEvidenceIds instanceof Set ? validEvidenceIds : new Set()
  return value.map(Number)
    .filter(id => Number.isSafeInteger(id) && id > 0 && valid.has(id))
    .slice(0, 30)
}

/** 阶段（对齐上游 `normalizeStage`）：id/name/objective 三者缺一不可。 */
function normalizeLongArcStage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = longArcText(value.id, 80)
  const name = longArcText(value.name, 200)
  const objective = longArcText(value.objective, 1_000)
  if (!id || !name || !objective) return undefined
  return {
    id, name, objective,
    allowedSignals: longArcStringList(value.allowedSignals, 8),
    activationConditions: longArcStringList(value.activationConditions, 8),
    completionEvidence: longArcStringList(value.completionEvidence, 8),
  }
}

/** 首次微表达（对齐上游 `normalizeFirstExpression`）：action/example/trigger 缺一不可。 */
function normalizeFirstExpression(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const action = longArcText(value.action, 1_000)
  const example = longArcText(value.example, 1_000)
  const trigger = longArcStringList(value.trigger, 8)
  if (!action || !example || !trigger.length) return undefined
  const attempts = Number(value.maxAttempts)
  return {
    action, example, trigger,
    intensity: ['minimal', 'subtle', 'moderate'].includes(value.intensity) ? value.intensity : 'minimal',
    maxAttempts: Math.max(1, Math.min(3, Math.round(Number.isFinite(attempts) ? attempts : 1))),
    reversibility: value.reversibility === 'medium' ? 'medium' : 'high',
  }
}

/** 三个回应分支（对齐上游 `normalizeResponseBranches`）：缺一不可。 */
function normalizeResponseBranches(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const accepted = longArcText(value.accepted, 800)
  const declined = longArcText(value.declined, 800)
  const questioned = longArcText(value.questioned, 800)
  if (!accepted || !declined || !questioned) return undefined
  return { accepted, declined, questioned }
}

/**
 * 规范化一次长线叙事的生成结果（对齐上游 `normalizeLongArcDecision`）。
 *
 * ## 三条硬约束（都是上游刻意加的，值得保留）
 *
 *   ① **缺省 decision 保守取 `dormant`**（上游 P2-1：从 activate 改过来）——
 *      模型没显式声明催化意图时**不写入**，避免「没打算催化却产生了一段指导」。
 *   ② **要写 prime/activate，就必须结构完整**：标题/前提/方向/情感内核 + 至少一条
 *      **真实存在的**证据 + 至少一个阶段 + 首次微表达 + 三个回应分支。
 *      缺任何一项都返回 `undefined`（＝这次生成作废），**不写入半截指导**。
 *   ③ **强度受配置压制**：非 subtle 的强度只在配置显式允许时生效——第一版硬约束。
 *
 * @param {unknown} value 模型给出的生成结果。
 * @param {Set<number>|Array<number>} validEvidenceIds 合法证据 id 集合。
 * @param {{intensity?: string}} config 长线叙事配置。
 * @returns {{decision: string, reason?: string, payload?: object, evidenceEntryIds: number[]}|undefined}
 */
export function normalizeLongArcDecision(value, validEvidenceIds, config = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value
  const explicitDecision = raw.decision
  const decision = ['dormant', 'prime', 'activate'].includes(explicitDecision) ? explicitDecision : 'dormant'
  const evidenceEntryIds = normalizeEvidenceIds(raw.evidenceEntryIds, validEvidenceIds)

  if (decision === 'dormant') {
    const reason = longArcText(raw.reason, 1_000)
      || 'No sufficiently grounded developmental affordance is ready for this relationship.'
    return { decision, reason, evidenceEntryIds }
  }

  const title = longArcText(raw.title, 200)
  const premise = longArcText(raw.premise, 2_000)
  const latentTension = longArcText(raw.latentTension, 1_000)
  const direction = longArcText(raw.direction, 2_000)
  const emotionalCore = longArcText(raw.emotionalCore, 500)
  // ② 结构不完整 → 这次生成作废，绝不写入半截指导。
  if (!title || !premise || !direction || !emotionalCore || !evidenceEntryIds.length) return undefined

  const stages = (Array.isArray(raw.stages) ? raw.stages : [])
    .map(normalizeLongArcStage)
    .filter(Boolean)
    .slice(0, 8)
  if (!stages.length) return undefined

  const rawStage = raw.currentStage
  const currentStage = rawStage && typeof rawStage === 'object' && !Array.isArray(rawStage)
    ? {
      id: longArcText(rawStage.id, 80),
      name: longArcText(rawStage.name, 200),
      purpose: longArcText(rawStage.purpose, 1_000),
    }
    : undefined
  // 当前阶段必须真的在阶段表里，否则退回第一个阶段（不留下悬空指针）。
  const resolvedCurrentStage = currentStage?.id && stages.some(stage => stage.id === currentStage.id)
    ? currentStage
    : { id: stages[0].id, name: stages[0].name, purpose: stages[0].objective }

  const firstExpression = normalizeFirstExpression(raw.firstExpression)
  if (!firstExpression) return undefined
  const responseBranches = normalizeResponseBranches(raw.responseBranches)
  if (!responseBranches) return undefined

  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.5

  const intensity = ['subtle', 'moderate', 'strong'].includes(raw.intensity) ? raw.intensity : 'subtle'
  // ③ 第一版硬约束：非 subtle 只在配置显式允许时生效。
  const allowedIntensity = config.intensity === 'moderate' || config.intensity === 'strong' ? intensity : 'subtle'

  return {
    decision,
    evidenceEntryIds,
    payload: {
      developmentPhase: decision === 'prime' ? 'primed' : 'active',
      ...(explicitDecision ? { decision } : {}),
      title,
      premise,
      ...(latentTension ? { latentTension } : {}),
      direction,
      emotionalCore,
      firstExpression,
      responseBranches,
      currentStage: resolvedCurrentStage,
      stages,
      subtleSignals: longArcStringList(raw.subtleSignals, 10),
      preferredSituations: longArcStringList(raw.preferredSituations, 10),
      avoidForcing: longArcStringList(raw.avoidForcing, 10),
      intensity: allowedIntensity,
      horizon: ['short', 'medium', 'long'].includes(raw.horizon) ? raw.horizon : 'long',
      confidence,
      evidenceEntryIds,
    },
  }
}

/**
 * 只要载荷的老接口（对齐上游 `normalizeLongArcGuidance`）。
 *
 * @param {unknown} value 模型给出的生成结果。
 * @param {Set<number>|Array<number>} validEvidenceIds 合法证据 id 集合。
 * @param {{intensity?: string}} config 配置。
 * @returns {object|undefined} 载荷。
 */
export function normalizeLongArcGuidance(value, validEvidenceIds, config = {}) {
  return normalizeLongArcDecision(value, validEvidenceIds, config)?.payload
}

/**
 * 推进「上次生成」基线（对齐上游 `advanceLongHorizonGenerationBaseline`）。
 *
 * ## 为什么需要这个
 *
 * 后台模型**看不到证据**（这一轮没有可见的新内容）时，也要把复审窗口**消费掉**：
 * 分数是累计的，但那段已经审过的窗口**不该在之后的每一条私聊/隐藏条目上重复触发**
 * 同一次生成。所以把 `lastGenerationScore` 推到当前分数，
 * 并让 `lastGenerationEntryId` **单调不减**（万一是乱序事件也不会倒退）。
 *
 * @param {object} progress 进度行。
 * @param {number} currentScore 当前累计分。
 * @param {number} lastGenerationEntryId 本次审到的条目 id。
 * @param {Date} [updatedAt] 更新时间。
 * @returns {object} 新进度行（不改原对象）。
 */
export function advanceLongHorizonGenerationBaseline(progress, currentScore, lastGenerationEntryId, updatedAt = new Date()) {
  const score = Number.isFinite(Number(currentScore)) ? Number(currentScore) : 0
  const entryId = Number.isFinite(Number(lastGenerationEntryId)) ? Number(lastGenerationEntryId) : 0
  const prevEntryId = Number.isFinite(Number(progress?.lastGenerationEntryId)) ? Number(progress.lastGenerationEntryId) : 0
  return {
    ...progress,
    totalScore: score,
    lastGenerationScore: score,
    lastGenerationEntryId: Math.max(prevEntryId, entryId),
    updatedAt,
  }
}

/**
 * 去掉进度行里的主键（对齐上游 `progressUpdatePayload`）。
 *
 * 上游注释：Minato 的 set 拒绝更新载荷包含主键（`cannot modify primary key`），
 * progress 表主键为 `storyId`，更新时必须从载荷里剔除。
 * 本仓没有那张表，但同一个坑（把主键塞进更新载荷）在任何存储上都成立，
 * 所以保留这个纯函数并钉住行为。
 *
 * @param {object} progress 进度行。
 * @returns {object} 不含主键的载荷。
 */
export function progressUpdatePayload(progress) {
  if (!progress || typeof progress !== 'object') return {}
  const { storyId: _primaryKey, ...mutable } = progress
  return mutable
}
