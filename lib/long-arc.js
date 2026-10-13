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
