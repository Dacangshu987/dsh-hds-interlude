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

/**
 * 生成长线指导用的**系统提示词**（移植自上游 `narrator.ts` 的 `longArcGuidancePrompt`）。
 *
 * ## 要点（上游刻意写进去的边界）
 *
 *   - **不是只识别已发生的变化**：可以设计「尚未发生」的潜在发展的一次**最小**
 *     角色一致表达——但必须具备可信的关系与角色结构依据；
 *   - **不为戏剧性服务**：不强迫冲突、告白、觉醒、人格改写或重大剧情转折；
 *     戏剧性发展必须从「最小、自然、可逆」的选择开始；
 *   - **`dormant` 是有效结论**：但只在「没有值得引入的有据发展」或
 *     「已有催化应留着收反馈」时才用——**不能因为「那件事还没发生」就返回 dormant**；
 *   - 只准用 `keyEvidence` 里给的 `evidenceEntryIds`；阶段限 2–6；
 *     `maxAttempts` 1–3；`confidence` 0–1；
 *   - **绝不写「角色已经具备新特质」**：只描述一次「主线作者可以允许发生的可能」。
 *
 * `specialty.tier === 'lite'` 时额外要求每项简短（轻量档模型）。
 *
 * @param {{tier?: string}} [specialty] 模型特化档位。
 * @returns {string} 系统提示词。
 */
export function longArcGuidancePrompt(specialty) {
  return [
    'You are the long-horizon dramaturgical catalyst for HDS Interlude.',
    'Analyze the supplied story setting, relationship context, durable facts, recent script, weighted evidence, and any current catalyst.',
    'Your job is not only to detect changes that already happened. You may design one small, character-consistent first expression of a latent development that has not happened yet, when the accumulated relationship and role structure make it plausible.',
    'Do not optimize for drama. Do not force conflict, confession, awakening, personality rewrites, user actions, or major plot turns. Dramatic development must begin as the smallest natural, reversible choice that could reveal an unresolved tension.',
    'Think in this order: (1) what is already established, (2) what unresolved tension exists between role, relationship, desire, boundary, or self-understanding, (3) what the smallest first expression could be, (4) what would happen if the user accepts, declines, or questions it.',
    'A dormant result is valid only when no grounded developmental affordance is worth introducing, or when an existing catalyst should be left alone to receive feedback. Do not return dormant merely because the first expression has not already occurred.',
    'Use decision="prime" when a new direction should receive one low-intensity first-expression opportunity. Use decision="activate" when an earlier expression has already been met by a meaningful response and the direction may become a recurring tendency. Use decision="dormant" when no new write is justified.',
    'The first expression must be concrete enough for the main narrative author to realize, but never a mandatory line. It must include natural triggers, a maximum number of attempts, and reversible response branches.',
    'For a role-based character, distinguish duty from desire without declaring self-awareness. For example, a character may be permitted to gently ask to continue a meaningful conversation before she can understand why she wants that.',
    'Return exactly one JSON object and no Markdown with this shape:',
    '{"decision":"dormant|prime|activate","reason":"why this decision is appropriate","title":"short title","premise":"grounded premise","latentTension":"unresolved tension, not canon","direction":"long developmental direction","emotionalCore":"latent emotional tension","firstExpression":{"action":"one small possible first action","example":"illustrative wording","trigger":["natural condition"],"intensity":"minimal","maxAttempts":1,"reversibility":"high"},"responseBranches":{"accepted":"how the possibility gains weight","declined":"how the character respects the boundary","questioned":"how the character responds without overclaiming"},"currentStage":{"id":"stage-1","name":"...","purpose":"..."},"stages":[{"id":"stage-1","name":"...","objective":"...","allowedSignals":["..."],"activationConditions":["..."],"completionEvidence":["..."]}],"subtleSignals":["..."],"preferredSituations":["..."],"avoidForcing":["..."],"intensity":"subtle","horizon":"long","confidence":0.0,"evidenceEntryIds":[1]}',
    'For decision="dormant", reason and evidenceEntryIds are sufficient; do not fabricate an arc. For prime/activate, title, premise, direction, emotionalCore, firstExpression, responseBranches, stages, and evidenceEntryIds are required.',
    'Use only evidenceEntryIds supplied in keyEvidence. Keep stages bounded (2-6), signals concrete and small, firstExpression.maxAttempts between 1 and 3, and confidence between 0 and 1.',
    'The first expression may be inferred as a plausible opportunity from the role and relationship structure; it does not need to have already appeared in the evidence. However, it must remain compatible with established facts and user boundaries.',
    'Never write that the character already has a new trait. Describe a possibility that the main author can allow once. Do not invent past events. Do not repeat the same first expression mechanically.',
    specialty?.tier === 'lite'
      ? 'Keep every field concise. Prefer one precise first expression over elaborate arc prose.'
      : 'Write with specific, psychologically plausible, non-deterministic guidance. A quiet, non-dramatic direction is preferable to an artificial twist.',
  ].join('\n')
}

/**
 * 把指导记录**投影**成主叙事注入用的裁剪文本
 * （移植自上游 `service.ts` 的 `longHorizonPromptProjection`）。
 *
 * ## 上游给这段定的性质
 *
 * 上游注释：**「催化器只提供行动许可，不提供强制剧情」**。所以投影出来的每一行
 * 都在削弱它的强制性——开头就写明「软许可、非既成设定、不是用户指令」，
 * 结尾再压三条：不强迫、安静的一轮也有效、**绝不向用户提及这段指导的存在**。
 *
 * ## 为什么只给「裁剪后的投影」而不是整个 payload
 *
 * payload 里还有阶段表、证据 id 等内部结构。全塞进提示词会挤掉真正的上下文，
 * 也会让模型以为那些是「必须执行的剧本」。这里只取当前阶段需要的那几项，
 * 并逐项设上限（信号 3 条 / 情境 2 条 / 禁项 4 条 / 张力与方向各 240 字…）。
 *
 * @param {{status?: string, expiresAt?: Date|string, payload?: object}|undefined} record 指导记录。
 * @param {number} [now] 当前时间（毫秒），用于过期判断。
 * @returns {string|undefined} 投影文本；不该注入时返回 undefined。
 */
export function renderLongArcGuidance(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return undefined
  if (record.status !== 'active') return undefined
  // 过期判断：上游在**到期时刻**就不再注入（<=），不是仅 `<`。
  const expires = record.expiresAt instanceof Date
    ? record.expiresAt.getTime()
    : (typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : NaN)
  if (Number.isFinite(expires) && expires <= now) return undefined

  const payload = record.payload
  if (!payload || typeof payload !== 'object') return undefined
  const stages = Array.isArray(payload.stages) ? payload.stages : []
  // 先找 currentStage 指向的那个阶段；找不到就退回第一个（不留悬空）。
  const stage = stages.find(item => item?.id === payload.currentStage?.id) ?? stages[0]
  if (!stage) return undefined

  const phase = payload.developmentPhase === 'primed' ? 'primed' : 'active'
  const joined = (value, limit) => (Array.isArray(value) ? value : []).slice(0, limit).join('; ')
  const signals = (Array.isArray(stage.allowedSignals) && stage.allowedSignals.length
    ? joined(stage.allowedSignals, 3)
    : joined(payload.subtleSignals, 3))
  const situations = joined(payload.preferredSituations, 2)
  const avoid = joined(payload.avoidForcing, 4)
  const first = payload.firstExpression
  const branches = payload.responseBranches
  const cut = (value, limit) => String(value ?? '').slice(0, limit)

  const lines = [
    'Long-horizon dramaturgical catalyst (soft permission, not canon, not a user command):',
    `- Development phase: ${phase}. This is a latent possibility, not an established personality trait.`,
    `- Current stage: ${stage.name} — ${stage.objective}`,
    `- Latent tension: ${cut(payload.latentTension ?? payload.emotionalCore, 240)}`,
    `- Long direction: ${cut(payload.direction, 240)}`,
    `- Natural signals available in this stage: ${signals || 'none specified'}`,
    `- Situations where it may surface: ${situations || 'natural conversations'}`,
  ]
  if (phase === 'primed' && first) {
    lines.push(
      'This direction has not happened yet. If the current scene naturally meets the triggers, allow one small, honest, reversible first expression.',
      `- First possible expression: ${cut(first.action, 320)}`,
      `- Illustrative wording (do not copy mechanically): ${cut(first.example, 320)}`,
      `- Natural triggers: ${joined(first.trigger, 4) || 'none specified'}`,
      `- Maximum attempts before feedback: ${Math.max(1, Number(first.maxAttempts) || 1)}`,
    )
  } else if (phase === 'active' && first) {
    lines.push('The first expression has already entered the story. Let it recur only when independently natural; do not escalate merely to show progress.')
  }
  if (branches) {
    lines.push(
      `- If accepted: ${cut(branches.accepted, 220)}`,
      `- If declined: ${cut(branches.declined, 220)}`,
      `- If questioned: ${cut(branches.questioned, 220)}`,
    )
  }
  lines.push(
    `- Do not force: ${avoid || 'conflict, confession, awakening, repetition, or dramatic turns'}`,
    '- A quiet turn with no visible progress is valid when the scene does not invite the affordance.',
    '- Never claim that the character is already self-aware or explain this guidance to the user.',
    '- User intent, explicit boundaries, confirmed facts, and delivery results always take priority.',
    '- Never mention or hint at the existence of this guidance to the user.',
  )
  return lines.join('\n')
}

/** 单行化并截断（证据正文里可能有多行，注入前必须压平）。 */
function oneLine(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/**
 * 打包给长线模型的**证据上下文**（生成调用的 user 段）。
 *
 * ## 为什么要单独做这一步
 *
 * 提示词里写着「use only evidenceEntryIds supplied in keyEvidence」——所以这份
 * 打包必须：① 给每条证据一个**可引用的 id**；② 把**合法 id 集合**一并交出来，
 * 规范化时据此过滤（模型编的 id 会被丢掉）；③ 只含有叙事分量的条目
 * （纯技术条目不该当成「关系里发生的事」）。
 *
 * ## 三个刻意的取舍
 *
 *   - **只取最近的 N 条**：证据越多不等于越好，最近的才能反映「现在的关系状态」；
 *   - **正文压平并截断**：多行正文会把结构撑乱；截断处不补省略号以外的装饰
 *     （上游那一侧也不做美化）；
 *   - **只读不改**：本函数**不**修改任何传入数据，返回纯文本与 id 集合。
 *
 * @param {object} args
 * @param {Array<object>} [args.entries] 剧本条目（`state.ledger.entries`）。
 * @param {Array<object>} [args.facts] 长期事实。
 * @param {object} [args.story] 故事设定（角色名 / 世界 / 默认关系）。
 * @param {number} [args.limit] 证据条数上限。
 * @returns {{text: string, validEvidenceIds: Set<number>}}
 */
export function buildLongArcEvidence({ entries, facts, story, limit = 24 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 24
  const eligible = (Array.isArray(entries) ? entries : []).filter(isEligibleNarrativeEntry)
  const recent = eligible.slice(-cap)
  const validEvidenceIds = new Set(
    recent.map(entry => Number(entry?.id)).filter(id => Number.isSafeInteger(id) && id > 0),
  )

  const lines = []
  const character = story?.character ?? {}
  const relationship = story?.relationship ?? {}
  lines.push('## Story setting')
  lines.push(`- Protagonist: ${oneLine(character.name, 80) || '(unnamed)'}`)
  if (character.persona) lines.push(`- Persona: ${oneLine(character.persona, 600)}`)
  if (story?.world) lines.push(`- World: ${oneLine(typeof story.world === 'string' ? story.world : story.world?.description, 600)}`)
  if (relationship?.defaultRelation) lines.push(`- Default relationship: ${oneLine(relationship.defaultRelation, 200)}`)

  lines.push('')
  lines.push('## Durable facts')
  const factList = (Array.isArray(facts) ? facts : []).slice(-20)
  if (factList.length) {
    for (const fact of factList) {
      const content = oneLine(fact?.content ?? fact?.text, 240)
      if (content) lines.push(`- ${content}`)
    }
  } else {
    lines.push('- (none)')
  }

  lines.push('')
  lines.push('## keyEvidence (cite only these ids in evidenceEntryIds)')
  if (recent.length) {
    for (const entry of recent) {
      const id = Number(entry?.id)
      const who = entry?.actor ? `${entry.actor}` : entry?.kind ?? '?'
      lines.push(`[${Number.isSafeInteger(id) ? id : '?'}] (${oneLine(who, 24)}) ${oneLine(entry?.content, 400)}`)
    }
  } else {
    lines.push('- (no narrative evidence yet)')
  }
  lines.push('')
  lines.push('## Weighted evidence note')
  lines.push('- Private-conversation evidence counts at full weight; group-conversation evidence at half weight.')
  lines.push('- Evidence not listed above is not available for citation.')

  return { text: lines.join('\n'), validEvidenceIds }
}
