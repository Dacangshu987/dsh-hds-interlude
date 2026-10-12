/**
 * Alter System（情绪偏移追踪）—— 忠实移植自 hds-interlude 的 src/alter.ts。
 *
 * 原模块职责：Alter 状态规范化、纯状态转移、动态阈值、权重与提示词投影。
 * 完全无副作用、无平台依赖，仅做状态机与投影，因此可逐行移植。
 *
 * @module dsh-hds-interlude/alter
 */

const HOUR = 60 * 60 * 1000
const HISTORY_LIMIT = 50

/** 叙事四阶段（与原项目 NarrativePhase 一致）。 */
export const NARRATIVE_PHASES = ['advance', 'conversation-follow-up', 'user-message', 'intent-due']

export const DEFAULT_ALTER_SYSTEM_CONFIG = {
  enabled: false,
  baseThreshold: 10,
  densityFactor: 0.3,
  sameDirectionBoost: 0.05,
  oppositeDecay: 0.15,
  minWeight: 0.2,
  maxIntensity: 2,
  modelId: '',
  providerId: '',
  model: '',
  temperature: 0.3,
  topP: 1,
  maxTokens: 400,
  timeout: 30_000,
  prompt: '',
}

export function resolveAlterSystemConfig(value) {
  return { ...DEFAULT_ALTER_SYSTEM_CONFIG, ...value }
}

/** 把任意输入规整为 -5..+5 的整数；非法输入返回 undefined。 */
export function normalizeAlterValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(-5, Math.min(5, Math.round(value)))
}

export function createAlterSystemState(now = new Date()) {
  return {
    alterValue: 0,
    alterWeight: 0,
    lastTriggerDirection: 0,
    emotionalOffset: null,
    history: [],
    lastUpdatedAt: now.toISOString(),
  }
}

export function normalizeAlterSystemState(value) {
  if (!isRecord(value)) return undefined
  const history = Array.isArray(value.history)
    ? value.history.filter(isRecord).map((entry, index) => ({
      turn: Math.max(1, Math.floor(finiteNumber(entry.turn, index + 1))),
      phase: normalizePhase(entry.phase),
      alter: normalizeAlterValue(entry.alter) ?? 0,
      alterValue: clamp(finiteNumber(entry.alterValue, 0), -1_000, 1_000),
      timestamp: normalizedIso(entry.timestamp) ?? new Date(0).toISOString(),
    })).slice(-HISTORY_LIMIT)
    : []
  const emotionalOffset = isRecord(value.emotionalOffset) && typeof value.emotionalOffset.description === 'string'
    ? {
      direction: value.emotionalOffset.direction === 'relaxed' ? 'relaxed' : 'serious',
      description: value.emotionalOffset.description.trim().slice(0, 800),
      intensity: clamp(finiteNumber(value.emotionalOffset.intensity, 1), 0, 3),
      generatedAt: normalizedIso(value.emotionalOffset.generatedAt) ?? new Date(0).toISOString(),
    }
    : null
  const legacyDirection = Math.sign(finiteNumber(value.lastTriggerAlter, 0))
  const direction = Math.sign(finiteNumber(value.lastTriggerDirection, legacyDirection))
  return {
    alterValue: clamp(finiteNumber(value.alterValue, 0), -1_000, 1_000),
    alterWeight: clamp(finiteNumber(value.alterWeight, 0), 0, 1),
    lastTriggerDirection: direction,
    emotionalOffset,
    history,
    lastUpdatedAt: normalizedIso(value.lastUpdatedAt) ?? new Date(0).toISOString(),
    lastAnalysisAttemptAt: normalizedIso(value.lastAnalysisAttemptAt),
  }
}

/** 动态阈值：最近一小时叙事越密集，阈值越低（最低不低于基础阈值一半）。 */
export function calculateAlterThreshold(history, config, now = new Date()) {
  const oneHourAgo = now.getTime() - HOUR
  const turns = history.filter(entry => (dateValue(entry.timestamp)?.getTime() ?? 0) >= oneHourAgo).length
  const density = Math.min(turns / 10, 1)
  const base = Math.max(1, finiteNumber(config.baseThreshold, 10))
  const factor = clamp(finiteNumber(config.densityFactor, 0.3), 0, 1)
  return Math.max(base * 0.5, base * (1 - density * factor))
}

export function adjustAlterWeight(weight, sameDirection, magnitude, config) {
  const rate = sameDirection ? config.sameDirectionBoost : -config.oppositeDecay
  return clamp(weight + Math.max(0, magnitude) * finiteNumber(rate, 0), 0, 1)
}

export function advanceAlterSystem(current, alter, phase, now, config) {
  const state = current
    ? { ...current, history: [...current.history] }
    : createAlterSystemState(now)
  state.alterValue = clamp(state.alterValue + alter, -1_000, 1_000)
  const direction = Math.sign(alter)
  let offsetExpired = false
  if (state.emotionalOffset && direction) {
    state.alterWeight = adjustAlterWeight(
      state.alterWeight,
      direction === state.lastTriggerDirection,
      Math.abs(alter),
      config,
    )
    if (state.alterWeight < config.minWeight) {
      state.emotionalOffset = null
      state.alterWeight = 0
      offsetExpired = true
    }
  }
  state.history.push({
    turn: (state.history.at(-1)?.turn ?? 0) + 1,
    phase,
    alter,
    alterValue: state.alterValue,
    timestamp: now.toISOString(),
  })
  state.history = state.history.slice(-HISTORY_LIMIT)
  state.lastUpdatedAt = now.toISOString()
  const threshold = calculateAlterThreshold(state.history, config, now)
  return { state, threshold, offsetExpired, thresholdReached: Math.abs(state.alterValue) >= threshold }
}

/**
 * 用一次分析结果生成情绪底色（移植自上游 `1.0.1-rc50` 的消费语义修订）。
 *
 * ## 上游修的是什么
 *
 * 上游的分析要**异步**跑一趟侧端模型：触发时先记下当时的累计值（快照），
 * 模型回来看的是那份快照。而分析期间用户还在说话、`advanceAlterSystem` 还在
 * 累加——旧实现回来时无条件 `alterValue = 0`，**把分析没看过的新分数一起吞了**。
 *
 * 修订后：只消费「本次分析所依据的那份值」（`analyzedValue`），剩下的留着；
 * 并且应用前复核一次——若期间累计已反向或跌回阈值之下，说明这份分析已经过期，
 * 整个丢弃、一分不消费（`clearAlterScopeAnalysisAttempt` 让该 scope 可再次被审）。
 *
 * ## 本仓的形态差异（如实说明）
 *
 * 本仓的底色是**同步**产生的（`interlude_alter` 的 `note` 直接就是底色描述，
 * 没有侧端模型往返），所以「分析期间新累积分数」在结构上不可能发生。
 * 这里仍按上游形态实现，原因有二：
 *   ① 只消费快照、不整片清零，是更精确的**契约**——同步路径下两者结果相同
 *      （`analyzedValue` 缺省即当前值），一旦将来接入异步分析就不必再改；
 *   ② 过期复核 + 「没消费就不占冷却」把边界写进了函数，而不是靠调用方自觉。
 *
 * @param {object} state Alter 状态。
 * @param {string} description 底色描述（模型给的 note 或默认句）。
 * @param {number} threshold 本次触发的阈值。
 * @param {Date} now 当前时刻。
 * @param {object} config Alter 配置。
 * @param {number} [analyzedValue] 本次分析所依据的快照值；缺省 = 消费当前全部。
 * @returns {object} 新状态；**过期或零值时不消费，原样返回同一对象引用**
 *   （调用方据此判断这次分析到底有没有生效——见 `alterAnalysisApplied`）。
 */
export function completeAlterAnalysis(state, description, threshold, now, config, analyzedValue) {
  const snapshot = Number.isFinite(analyzedValue) ? analyzedValue : state.alterValue
  // 没有可分析的变化：不要凭空造一个方向为 0 的底色（旧实现会把 0 判成 relaxed）。
  if (!Number.isFinite(snapshot) || !snapshot) return state
  // 过期复核（上游 rc50）：这份分析看的快照与当前累计已经对不上——
  // 反向了，或跌回阈值之下 → 丢弃结果，**一分都不消费**。
  if (analyzedValue !== undefined
    && (Math.sign(state.alterValue) !== Math.sign(snapshot) || Math.abs(state.alterValue) < threshold)) {
    return state
  }
  const direction = Math.sign(snapshot)
  return {
    ...state,
    // 只扣掉被消费的那份；分析期间新累积的部分留在账上（上游 rc50）。
    alterValue: clamp(state.alterValue - snapshot, -1_000, 1_000),
    alterWeight: 1,
    lastTriggerDirection: direction,
    emotionalOffset: {
      direction: direction > 0 ? 'serious' : 'relaxed',
      description: description.trim().slice(0, 800),
      intensity: Math.min(Math.abs(snapshot) / Math.max(1, threshold), config.maxIntensity),
      generatedAt: now.toISOString(),
    },
    lastUpdatedAt: now.toISOString(),
  }
}

/**
 * 这次分析是否真的生效了（有没有消费掉分数）。
 *
 * `completeAlterAnalysis` 在过期/零值时**原样返回同一个对象**，所以引用比较即可
 * 判断。为什么要判：分析没生效时不该记冷却——否则一次过期结果会把该会话锁住
 * 五分钟，期间新分数攒够也审不了（上游 `clearAlterScopeAnalysisAttempt` 的
 * 本仓等价物）。
 *
 * @param {object} before 调用前的 Alter 状态。
 * @param {object} after 调用后的 Alter 状态。
 * @returns {boolean}
 */
export function alterAnalysisApplied(before, after) {
  return before !== after
}

export function emotionalOffsetForPrompt(state, config) {
  if (!config.enabled || !state?.emotionalOffset || state.alterWeight < config.minWeight) return null
  return { ...state.emotionalOffset, weight: state.alterWeight }
}

export function alterAnalysisCoolingDown(state, now = new Date(), cooldownMs = 5 * 60 * 1000) {
  const lastAttempt = dateValue(state.lastAnalysisAttemptAt)
  return !!lastAttempt && now.getTime() - lastAttempt.getTime() < cooldownMs
}

function normalizePhase(value) {
  return NARRATIVE_PHASES.includes(String(value)) ? value : 'user-message'
}

function normalizedIso(value) {
  return dateValue(value)?.toISOString()
}

function dateValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
